"use strict";
/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
Object.defineProperty(exports, "__esModule", { value: true });
const node_1 = require("vscode-languageserver/node");
const languagemodes_1 = require("./languagemodes");
const vscode_languageserver_textdocument_1 = require("vscode-languageserver-textdocument");
// Create a connection for the server. The connection uses Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = (0, node_1.createConnection)(node_1.ProposedFeatures.all);
// Create a simple text document manager. The text document manager
// supports full document sync only
const documents = new node_1.TextDocuments(vscode_languageserver_textdocument_1.TextDocument);
let languageModes;
connection.onInitialize((_params) => {
    connection.console.log('SuperCollider Language Server initializing...');
    languageModes = (0, languagemodes_1.getLanguageModes)();
    documents.onDidClose(e => {
        languageModes.onDocumentRemoved(e.document);
    });
    connection.onShutdown(() => {
        languageModes.dispose();
    });
    connection.console.log('SuperCollider Language Server initialized with hover support');
    return {
        capabilities: {
            textDocumentSync: node_1.TextDocumentSyncKind.Full,
            // Tell the client that the server supports code completion
            completionProvider: {
                resolveProvider: false
            },
            // Tell the client that the server supports hover
            hoverProvider: true
        }
    };
});
connection.onDidChangeConfiguration(_change => {
    // Revalidate all open text documents
    documents.all().forEach(validateTextDocument);
});
// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
    validateTextDocument(change.document);
});
async function validateTextDocument(textDocument) {
    try {
        const version = textDocument.version;
        const diagnostics = [];
        if (textDocument.languageId === 'supercollider') {
            const modes = languageModes.getAllModesInDocument(textDocument);
            const latestTextDocument = documents.get(textDocument.uri);
            if (latestTextDocument && latestTextDocument.version === version) {
                // check no new version has come in after in after the async op
                modes.forEach(mode => {
                    if (mode.doValidation) {
                        mode.doValidation(latestTextDocument).forEach(d => {
                            diagnostics.push(d);
                        });
                    }
                });
                connection.sendDiagnostics({ uri: latestTextDocument.uri, diagnostics });
            }
        }
    }
    catch (e) {
        connection.console.error(`Error while validating ${textDocument.uri}`);
        connection.console.error(String(e));
    }
}
connection.onCompletion(async (textDocumentPosition, _token) => {
    const document = documents.get(textDocumentPosition.textDocument.uri);
    if (!document) {
        return null;
    }
    const mode = languageModes.getModeAtPosition(document, textDocumentPosition.position);
    if (!mode || !mode.doComplete) {
        return node_1.CompletionList.create();
    }
    const doComplete = mode.doComplete;
    return doComplete(document, textDocumentPosition.position);
});
connection.onHover(async (textDocumentPosition, _token) => {
    const document = documents.get(textDocumentPosition.textDocument.uri);
    if (!document) {
        connection.console.log('Hover: No document found');
        return null;
    }
    const mode = languageModes.getModeAtPosition(document, textDocumentPosition.position);
    connection.console.log(`Hover: mode = ${mode?.getId()}, hasDoHover = ${!!mode?.doHover}`);
    if (!mode || !mode.doHover) {
        connection.console.log('Hover: No mode or doHover not defined');
        return null;
    }
    const result = mode.doHover(document, textDocumentPosition.position);
    connection.console.log(`Hover result: ${JSON.stringify(result)?.substring(0, 100)}`);
    return result;
});
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);
// Listen on the connection
connection.listen();
//# sourceMappingURL=server.js.map