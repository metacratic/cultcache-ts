import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { decode, encode } from "@msgpack/msgpack";
import { z } from "zod";

import { CultCache } from "../src/cult-cache";
import { defineDocumentRegistry, defineDocumentType } from "../src/document";
import { SingleFileMessagePackBackingStore } from "../src/single-file-messagepack-backing-store";
import type { CacheBackingStore, CultCacheEnvelope, CultCacheSchema } from "../src/types";

test("CultCache supports registry bootstrap, global documents, and lookup by name and index", async () => {
  const itemDocument = defineDocumentType({
    type: "item",
    schema: z.object({
      name: z.string(),
      category: z.string(),
      value: z.number().int(),
    }),
    name: "name",
    indexes: {
      category: "category",
    },
  });

  const settingsDocument = defineDocumentType({
    type: "settings",
    schema: z.object({
      theme: z.string(),
      retries: z.number().int().nonnegative(),
    }),
    global: true,
  });

  const storePath = join(await mkdtemp(join(tmpdir(), "cultcache-ts-")), "cache.msgpack");
  const registry = defineDocumentRegistry(itemDocument, settingsDocument);

  const cache = CultCache.builder()
    .withRegistry(registry)
    .withGenericStore(new SingleFileMessagePackBackingStore(storePath))
    .build();

  await cache.put(itemDocument, "item:potion", {
    name: "Potion",
    category: "Consumable",
    value: 50,
  });
  await cache.putGlobal(settingsDocument, {
    theme: "ash",
    retries: 3,
  });

  assert.deepEqual(cache.getByName(itemDocument, "Potion"), {
    name: "Potion",
    category: "Consumable",
    value: 50,
  });
  assert.equal(cache.getKeyByIndex(itemDocument, "category", "Consumable"), "item:potion");
  assert.deepEqual(cache.getGlobal(settingsDocument), {
    theme: "ash",
    retries: 3,
  });

  const snapshot = cache.snapshot();
  assert.equal(snapshot.length, 2);
  assert.ok(snapshot.every((entry) => entry.payload instanceof Uint8Array && entry.payload.length > 0));

  const reloaded = CultCache.builder()
    .withRegistry(registry)
    .withGenericStore(new SingleFileMessagePackBackingStore(storePath))
    .build();
  await reloaded.pullAllBackingStores();

  assert.deepEqual(reloaded.getByName(itemDocument, "Potion"), {
    name: "Potion",
    category: "Consumable",
    value: 50,
  });
  assert.deepEqual(reloaded.getRequiredGlobal(settingsDocument), {
    theme: "ash",
    retries: 3,
  });
});

test("CultCache can register name and index lookups after entries already exist", async () => {
  const noteDocument = defineDocumentType({
    type: "note",
    schema: z.object({
      title: z.string(),
      author: z.string(),
      body: z.string(),
    }),
  });

  const storePath = join(await mkdtemp(join(tmpdir(), "cultcache-ts-")), "cache.msgpack");
  const cache = CultCache.builder()
    .withDocumentType(noteDocument)
    .withGenericStore(new SingleFileMessagePackBackingStore(storePath))
    .build();

  await cache.put(noteDocument, "note:hello", {
    title: "Hello",
    author: "ari",
    body: "world",
  });

  cache.registerNameLookup(noteDocument, "title");
  cache.registerIndex(noteDocument, "author", "author");

  assert.equal(cache.getIdByName(noteDocument, "Hello"), "note:hello");
  assert.equal(cache.getIdByIndex(noteDocument, "author", "ari"), "note:hello");
});

test("CultCache fails closed on unknown or illegal persisted polymorphic state", async () => {
  const settingsDocument = defineDocumentType({
    type: "settings",
    schema: z.object({
      theme: z.string(),
    }),
    global: true,
  });

  class InMemoryStore implements CacheBackingStore {
    constructor(private readonly entries: CultCacheEnvelope[]) {}

    async pullAll(): Promise<CultCacheEnvelope[]> {
      return this.entries;
    }

    async push(): Promise<void> {
      throw new Error("not used");
    }

    async delete(): Promise<void> {
      throw new Error("not used");
    }
  }

  const cacheWithUnknownType = CultCache.builder()
    .withDocumentType(settingsDocument)
    .withGenericStore(new InMemoryStore([
      {
        key: "mystery",
        type: "forbidden",
        payload: encode({ theme: "ash" }),
        storedAt: new Date().toISOString(),
      },
    ]))
    .build();

  await assert.rejects(
    async () => cacheWithUnknownType.pullAllBackingStores(),
    /No schema is registered for persisted document type "forbidden"\./,
  );

  const cacheWithDuplicateGlobal = CultCache.builder()
    .withDocumentType(settingsDocument)
    .withGenericStore(new InMemoryStore([
      {
        key: "one",
        type: "settings",
        payload: encode({ theme: "ash" }),
        storedAt: new Date().toISOString(),
      },
      {
        key: "two",
        type: "settings",
        payload: encode({ theme: "ember" }),
        storedAt: new Date().toISOString(),
      },
    ]))
    .build();

  await assert.rejects(
    async () => cacheWithDuplicateGlobal.pullAllBackingStores(),
    /has multiple persisted entries/,
  );
});

test("CultCache accepts generated parse-style schemas without a Zod mirror", async () => {
  type GeneratedSettings = {
    schema_version: "generated.settings.v0";
    theme: string;
    retries: number;
  };

  const generatedSchema: CultCacheSchema<GeneratedSettings> = {
    parse(input: unknown): GeneratedSettings {
      if (!input || typeof input !== "object") {
        throw new Error("generated settings must be an object");
      }

      const value = input as Record<string, unknown>;
      if (value.schema_version !== "generated.settings.v0") {
        throw new Error("generated settings schema_version mismatch");
      }
      if (typeof value.theme !== "string") {
        throw new Error("generated settings theme must be a string");
      }
      if (typeof value.retries !== "number") {
        throw new Error("generated settings retries must be a number");
      }

      return {
        schema_version: "generated.settings.v0",
        theme: value.theme,
        retries: value.retries,
      };
    },
  };

  const generatedDocument = defineDocumentType({
    type: "generated-settings",
    schema: generatedSchema,
    global: true,
  });

  const storePath = join(await mkdtemp(join(tmpdir(), "cultcache-ts-")), "generated.msgpack");
  const cache = CultCache.builder()
    .withDocumentType(generatedDocument)
    .withGenericStore(new SingleFileMessagePackBackingStore(storePath))
    .build();

  await cache.putGlobal(generatedDocument, {
    schema_version: "generated.settings.v0",
    theme: "ash",
    retries: 3,
  });

  const settings = cache.getRequiredGlobal(generatedDocument);
  assert.equal(settings.schema_version, "generated.settings.v0");
  assert.equal(settings.theme, "ash");
  assert.equal(settings.retries, 3);
});

test("CultCache can ingest raw envelopes without re-encoding the payload", async () => {
  const noteDocument = defineDocumentType({
    type: "note",
    schema: z.object({
      title: z.string(),
      body: z.string(),
    }),
  });

  const storePath = join(await mkdtemp(join(tmpdir(), "cultcache-ts-")), "cache.msgpack");
  const origin = CultCache.builder()
    .withDocumentType(noteDocument)
    .withGenericStore(new SingleFileMessagePackBackingStore(storePath))
    .build();
  const target = CultCache.builder()
    .withDocumentType(noteDocument)
    .withGenericStore(new SingleFileMessagePackBackingStore(join(await mkdtemp(join(tmpdir(), "cultcache-ts-")), "target.msgpack")))
    .build();

  await origin.put(noteDocument, "note:hello", {
    title: "Hello",
    body: "world",
  });

  const envelope = origin.getRequiredEnvelope(noteDocument, "note:hello");
  const applied = await target.putEnvelope(noteDocument, envelope);

  assert.deepEqual(applied, {
    title: "Hello",
    body: "world",
  });
  assert.deepEqual(target.getRequired(noteDocument, "note:hello"), applied);
  assert.deepEqual(target.getRequiredEnvelope(noteDocument, "note:hello").payload, envelope.payload);
});

test("SingleFileMessagePackBackingStore heals legacy envelopes whose payload was persisted as an object", async () => {
  const noteDocument = defineDocumentType({
    type: "note",
    schema: z.object({
      title: z.string(),
      body: z.string(),
    }),
  });

  const storePath = join(await mkdtemp(join(tmpdir(), "cultcache-ts-")), "legacy.msgpack");
  const envelopePayload = {
    title: "Hello",
    body: "world",
  };

  await writeFile(
    storePath,
    encode([
      {
        key: "note:hello",
        type: "note",
        payload: envelopePayload,
        storedAt: new Date().toISOString(),
      },
    ]),
  );

  const cache = CultCache.builder()
    .withDocumentType(noteDocument)
    .withGenericStore(new SingleFileMessagePackBackingStore(storePath))
    .build();

  await cache.pullAllBackingStores();
  assert.deepEqual(cache.getRequired(noteDocument, "note:hello"), envelopePayload);

  const rewritten = decode(await readFile(storePath)) as Array<{ payload: unknown }>;
  assert.equal(rewritten.length, 1);
  assert.ok(rewritten[0]?.payload instanceof Uint8Array);
});
