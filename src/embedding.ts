import OpenAI from "openai";
import type { EmbeddingResult } from "./types.js";

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

function isRetryable(err: unknown): boolean {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    // Rate limit
    if (e.status === 429) return true;
    // Server errors
    if (typeof e.status === "number" && e.status >= 500) return true;
    // Network errors (no status)
    if (e.status === undefined && e.code !== undefined) return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class EmbeddingProvider {
  private client: OpenAI;
  private model: string;
  private _dimension: number | null = null;

  constructor() {
    this.model = process.env.EMBEDDING_MODEL || "BAAI/bge-m3";
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || "",
      baseURL: process.env.OPENAI_BASE_URL || "https://api.siliconflow.cn/v1",
    });
  }

  async embed(texts: string[]): Promise<EmbeddingResult[]> {
    const cleaned = texts.map((t) => (t.trim() === "" ? " " : t));

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
    return "OpenAI";
  }
}
