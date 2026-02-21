import * as path from 'path';
import * as fs from 'fs';
import { ExtensionContext } from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient | null = null;

export function startClient(context: ExtensionContext): void {
    const serverModule = context.asAbsolutePath(path.join('server', 'out', 'server.js'));

    if (!fs.existsSync(serverModule)) {
        console.warn('[envil] SC Language Server not compiled – hover/completion unavailable. Run "npm run compile".');
        return;
    }

    const serverOptions: ServerOptions = {
        run:   { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc },
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'supercollider' }],
    };

    client = new LanguageClient(
        'envilScLanguageServer',
        'Envil SC Language Server',
        serverOptions,
        clientOptions,
    );

    client.start();
    console.log('[envil] SC Language Server started (hover + completion active)');
}

export async function stopClient(): Promise<void> {
    if (client) {
        await client.stop();
        client = null;
    }
}
