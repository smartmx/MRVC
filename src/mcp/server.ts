/**
 * MRVC MCP server — a minimal Model Context Protocol server over stdio
 * (newline-delimited JSON-RPC 2.0, the MCP stdio transport).
 *
 * Why hand-rolled: the protocol surface a TOOL server needs is small
 * (initialize / ping / tools/list / tools/call plus notifications), and a
 * dependency-free ~150-line implementation keeps the vsix free of a second
 * node_modules subtree — the same policy as the vendored koffi/serialport.
 *
 * Everything the tools do lives in tools.ts (zero vscode imports): this
 * server runs inside VSCode, in a terminal, or headless on a CI machine —
 * the client (ZCode / Claude / OpenCode / Cursor / ...) spawns it directly:
 *
 *   node <extension-dir>/mcp/mcp-server.js
 *
 * Configuration (all optional):
 *   MRVC_MRS_INSTALL_PATH   explicit MRS install root
 *   MRVC_MCP_DEFAULT_ROOT   default scan root for mrvc_discover_projects
 *                           (otherwise the server's working directory)
 *
 * stdout carries ONLY protocol messages; diagnostics go to stderr.
 */
import * as fs from 'fs';
import * as path from 'path';
import { callTool, listTools, terminateChildren, SUPPORTED_PROTOCOL_VERSION } from './tools';

let serverVersion = '0.0.0';
try {
  // the bundle lives in <root>/mcp/ — the package.json sits ONE level up
  // (same depth as the old out/ location), both in the repo and in the
  // installed extension directory
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  if (typeof pkg.version === 'string') serverVersion = pkg.version;
} catch {
  // unnamed server is acceptable — never crash over branding
}

interface JsonRpcRequest {
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

function send(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function sendResult(id: number | string | null, result: Record<string, unknown>): void {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id: number | string | null, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const PARSE_ERROR = -32700;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

async function dispatch(msg: JsonRpcRequest): Promise<void> {
  const id = msg.id ?? null;
  const method = typeof msg.method === 'string' ? msg.method : '';
  // notifications (no id) never get a response — including initialized
  if (!method) {
    if (msg.id !== undefined && msg.id !== null) {
      sendError(id, INVALID_PARAMS, 'missing method');
    }
    return;
  }
  if (method === 'initialize') {
    const params = (msg.params ?? {}) as { protocolVersion?: string };
    // echo the client's requested version when it sent one (the MCP
    // handshake contract: the server picks a version the client offered)
    const version = typeof params.protocolVersion === 'string' && params.protocolVersion
      ? params.protocolVersion
      : SUPPORTED_PROTOCOL_VERSION;
    sendResult(id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: 'mrvc-mcp', version: serverVersion },
    });
    return;
  }
  // notifications/* carry no id and expect no reply
  if (method.startsWith('notifications/')) {
    return;
  }
  if (method === 'ping') {
    sendResult(id, {});
    return;
  }
  if (method === 'tools/list') {
    sendResult(id, { tools: listTools() });
    return;
  }
  if (method === 'tools/call') {
    const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
    if (typeof params.name !== 'string' || !params.name) {
      sendError(id, INVALID_PARAMS, 'tools/call requires a tool name');
      return;
    }
    try {
      const result = await callTool(params.name, (params.arguments ?? {}) as Record<string, unknown>);
      sendResult(id, result);
    } catch (e) {
      // the only throw callTool itself makes is the unknown-tool case
      sendError(id, INVALID_PARAMS, e instanceof Error ? e.message : String(e));
    }
    return;
  }
  if (msg.id !== undefined && msg.id !== null) {
    sendError(id, METHOD_NOT_FOUND, `method not found: ${method}`);
  }
}

function main(): void {
  process.stderr.write(`[mrvc-mcp] server ready (v${serverVersion}) — protocol ${SUPPORTED_PROTOCOL_VERSION}\n`);
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl < 0) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcRequest;
      try {
        msg = JSON.parse(line) as JsonRpcRequest;
      } catch (e) {
        process.stderr.write(`[mrvc-mcp] unparseable line ignored: ${e instanceof Error ? e.message : String(e)}\n`);
        send({ jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'parse error' } });
        continue;
      }
      void dispatch(msg).then(
        () => undefined,
        (e) => {
          // a dispatch-layer crash must not kill the server — report and carry on
          process.stderr.write(`[mrvc-mcp] dispatch failed: ${e instanceof Error ? e.message : String(e)}\n`);
          if (msg && msg.id !== undefined && msg.id !== null) {
            sendError(msg.id as number | string, -32603, 'internal error');
          }
        }
      );
    }
  });
  process.stdin.on('end', () => {
    void terminateChildren().then(() => process.exit(0), () => process.exit(0));
  });
  process.stdin.on('close', () => {
    void terminateChildren().then(() => process.exit(0), () => process.exit(0));
  });
  const onSignal = () => {
    void terminateChildren().then(() => process.exit(0), () => process.exit(0));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

main();
