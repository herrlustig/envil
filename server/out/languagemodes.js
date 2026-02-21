"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLanguageModes = exports.TextDocument = exports.Range = exports.Position = void 0;
const node_1 = require("vscode-languageserver/node");
Object.defineProperty(exports, "Position", { enumerable: true, get: function () { return node_1.Position; } });
Object.defineProperty(exports, "Range", { enumerable: true, get: function () { return node_1.Range; } });
const vscode_languageserver_textdocument_1 = require("vscode-languageserver-textdocument");
Object.defineProperty(exports, "TextDocument", { enumerable: true, get: function () { return vscode_languageserver_textdocument_1.TextDocument; } });
const scdmode_1 = require("./modes/scdmode");
function getLanguageModes() {
    const scdMode = (0, scdmode_1.getSuperColliderMode)();
    const modes = {
        'supercollider': scdMode
    };
    return {
        getModeAtPosition(_document, _position) {
            // SuperCollider is a single language, always return the scd mode
            return scdMode;
        },
        getModesInRange(document, range) {
            // SuperCollider is a single language, return the whole range as scd
            return [{
                    start: range.start,
                    end: range.end,
                    mode: scdMode
                }];
        },
        getAllModesInDocument(_document) {
            return [scdMode];
        },
        getAllModes() {
            return Object.values(modes);
        },
        getMode(languageId) {
            return modes[languageId];
        },
        onDocumentRemoved(document) {
            for (const mode of Object.values(modes)) {
                mode.onDocumentRemoved(document);
            }
        },
        dispose() {
            for (const mode of Object.values(modes)) {
                mode.dispose();
            }
        }
    };
}
exports.getLanguageModes = getLanguageModes;
//# sourceMappingURL=languagemodes.js.map