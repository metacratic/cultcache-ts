import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { decode, encode } from "@msgpack/msgpack";
import { z } from "zod";

import type { CacheBackingStore, CultCacheEnvelope, PushAllOptions } from "./types";

const envelopeSchema = z.object({
  key: z.string().min(1),
  type: z.string().min(1),
  payload: z.instanceof(Uint8Array),
  storedAt: z.string().min(1),
});

const envelopeArraySchema = z.array(envelopeSchema);

export class SingleFileMessagePackBackingStore implements CacheBackingStore {
  readonly filePath: string;

  #writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  async pullAll(): Promise<CultCacheEnvelope[]> {
    try {
      const data = await readFile(this.filePath);
      return envelopeArraySchema.parse(decode(data)) as CultCacheEnvelope[];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  async push(entry: CultCacheEnvelope): Promise<void> {
    await this.#enqueue(async () => {
      const existing = await this.pullAll();
      const filtered = existing.filter(
        (candidate) => !(candidate.type === entry.type && candidate.key === entry.key),
      );
      filtered.push(entry);
      await this.#writeAll(filtered);
    });
  }

  async delete(entry: CultCacheEnvelope): Promise<void> {
    await this.#enqueue(async () => {
      const existing = await this.pullAll();
      const filtered = existing.filter(
        (candidate) => !(candidate.type === entry.type && candidate.key === entry.key),
      );
      await this.#writeAll(filtered);
    });
  }

  async pushAll(entries: CultCacheEnvelope[], options: PushAllOptions = {}): Promise<void> {
    await this.#enqueue(async () => {
      if (options.soft) {
        try {
          await readFile(this.filePath);
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") {
            throw error;
          }
        }
      }

      await this.#writeAll(entries);
    });
  }

  async #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    let result!: T;

    const next = this.#writeQueue.then(async () => {
      result = await operation();
    });

    this.#writeQueue = next.then(
      () => undefined,
      () => undefined,
    );

    await next;
    return result;
  }

  async #writeAll(entries: CultCacheEnvelope[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });

    const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;

    try {
      await writeFile(tempPath, encode(entries));
      await rename(tempPath, this.filePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
