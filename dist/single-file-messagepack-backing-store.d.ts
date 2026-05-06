import type { CacheBackingStore, CultCacheEnvelope, PushAllOptions } from "./types";
export declare class SingleFileMessagePackBackingStore implements CacheBackingStore {
    #private;
    readonly filePath: string;
    constructor(filePath: string);
    pullAll(): Promise<CultCacheEnvelope[]>;
    push(entry: CultCacheEnvelope): Promise<void>;
    delete(entry: CultCacheEnvelope): Promise<void>;
    pushAll(entries: CultCacheEnvelope[], options?: PushAllOptions): Promise<void>;
}
//# sourceMappingURL=single-file-messagepack-backing-store.d.ts.map