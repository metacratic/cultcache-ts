import type { AnyCultCacheDocumentDefinition, CacheBackingStore, CultCacheDocumentAccessor, CultCacheDocumentRegistry, CultCacheDocumentValue, CultCacheEnvelope } from "./types";
type BackingStoreTypeReference = string | AnyCultCacheDocumentDefinition;
export declare class CultCacheBuilder {
    #private;
    withDocumentType<TDefinition extends AnyCultCacheDocumentDefinition>(definition: TDefinition): this;
    withRegistry(registry: CultCacheDocumentRegistry | Iterable<AnyCultCacheDocumentDefinition>): this;
    withBackingStore(store: CacheBackingStore, ...types: BackingStoreTypeReference[]): this;
    withGenericStore(store: CacheBackingStore): this;
    build(): CultCache;
}
export declare class CultCache {
    #private;
    static readonly GLOBAL_KEY = "__global__";
    static builder(): CultCacheBuilder;
    registerDocumentType<TDefinition extends AnyCultCacheDocumentDefinition>(definition: TDefinition): TDefinition;
    registerRegistry(registry: CultCacheDocumentRegistry | Iterable<AnyCultCacheDocumentDefinition>): this;
    registerNameLookup<TDefinition extends AnyCultCacheDocumentDefinition>(definition: TDefinition, accessor: CultCacheDocumentAccessor<CultCacheDocumentValue<TDefinition>>): TDefinition;
    registerIndex<TDefinition extends AnyCultCacheDocumentDefinition>(definition: TDefinition, indexName: string, accessor: CultCacheDocumentAccessor<CultCacheDocumentValue<TDefinition>>): TDefinition;
    addBackingStore(store: CacheBackingStore, ...types: BackingStoreTypeReference[]): void;
    addGenericBackingStore(store: CacheBackingStore): void;
    pullAllBackingStores(): Promise<void>;
    get<TDefinition extends AnyCultCacheDocumentDefinition>(definition: TDefinition, key: string): CultCacheDocumentValue<TDefinition> | undefined;
    getRequired<TDefinition extends AnyCultCacheDocumentDefinition>(definition: TDefinition, key: string): CultCacheDocumentValue<TDefinition>;
    getEnvelope<TDefinition extends AnyCultCacheDocumentDefinition>(definition: TDefinition, key: string): CultCacheEnvelope | undefined;
    getRequiredEnvelope<TDefinition extends AnyCultCacheDocumentDefinition>(definition: TDefinition, key: string): CultCacheEnvelope;
    getGlobal<TDefinition extends AnyCultCacheDocumentDefinition>(definition: TDefinition): CultCacheDocumentValue<TDefinition> | undefined;
    getRequiredGlobal<TDefinition extends AnyCultCacheDocumentDefinition>(definition: TDefinition): CultCacheDocumentValue<TDefinition>;
    getGlobalEnvelope<TDefinition extends AnyCultCacheDocumentDefinition>(definition: TDefinition): CultCacheEnvelope | undefined;
    getAll<TDefinition extends AnyCultCacheDocumentDefinition>(definition: TDefinition): CultCacheDocumentValue<TDefinition>[];
    getKeyByName<TDefinition extends AnyCultCacheDocumentDefinition>(definition: TDefinition, name: string): string | undefined;
    getIdByName<TDefinition extends AnyCultCacheDocumentDefinition>(definition: TDefinition, name: string): string | undefined;
    getByName<TDefinition extends AnyCultCacheDocumentDefinition>(definition: TDefinition, name: string): CultCacheDocumentValue<TDefinition> | undefined;
    getKeyByIndex<TDefinition extends AnyCultCacheDocumentDefinition>(definition: TDefinition, indexName: string, value: string): string | undefined;
    getIdByIndex<TDefinition extends AnyCultCacheDocumentDefinition>(definition: TDefinition, indexName: string, value: string): string | undefined;
    getByIndex<TDefinition extends AnyCultCacheDocumentDefinition>(definition: TDefinition, indexName: string, value: string): CultCacheDocumentValue<TDefinition> | undefined;
    put<TDefinition extends AnyCultCacheDocumentDefinition>(definition: TDefinition, key: string, value: CultCacheDocumentValue<TDefinition>): Promise<CultCacheDocumentValue<TDefinition>>;
    putEnvelope<TDefinition extends AnyCultCacheDocumentDefinition>(definition: TDefinition, envelope: CultCacheEnvelope): Promise<CultCacheDocumentValue<TDefinition>>;
    putGlobal<TDefinition extends AnyCultCacheDocumentDefinition>(definition: TDefinition, value: CultCacheDocumentValue<TDefinition>): Promise<CultCacheDocumentValue<TDefinition>>;
    update<TDefinition extends AnyCultCacheDocumentDefinition>(definition: TDefinition, key: string, updater: (current: CultCacheDocumentValue<TDefinition> | undefined) => CultCacheDocumentValue<TDefinition>): Promise<CultCacheDocumentValue<TDefinition>>;
    updateGlobal<TDefinition extends AnyCultCacheDocumentDefinition>(definition: TDefinition, updater: (current: CultCacheDocumentValue<TDefinition> | undefined) => CultCacheDocumentValue<TDefinition>): Promise<CultCacheDocumentValue<TDefinition>>;
    delete<TDefinition extends AnyCultCacheDocumentDefinition>(definition: TDefinition, key: string): Promise<boolean>;
    deleteGlobal<TDefinition extends AnyCultCacheDocumentDefinition>(definition: TDefinition): Promise<boolean>;
    snapshot(): CultCacheEnvelope[];
}
export {};
//# sourceMappingURL=cult-cache.d.ts.map