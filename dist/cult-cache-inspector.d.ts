export interface CultCacheInspection {
    filePath: string;
    fileSizeBytes: number;
    format: "cultcache.store.v1" | "legacy.envelope-array";
    catalog: InspectedCatalogEntry[];
    records: InspectedRecord[];
}
export interface InspectedCatalogEntry {
    schemaId: string;
    schemaName: string;
    schemaVersion: string;
    contentHash: string;
    canonicalSchemaJson: string;
    compatibleSchemaIds: string[];
    members: InspectedCatalogMember[];
}
export interface InspectedCatalogMember {
    slot: number;
    memberName: string;
    typeName: string;
    isReference: boolean;
    isMany: boolean;
    targetSchemaName: string | null;
    isName: boolean;
    indexAlias: string | null;
}
export interface InspectedRecord {
    key: string;
    schemaId: string;
    schemaName: string;
    storedAt: string;
    payloadBytes: number;
    payloadPreview: unknown;
    payloadDecodeError?: string;
}
export declare function inspectCultCacheBytes(filePath: string, bytes: Uint8Array, fileSizeBytes?: number): CultCacheInspection;
//# sourceMappingURL=cult-cache-inspector.d.ts.map