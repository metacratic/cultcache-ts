"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SingleFileMessagePackBackingStore = void 0;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const msgpack_1 = require("@msgpack/msgpack");
const zod_1 = require("zod");
const envelopeSchema = zod_1.z.object({
    key: zod_1.z.string().min(1),
    type: zod_1.z.string().min(1),
    payload: zod_1.z.instanceof(Uint8Array),
    storedAt: zod_1.z.string().min(1),
});
const envelopeArraySchema = zod_1.z.array(envelopeSchema);
class SingleFileMessagePackBackingStore {
    filePath;
    #writeQueue = Promise.resolve();
    constructor(filePath) {
        this.filePath = (0, node_path_1.resolve)(filePath);
    }
    async pullAll() {
        try {
            const data = await (0, promises_1.readFile)(this.filePath);
            return envelopeArraySchema.parse((0, msgpack_1.decode)(data));
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
            await (0, promises_1.writeFile)(tempPath, (0, msgpack_1.encode)(entries));
            await (0, promises_1.rename)(tempPath, this.filePath);
        }
        catch (error) {
            await (0, promises_1.rm)(tempPath, { force: true }).catch(() => undefined);
            throw error;
        }
    }
}
exports.SingleFileMessagePackBackingStore = SingleFileMessagePackBackingStore;
