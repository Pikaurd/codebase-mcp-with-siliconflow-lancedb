import OpenAI from "openai";
import type { EmbeddingResult } from "./types.js";

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_TIMEOUT_MS = 60_000;
const CLOUDFLARE_AI_RUN_PREFIX = "/ai/run/";

function isRetryable(err: unknown): boolean {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    // Rate limit
    if (e.status === 429) return true;
    // Server errors
    if (typeof e.status === "number" && e.status >= 500) return true;
    // Network errors (no status)
    if (e.status === undefined && (e.code !== undefined || e.name === "TimeoutError" || e.name === "APIConnectionTimeoutError")) return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wrapped error so its shape matches what catch() and isRetryable expect. */
class EmbeddingHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "EmbeddingHttpError";
    this.status = status;
  }
}

/**
 * Whether the configured base URL points to Cloudflare's /ai/run/ (native
 * Workers AI) endpoint. When true, we bypass the OpenAI SDK and call the
 * native API directly.
 */
function isCloudflareNative(): boolean {
  return (process.env.OPENAI_BASE_URL ?? "").includes(CLOUDFLARE_AI_RUN_PREFIX);
}

export class EmbeddingProvider {
  private client: OpenAI;
  private model: string;
  private _dimension: number | null = null;
  private baseUrl: string;
  private apiKey: string;
  private cloudflareNative: boolean;

  constructor() {
    this.model = process.env.EMBEDDING_MODEL || "BAAI/bge-m3";
    this.baseUrl = process.env.OPENAI_BASE_URL || "https://api.siliconflow.cn/v1";
    this.apiKey = process.env.OPENAI_API_KEY || "";
    this.cloudflareNative = isCloudflareNative();
    if (this.cloudflareNative) {
      // OpenAI SDK won't be used — satisfying constructor only.
      this.client = null as unknown as OpenAI;
    } else {
      const timeout = Number(process.env.EMBEDDING_TIMEOUT_MS) > 0
        ? Number(process.env.EMBEDDING_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
      this.client = new OpenAI({
        apiKey: this.apiKey,
        baseURL: this.baseUrl,
        timeout,
      });
    }
  }

  async embed(texts: string[]): Promise<EmbeddingResult[]> {
    if (texts.length === 0) return [];
    const cleaned = texts.map((t) => (t.trim() === "" ? " " : t));
    const configuredBatch = Number(process.env.EMBEDDING_BATCH_SIZE);
    const batchSize = configuredBatch > 0 ? Math.floor(configuredBatch) : DEFAULT_BATCH_SIZE;
    const all: EmbeddingResult[] = [];
    for (let offset = 0; offset < cleaned.length; offset += batchSize) {
      const batch = cleaned.slice(offset, offset + batchSize);
      all.push(...await this.embedBatch(batch));
    }
    return all;
  }

  private async embedBatch(cleaned: string[]): Promise<EmbeddingResult[]> {
    if (this.cloudflareNative) {
      return this.cloudflareEmbedBatch(cleaned);
    }
    return this.openaiEmbedBatch(cleaned);
  }

  /** OpenAI-compatible (OpenAI, SiliconFlow, Cloudflare compat, etc). */
  private async openaiEmbedBatch(cleaned: string[]): Promise<EmbeddingResult[]> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await this.client.embeddings.create({
          model: this.model,
          input: cleaned,
          encoding_format: "float",
        });
        const results = resp.data.map((d) => ({
          vector: d.embedding as number[],
          dimension: d.embedding.length,
        }));
        if (this._dimension === null && results.length > 0) {
          this._dimension = results[0].dimension;
        }
        if (results.length !== cleaned.length) throw new Error("Embedding provider returned an unexpected result count");
        return results;
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES && isRetryable(err)) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
          console.error(
            `[embedding] attempt ${attempt + 1}/${MAX_RETRIES + 1} failed, retrying in ${delay}ms: ${err instanceof Error ? err.message : String(err)}`
          );
          await sleep(delay);
        } else {
          break;
        }
      }
    }
    throw lastError;
  }

  /** Cloudflare Workers AI native /ai/run/ endpoint. */
  private async cloudflareEmbedBatch(cleaned: string[]): Promise<EmbeddingResult[]> {
    let lastError: unknown;
    const url = `${this.baseUrl}${this.model}`;
    const timeoutMs = Number(process.env.EMBEDDING_TIMEOUT_MS) > 0
      ? Number(process.env.EMBEDDING_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const resp = await fetch(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ text: cleaned }),
            signal: controller.signal,
          });
          if (!resp.ok) {
            const body = await resp.text().catch(() => "");
            throw new EmbeddingHttpError(resp.status, `${resp.status}${body ? `: ${body.slice(0,200)}` : " status code (no body)"}`);
          }
          const json = (await resp.json()) as {
            result?: { data?: number[][] };
            errors?: Array<{ message?: string }>;
          };
          if (!json.result?.data) {
            throw new Error(json.errors?.[0]?.message ?? "empty Cloudflare response");
          }
          const results = json.result.data.map((vec) => ({
            vector: vec,
            dimension: vec.length,
          }));
          if (this._dimension === null && results.length > 0) {
            this._dimension = results[0].dimension;
          }
          if (results.length !== cleaned.length) {
            throw new Error("Cloudflare embedding returned an unexpected result count");
          }
          return results;
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        // Wrap AbortError / timeout
        if (err instanceof DOMException && err.name === "AbortError") {
          lastError = new EmbeddingHttpError(408, "Request timed out");
        } else {
          lastError = err;
        }
        if (attempt < MAX_RETRIES && isRetryable(lastError)) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
          console.error(
            `[embedding] attempt ${attempt + 1}/${MAX_RETRIES + 1} failed, retrying in ${delay}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`
          );
          await sleep(delay);
        } else {
          break;
        }
      }
    }
    throw lastError;
  }

  async embedSingle(text: string): Promise<EmbeddingResult> {
    const results = await this.embed([text]);
    return results[0];
  }

  async detectDimension(): Promise<number> {
    if (this._dimension !== null) return this._dimension;
    const result = await this.embedSingle("dimension test");
    this._dimension = result.dimension;
    return this._dimension;
  }

  get dimension(): number | null {
    return this._dimension;
  }

  get provider(): string {
    return this.cloudflareNative ? "Cloudflare Workers AI" : "OpenAI";
  }
}
