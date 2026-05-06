import type { CacheBackingStore, CultCacheDocumentDefinition, CultCacheDocumentValue, CultCacheEnvelope } from "./types";
export declare class CultCache {
    #private;
    registerDocumentType<TDefinition extends CultCacheDocumentDefinition>(definition: TDefinition): TDefinition;
    addBackingStore(store: CacheBackingStore, ...types: string[]): void;
    pullAllBackingStores(): Promise<void>;
    get<TDefinition extends CultCacheDocumentDefinition>(definition: TDefinition, key: string): CultCacheDocumentValue<TDefinition> | undefined;
    getRequired<TDefinition extends CultCacheDocumentDefinition>(definition: TDefinition, key: string): CultCacheDocumentValue<TDefinition>;
    getAll<TDefinition extends CultCacheDocumentDefinition>(definition: TDefinition): CultCacheDocumentValue<TDefinition>[];
    put<TDefinition extends CultCacheDocumentDefinition>(definition: TDefinition, key: string, value: CultCacheDocumentValue<TDefinition>): Promise<CultCacheDocumentValue<TDefinition>>;
    update<TDefinition extends CultCacheDocumentDefinition>(definition: TDefinition, key: string, updater: (current: CultCacheDocumentValue<TDefinition> | undefined) => CultCacheDocumentValue<TDefinition>): Promise<CultCacheDocumentValue<TDefinition>>;
    delete<TDefinition extends CultCacheDocumentDefinition>(definition: TDefinition, key: string): Promise<boolean>;
    snapshot(): CultCacheEnvelope[];
}
//# sourceMappingURL=cult-cache.d.ts.map