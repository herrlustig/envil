"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stopClient = exports.startClient = void 0;
const path = require("path");
const fs = require("fs");
const node_1 = require("vscode-languageclient/node");
let client = null;
function startClient(context) {
    const serverModule = context.asAbsolutePath(path.join('server', 'out', 'server.js'));
    if (!fs.existsSync(serverModule)) {
        console.warn('[envil] SC Language Server not compiled – hover/completion unavailable. Run "npm run compile".');
        return;
    }
    const serverOptions = {
        run: { module: serverModule, transport: node_1.TransportKind.ipc },
        debug: { module: serverModule, transport: node_1.TransportKind.ipc },
    };
    const clientOptions = {
        documentSelector: [{ scheme: 'file', language: 'supercollider' }],
    };
    client = new node_1.LanguageClient('envilScLanguageServer', 'Envil SC Language Server', serverOptions, clientOptions);
    client.start();
    console.log('[envil] SC Language Server started (hover + completion active)');
}
exports.startClient = startClient;
async function stopClient() {
    if (client) {
        await client.stop();
        client = null;
    }
}
exports.stopClient = stopClient;
//# sourceMappingURL=lsp.js.map