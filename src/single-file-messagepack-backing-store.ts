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
const legacyEnvelopeArraySchema = z.array(
  z.object({
    key: z.string().min(1),
    type: z.string().min(1),
    payload: z.unknown(),
    storedAt: z.string().min(1),
  }),
);

export class SingleFileMessagePackBackingStore implements CacheBackingStore {
  readonly filePath: string;

  #writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  async pullAll(): Promise<CultCacheEnvelope[]> {
    try {
      const data = await readFile(this.filePath);
      const decoded = legacyEnvelopeArraySchema.parse(decode(data));
      let repairedLegacyPayload = false;
      const normalized = decoded.map((entry) => {
        const payload = normalizePayload(entry.payload);
        if (payload !== entry.payload) {
          repairedLegacyPayload = true;
        }

        return {
          ...entry,
          payload,
        };
      });
      const parsed = envelopeArraySchema.parse(normalized) as CultCacheEnvelope[];

      if (repairedLegacyPayload) {
        await this.#writeAll(parsed);
      }

      return parsed;
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

function normalizePayload(payload: unknown): Uint8Array {
  if (payload instanceof Uint8Array) {
    return payload;
  }

  if (
    isObject(payload) &&
    payload.type === "Buffer" &&
    Array.isArray(payload.data) &&
    payload.data.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
  ) {
    return Uint8Array.from(payload.data);
  }

  if (Array.isArray(payload) && payload.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
    return Uint8Array.from(payload);
  }

  return encode(payload);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
