import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CodebaseService } from "../../src/app.js";
import { MetadataRepository } from "../../src/repository.js";
import type { EmbeddingLike, EmbeddingResult, ServiceConfig } from "../../src/types.js";
import { FakeStore } from "../fake-store.js";

export class FakeEmbedding implements EmbeddingLike {
  private rejectedText: string | undefined;
  private pause?: {
    text: string;
    entered: () => void;
    wait: Promise<void>;
  };

  rejectTextContaining(text: string): void {
    this.rejectedText = text;
  }

  pauseTextContaining(text: string): { entered: Promise<void>; release: () => void } {
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pause = { text, entered: markEntered, wait };
    return { entered, release };
  }

  async embed(texts: string[]): Promise<EmbeddingResult[]> {
    if (this.rejectedText && texts.some((text) => text.includes(this.rejectedText!))) {
      throw new Error("controlled embedding failure");
    }
    if (this.pause && texts.some((text) => text.includes(this.pause!.text))) {
      this.pause.entered();
      await this.pause.wait;
      this.pause = undefined;
    }
    return texts.map((text) => {
      const digest = createHash("sha256").update(text).digest();
      const vector = [digest[0] / 255, digest[1] / 255, digest[2] / 255];
      return { vector, dimension: vector.length };
    });
  }

  async embedSingle(text: string): Promise<EmbeddingResult> {
    return (await this.embed([text]))[0];
  }
}

export interface ServiceFixture {
  root: string;
  service: CodebaseService;
  repository: MetadataRepository;
  store: FakeStore;
  embedding: FakeEmbedding;
  cleanup(): Promise<void>;
}

export async function createServiceFixture(
  options: { store?: FakeStore } = {},
): Promise<ServiceFixture> {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "codebase-mcp-service-"));
  const fixturePath = path.join(temporaryDirectory, "repo");
  await fs.mkdir(fixturePath);
  const root = await fs.realpath(fixturePath);

  const repository = MetadataRepository.open(path.join(temporaryDirectory, "metadata.sqlite"));
  const store = options.store ?? new FakeStore();
  const embedding = new FakeEmbedding();
  const config: ServiceConfig = {
    host: "127.0.0.1",
    port: 3000,
    localAuthToken: "test-token",
    allowedRoots: [temporaryDirectory],
    indexMaxConcurrency: 2,
  };
  const service = CodebaseService.create({ config, repository, store, embedding });

  return {
    root,
    service,
    repository,
    store,
    embedding,
    cleanup: () => fs.rm(temporaryDirectory, { recursive: true, force: true }),
  };
}

export async function writeFixtureFile(root: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

export async function waitForJob(service: CodebaseService, jobId: string): Promise<void> {
  const timeoutAt = Date.now() + 2_000;
  while (Date.now() < timeoutAt) {
    const status = await service.getStatus({ jobId });
    if (["completed", "failed", "cancelled", "interrupted"].includes(status.job!.state)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}
