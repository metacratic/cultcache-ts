"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.defineDocumentType = defineDocumentType;
function defineDocumentType(definition) {
    if (!definition.type || definition.type.trim().length === 0) {
        throw new Error("CultCache document types must declare a non-empty type.");
    }
    return definition;
}
