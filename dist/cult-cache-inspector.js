"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inspectCultCacheBytes = inspectCultCacheBytes;
const msgpack_1 = require("@msgpack/msgpack");
const STORE_FORMAT_VERSION = "cultcache.store.v1";
function inspectCultCacheBytes(filePath, bytes, fileSizeBytes = bytes.length) {
    const decoded = (0, msgpack_1.decode)(bytes);
    if (isV1Snapshot(decoded)) {
        return inspectV1Snapshot(filePath, fileSizeBytes, decoded);
    }
    if (Array.isArray(decoded)) {
        return inspectLegacyEnvelopeArray(filePath, fileSizeBytes, decoded);
    }
    throw new Error("CultCache file is not a recognized v1 snapshot or legacy envelope array.");
}
function inspectV1Snapshot(filePath, fileSizeBytes, decoded) {
    const catalogRaw = decoded[1];
    const recordsRaw = decoded[2];
    if (!Array.isArray(catalogRaw) || !Array.isArray(recordsRaw)) {
        throw new Error("CultCache v1 snapshot must contain a schema catalog and record array.");
    }
    const catalog = catalogRaw.map(decodeCatalogEntry);
    const catalogBySchemaId = new Map();
    for (const entry of catalog) {
        catalogBySchemaId.set(entry.schemaId, entry);
        for (const compatibleSchemaId of entry.compatibleSchemaIds) {
            catalogBySchemaId.set(compatibleSchemaId, entry);
        }
    }
    return {
        filePath,
        fileSizeBytes,
        format: STORE_FORMAT_VERSION,
        catalog,
        records: recordsRaw.map((record) => decodeV1Record(record, catalogBySchemaId)),
    };
}
function inspectLegacyEnvelopeArray(filePath, fileSizeBytes, decoded) {
    const records = decoded.map((entry) => decodeLegacyEnvelope(entry));
    const schemaNames = new Set(records.map((record) => record.schemaName));
    const catalog = [...schemaNames].sort(compareOrdinal).map((schemaName) => ({
        schemaId: schemaName,
        schemaName,
        schemaVersion: `${schemaName}.v1`,
        contentHash: schemaName,
        canonicalSchemaJson: JSON.stringify({
            schemaName,
            schemaVersion: `${schemaName}.v1`,
            members: [],
        }),
        compatibleSchemaIds: [schemaName],
        members: [],
    }));
    return {
        filePath,
        fileSizeBytes,
        format: "legacy.envelope-array",
        catalog,
        records,
    };
}
function decodeCatalogEntry(value) {
    if (!Array.isArray(value)) {
        throw new Error("CultCache schema catalog entries must be MessagePack arrays.");
    }
    const [schemaId = "", schemaName = "", schemaVersion = "", contentHash = "", canonicalSchemaJson = "", compatibleSchemaIds = [], members = [],] = value;
    if (!isNonEmptyString(schemaId) || !isNonEmptyString(schemaName)) {
        throw new Error("CultCache schema catalog entries must declare schemaId and schemaName.");
    }
    return {
        schemaId,
        schemaName,
        schemaVersion: isNonEmptyString(schemaVersion) ? schemaVersion : `${schemaName}.v1`,
        contentHash: isNonEmptyString(contentHash) ? contentHash : schemaId,
        canonicalSchemaJson: typeof canonicalSchemaJson === "string" ? canonicalSchemaJson : "",
        compatibleSchemaIds: Array.isArray(compatibleSchemaIds)
            ? compatibleSchemaIds.filter(isNonEmptyString)
            : [],
        members: Array.isArray(members) ? members.map(decodeCatalogMember) : [],
    };
}
function decodeCatalogMember(value) {
    if (!Array.isArray(value)) {
        throw new Error("CultCache schema catalog members must be MessagePack arrays.");
    }
    const [slot = -1, memberName = "", typeName = "", isReference = false, isMany = false, targetSchemaName = null, isName = false, indexAlias = null,] = value;
    if (!Number.isInteger(slot) || !isNonEmptyString(memberName) || !isNonEmptyString(typeName)) {
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
function decodeV1Record(value, catalogBySchemaId) {
    if (!Array.isArray(value)) {
        throw new Error("CultCache persisted records must be MessagePack arrays.");
    }
    const [key = "", schemaId = "", storedAt = "", payload = new Uint8Array()] = value;
    if (!isNonEmptyString(key) || !isNonEmptyString(schemaId) || !isNonEmptyString(storedAt)) {
        throw new Error("CultCache persisted records must declare key, schemaId, and storedAt.");
    }
    const catalogEntry = catalogBySchemaId.get(schemaId);
    const payloadBytes = normalizePayloadBytes(payload);
    return {
        key,
        schemaId,
        schemaName: catalogEntry?.schemaName ?? "<missing catalog entry>",
        storedAt,
        payloadBytes: payloadBytes.length,
        ...previewPayload(payloadBytes),
    };
}
function decodeLegacyEnvelope(value) {
    if (!isRecord(value)) {
        throw new Error("CultCache legacy envelopes must be MessagePack maps.");
    }
    const key = value.key;
    const schemaName = value.type;
    const storedAt = value.storedAt;
    if (!isNonEmptyString(key) || !isNonEmptyString(schemaName) || !isNonEmptyString(storedAt)) {
        throw new Error("CultCache legacy envelopes must declare key, type, and storedAt.");
    }
    const schemaId = isNonEmptyString(value.schemaId) ? value.schemaId : schemaName;
    const payloadBytes = normalizePayloadBytes(value.payload);
    return {
        key,
        schemaId,
        schemaName,
        storedAt,
        payloadBytes: payloadBytes.length,
        ...previewPayload(payloadBytes),
    };
}
function previewPayload(payload) {
    try {
        return { payloadPreview: toJsonSafe((0, msgpack_1.decode)(payload)) };
    }
    catch (error) {
        return {
            payloadPreview: {
                bytes: payload.length,
                hexPrefix: [...payload.slice(0, 32)]
                    .map((value) => value.toString(16).padStart(2, "0"))
                    .join(" "),
            },
            payloadDecodeError: error instanceof Error ? error.message : String(error),
        };
    }
}
function normalizePayloadBytes(value) {
    if (value instanceof Uint8Array) {
        return value;
    }
    if (isRecord(value) &&
        value.type === "Buffer" &&
        Array.isArray(value.data) &&
        value.data.every(isByte)) {
        return Uint8Array.from(value.data);
    }
    if (Array.isArray(value) && value.every(isByte)) {
        return Uint8Array.from(value);
    }
    throw new Error("CultCache record payload must be binary MessagePack bytes.");
}
function toJsonSafe(value) {
    if (typeof value === "bigint") {
        return value.toString();
    }
    if (value instanceof Uint8Array) {
        return {
            bytes: value.length,
            hexPrefix: [...value.slice(0, 32)]
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join(" "),
        };
    }
    if (Array.isArray(value)) {
        return value.map(toJsonSafe);
    }
    if (isRecord(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [key, toJsonSafe(entryValue)]));
    }
    return value;
}
function isV1Snapshot(value) {
    return Array.isArray(value) && value[0] === STORE_FORMAT_VERSION;
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function isNonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
}
function isByte(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;
}
function compareOrdinal(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}
