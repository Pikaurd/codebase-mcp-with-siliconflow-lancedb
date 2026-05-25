import OpenAI from "openai";
import type { EmbeddingResult } from "./types.js";

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
