import { z, type ZodType } from "zod";
export interface CultCacheDocumentDefinition<TSchema extends ZodType = ZodType> {
    type: string;
    schema: TSchema;
}
export type CultCacheDocumentValue<TDefinition extends CultCacheDocumentDefinition> = z.infer<TDefinition["schema"]>;
export interface CultCacheEnvelope {
    key: string;
    type: string;
    payload: unknown;
    storedAt: string;
}
export interface PushAllOptions {
    soft?: boolean;
}
export interface CacheBackingStore {
    pullAll(): Promise<CultCacheEnvelope[]>;
    push(entry: CultCacheEnvelope): Promise<void>;
    delete(entry: CultCacheEnvelope): Promise<void>;
    pushAll?(entries: CultCacheEnvelope[], options?: PushAllOptions): Promise<void>;
}
export interface CultCacheStoreRegistration {
    store: CacheBackingStore;
    types: string[];
}
//# sourceMappingURL=types.d.ts.map