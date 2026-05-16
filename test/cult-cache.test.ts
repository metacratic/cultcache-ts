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

test("SingleFileMessagePackBackingStore writes the CultCache v1 snapshot shape", async () => {
  const namedDocument = defineDocumentType({
    type: "tests.named_entry",
    schema: z.object({
      Name: z.string(),
      Value: z.string(),
    }),
    schemaId: "sha256:e7b97801b94190f3159012ede45b0069bb09ebf7920f7432c971bc86a0e08de8",
    schemaName: "tests.named_entry",
    schemaVersion: "tests.named_entry.v1",
    contentHash: "sha256:23150930afcc1d84f0cb3012ccc2debcb9b4685f62083033bbaab0083f1e832e",
    canonicalSchemaJson: "{\"schemaName\":\"tests.named_entry\",\"schemaVersion\":\"tests.named_entry.v1\",\"members\":[{\"slot\":0,\"name\":\"Name\",\"type\":\"System.String\",\"isReference\":false,\"many\":false,\"targetSchemaName\":null,\"indexAlias\":null,\"isName\":true},{\"slot\":1,\"name\":\"Value\",\"type\":\"System.String\",\"isReference\":false,\"many\":false,\"targetSchemaName\":null,\"indexAlias\":null,\"isName\":false}]}",
    members: [
      {
        slot: 0,
        memberName: "Name",
        typeName: "System.String",
        isName: true,
      },
      {
        slot: 1,
        memberName: "Value",
        typeName: "System.String",
      },
    ],
    name: "Name",
  });

  const storePath = join(await mkdtemp(join(tmpdir(), "cultcache-ts-")), "snapshot.msgpack");
  const cache = CultCache.builder()
    .withDocumentType(namedDocument)
    .withGenericStore(new SingleFileMessagePackBackingStore(storePath))
    .build();

  await cache.put(namedDocument, "record-1", {
    Name: "Teeth",
    Value: "slot-array",
  });

  const snapshot = decode(await readFile(storePath)) as unknown[];
  assert.equal(snapshot[0], "cultcache.store.v1");

  const catalog = snapshot[1] as unknown[][];
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0]?.[0], "sha256:e7b97801b94190f3159012ede45b0069bb09ebf7920f7432c971bc86a0e08de8");
  assert.equal(catalog[0]?.[1], "tests.named_entry");
  assert.equal(catalog[0]?.[2], "tests.named_entry.v1");

  const records = snapshot[2] as unknown[][];
  assert.equal(records.length, 1);
  assert.equal(records[0]?.[0], "record-1");
  assert.equal(records[0]?.[1], "sha256:e7b97801b94190f3159012ede45b0069bb09ebf7920f7432c971bc86a0e08de8");
  assert.ok(records[0]?.[3] instanceof Uint8Array);
});

test("SingleFileMessagePackBackingStore reads CultCache v1 snapshots by schema id", async () => {
  const noteDocument = defineDocumentType({
    type: "tests.named_entry",
    schema: z.object({
      Name: z.string(),
      Value: z.string(),
    }),
    schemaId: "schema-1",
    schemaName: "tests.named_entry",
    schemaVersion: "tests.named_entry.v1",
    contentHash: "hash-1",
    canonicalSchemaJson: "{\"fields\":2}",
  });

  const storePath = join(await mkdtemp(join(tmpdir(), "cultcache-ts-")), "csharp.msgpack");
  await writeFile(
    storePath,
    encode([
      "cultcache.store.v1",
      [
        [
          "schema-1",
          "tests.named_entry",
          "tests.named_entry.v1",
          "hash-1",
          "{\"fields\":2}",
          ["schema-1"],
          [],
        ],
      ],
      [
        [
          "record-1",
          "schema-1",
          "2026-05-08T12:00:00Z",
          encode({
            Name: "Teeth",
            Value: "slot-array",
          }),
        ],
      ],
    ]),
  );

  const cache = CultCache.builder()
    .withDocumentType(noteDocument)
    .withGenericStore(new SingleFileMessagePackBackingStore(storePath))
    .build();

  await cache.pullAllBackingStores();
  assert.deepEqual(cache.getRequired(noteDocument, "record-1"), {
    Name: "Teeth",
    Value: "slot-array",
  });
  assert.equal(cache.getRequiredEnvelope(noteDocument, "record-1").schemaId, "schema-1");
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

  const rewritten = decode(await readFile(storePath)) as unknown[];
  assert.equal(rewritten[0], "cultcache.store.v1");
  const records = rewritten[2] as unknown[][];
  assert.equal(records.length, 1);
  assert.ok(records[0]?.[3] instanceof Uint8Array);
});
