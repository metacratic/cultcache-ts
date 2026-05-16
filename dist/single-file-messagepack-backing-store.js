"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SingleFileMessagePackBackingStore = void 0;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const msgpack_1 = require("@msgpack/msgpack");
const zod_1 = require("zod");
const STORE_FORMAT_VERSION = "cultcache.store.v1";
const envelopeSchema = zod_1.z.object({
    key: zod_1.z.string().min(1),
    type: zod_1.z.string().min(1),
    payload: zod_1.z.instanceof(Uint8Array),
    storedAt: zod_1.z.string().min(1),
    schemaId: zod_1.z.string().min(1).optional(),
});
const envelopeArraySchema = zod_1.z.array(envelopeSchema);
const legacyEnvelopeArraySchema = zod_1.z.array(zod_1.z.object({
    key: zod_1.z.string().min(1),
    type: zod_1.z.string().min(1),
    payload: zod_1.z.unknown(),
    storedAt: zod_1.z.string().min(1),
}));
class SingleFileMessagePackBackingStore {
    filePath;
    #writeQueue = Promise.resolve();
    constructor(filePath) {
        this.filePath = (0, node_path_1.resolve)(filePath);
    }
    async pullAll() {
        try {
            const data = await (0, promises_1.readFile)(this.filePath);
            if (data.length === 0) {
                return [];
            }
            const decoded = (0, msgpack_1.decode)(data);
            const snapshot = decodeSnapshot(decoded);
            if (snapshot) {
                return snapshot.records.map((record) => {
                    const catalogEntry = snapshot.catalogBySchemaId.get(record.schemaId);
                    if (!catalogEntry) {
                        throw new Error(`CultCache persisted record "${record.key}" references missing schema id "${record.schemaId}".`);
                    }
                    return {
                        key: record.key,
                        type: catalogEntry.schemaName,
                        schemaId: record.schemaId,
                        catalogEntry,
                        payload: record.payload,
                        storedAt: record.storedAt,
                    };
                });
            }
            const legacy = decodeLegacyEnvelopeArray(decoded);
            if (legacy) {
                let repairedLegacyPayload = false;
                const normalized = legacy.map((entry) => {
                    const payload = normalizePayload(entry.payload);
                    if (payload !== entry.payload) {
                        repairedLegacyPayload = true;
                    }
                    return {
                        ...entry,
                        payload,
                    };
                });
                const parsed = envelopeArraySchema.parse(normalized);
                if (repairedLegacyPayload) {
                    await this.#writeAll(parsed);
                }
                return parsed;
            }
            throw new Error(`CultCache file ${this.filePath} is not a recognized CultCache MessagePack store.`);
        }
        catch (error) {
            const code = error.code;
            if (code === "ENOENT") {
                return [];
            }
            throw error;
        }
    }
    async push(entry) {
        await this.#enqueue(async () => {
            const existing = await this.pullAll();
            const filtered = existing.filter((candidate) => !(candidate.type === entry.type && candidate.key === entry.key));
            filtered.push(entry);
            await this.#writeAll(filtered);
        });
    }
    async delete(entry) {
        await this.#enqueue(async () => {
            const existing = await this.pullAll();
            const filtered = existing.filter((candidate) => !(candidate.type === entry.type && candidate.key === entry.key));
            await this.#writeAll(filtered);
        });
    }
    async pushAll(entries, options = {}) {
        await this.#enqueue(async () => {
            if (options.soft) {
                try {
                    await (0, promises_1.readFile)(this.filePath);
                    return;
                }
                catch (error) {
                    const code = error.code;
                    if (code !== "ENOENT") {
                        throw error;
                    }
                }
            }
            await this.#writeAll(entries);
        });
    }
    async #enqueue(operation) {
        let result;
        const next = this.#writeQueue.then(async () => {
            result = await operation();
        });
        this.#writeQueue = next.then(() => undefined, () => undefined);
        await next;
        return result;
    }
    async #writeAll(entries) {
        await (0, promises_1.mkdir)((0, node_path_1.dirname)(this.filePath), { recursive: true });
        const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2)}`;
        try {
            await (0, promises_1.writeFile)(tempPath, (0, msgpack_1.encode)(encodeSnapshot(entries)));
            await (0, promises_1.rename)(tempPath, this.filePath);
        }
        catch (error) {
            await (0, promises_1.rm)(tempPath, { force: true }).catch(() => undefined);
            throw error;
        }
    }
}
exports.SingleFileMessagePackBackingStore = SingleFileMessagePackBackingStore;
function encodeSnapshot(entries) {
    const catalog = [...catalogEntriesFor(entries).values()]
        .sort((left, right) => compareOrdinal(left.schemaName, right.schemaName));
    const records = [...entries]
        .sort((left, right) => compareOrdinal(left.key, right.key))
        .map((entry) => [
        entry.key,
        schemaIdForEnvelope(entry),
        entry.storedAt,
        entry.payload,
    ]);
    return [
        STORE_FORMAT_VERSION,
        catalog.map(encodeCatalogEntry),
        records,
    ];
}
function catalogEntriesFor(entries) {
    const catalog = new Map();
    for (const entry of entries) {
        const schemaId = schemaIdForEnvelope(entry);
        if (!catalog.has(schemaId)) {
            catalog.set(schemaId, entry.catalogEntry ?? {
                schemaId,
                schemaName: entry.type,
                schemaVersion: `${entry.type}.v1`,
                contentHash: schemaId,
                canonicalSchemaJson: JSON.stringify({
                    schemaName: entry.type,
                    schemaVersion: `${entry.type}.v1`,
                    members: [],
                }),
                compatibleSchemaIds: [schemaId],
                members: [],
            });
        }
    }
    return catalog;
}
function schemaIdForEnvelope(entry) {
    return entry.schemaId ?? entry.type;
}
function encodeCatalogEntry(entry) {
    return [
        entry.schemaId,
        entry.schemaName,
        entry.schemaVersion,
        entry.contentHash,
        entry.canonicalSchemaJson,
        [...(entry.compatibleSchemaIds ?? [entry.schemaId])],
        [...(entry.members ?? [])].map(encodeCatalogMember),
    ];
}
function encodeCatalogMember(member) {
    return [
        member.slot,
        member.memberName,
        member.typeName,
        member.isReference === true,
        member.isMany === true,
        member.targetSchemaName ?? null,
        member.isName === true,
        member.indexAlias ?? null,
    ];
}
function decodeSnapshot(decoded) {
    if (!Array.isArray(decoded) || decoded.length === 0 || decoded[0] !== STORE_FORMAT_VERSION) {
        return undefined;
    }
    const catalogRaw = decoded[1];
    const recordsRaw = decoded[2];
    if (!Array.isArray(catalogRaw) || !Array.isArray(recordsRaw)) {
        throw new Error("CultCache v1 snapshot must contain a schema catalog and record array.");
    }
    const catalogBySchemaId = new Map();
    for (const entry of catalogRaw) {
        const catalogEntry = decodeCatalogEntry(entry);
        catalogBySchemaId.set(catalogEntry.schemaId, catalogEntry);
        for (const compatibleSchemaId of catalogEntry.compatibleSchemaIds ?? []) {
            catalogBySchemaId.set(compatibleSchemaId, catalogEntry);
        }
    }
    const records = recordsRaw.map(decodeRecord);
    return { catalogBySchemaId, records };
}
function decodeCatalogEntry(value) {
    if (!Array.isArray(value)) {
        throw new Error("CultCache schema catalog entries must be MessagePack arrays.");
    }
    const [schemaId = "", schemaName = "", schemaVersion = "", contentHash = "", canonicalSchemaJson = "", compatibleSchemaIds = [], members = [],] = value;
    if (!isNonEmptyString(schemaId) || !isNonEmptyString(schemaName)) {
        throw new Error("CultCache schema catalog entries must declare schemaId and schemaName.");
    }
    if (!Array.isArray(compatibleSchemaIds) || !compatibleSchemaIds.every(isNonEmptyString)) {
        throw new Error(`CultCache schema catalog entry "${schemaId}" has invalid compatible schema ids.`);
    }
    if (!Array.isArray(members)) {
        throw new Error(`CultCache schema catalog entry "${schemaId}" has invalid members.`);
    }
    return {
        schemaId,
        schemaName,
        schemaVersion: isNonEmptyString(schemaVersion) ? schemaVersion : `${schemaName}.v1`,
        contentHash: isNonEmptyString(contentHash) ? contentHash : schemaId,
        canonicalSchemaJson: typeof canonicalSchemaJson === "string" ? canonicalSchemaJson : "",
        compatibleSchemaIds,
        members: members.map(decodeCatalogMember),
    };
}
function decodeCatalogMember(value) {
    if (!Array.isArray(value)) {
        throw new Error("CultCache schema catalog members must be MessagePack arrays.");
    }
    const [slot = -1, memberName = "", typeName = "", isReference = false, isMany = false, targetSchemaName = null, isName = false, indexAlias = null,] = value;
    if (!Number.isInteger(slot) || slot < 0 || !isNonEmptyString(memberName) || !isNonEmptyString(typeName)) {
        throw new Error("CultCache schema catalog member has invalid slot, name, or type.");
    }
    return {
        slot,
        memberName,
        typeName,
        isReference: isReference === true,
        isMany: isMany === true,
        targetSchemaName: typeof targetSchemaName === "string" ? targetSchemaName : null,
        isName: isName === true,
        indexAlias: typeof indexAlias === "string" ? indexAlias : null,
    };
}
function decodeRecord(value) {
    if (!Array.isArray(value)) {
        throw new Error("CultCache persisted records must be MessagePack arrays.");
    }
    const [key = "", schemaId = "", storedAt = "", payload = new Uint8Array()] = value;
    if (!isNonEmptyString(key) || !isNonEmptyString(schemaId) || !isNonEmptyString(storedAt)) {
        throw new Error("CultCache persisted records must declare key, schemaId, and storedAt.");
    }
    return {
        key,
        schemaId,
        storedAt,
        payload: normalizePayload(payload),
    };
}
function decodeLegacyEnvelopeArray(decoded) {
    if (!Array.isArray(decoded)) {
        return undefined;
    }
    return legacyEnvelopeArraySchema.parse(decoded);
}
function normalizePayload(payload) {
    if (payload instanceof Uint8Array) {
        return payload;
    }
    if (isObject(payload) &&
        payload.type === "Buffer" &&
        Array.isArray(payload.data) &&
        payload.data.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
        return Uint8Array.from(payload.data);
    }
    if (Array.isArray(payload) && payload.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
        return Uint8Array.from(payload);
    }
    return (0, msgpack_1.encode)(payload);
}
function isObject(value) {
    return typeof value === "object" && value !== null;
}
function isNonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
}
function compareOrdinal(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
