/**
 * Refresh the mrvc-ai ZCode plugin wrapper's MCP bundle from the freshly
 * built develop bundle and smoke-test it (serverInfo version + tool count).
 * The wrapper carries NO source — only this build artifact + docs — so the
 * refresh is a plain file copy of esbuild output (the same category as
 * `node esbuild.js` writing out/).
 * Run: node tools/refresh-mrvc-ai-bundle.mjs
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..', 'mcp', 'mcp-server.js');
const dst = path.resolve(here, '..', '..', 'plugins', 'mrvc-ai', 'mcp', 'mcp-server.js');

const srcSize = fs.statSync(src).size;
fs.copyFileSync(src, dst);
const dstSize = fs.statSync(dst).size;
console.log(`copied bundle: ${srcSize} -> ${dstSize} bytes`);

const child = spawn(process.execPath, [dst], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const fail = (msg) => {
  console.log(`FAIL  ${msg}`);
  child.kill();
  process.exit(1);
};
const timer = setTimeout(() => fail('smoke timeout'), 15000);
child.stdout.on('data', (d) => {
  buf += d.toString();
  for (const line of buf.split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m.id === 1 && m.result) {
        const ver = m.result.serverInfo?.version;
        if (ver !== '0.4.0') fail(`serverInfo version ${ver} != 0.4.0`);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
      }
      if (m.id === 2 && m.result) {
        const n = m.result.tools.length;
        console.log(`smoke: serverInfo 0.4.0 / ${n} tools`);
        clearTimeout(timer);
        child.kill();
        process.exit(n === 27 ? 0 : fail(`tool count ${n} != 27`));
      }
    } catch {
      /* partial line — keep buffering */
    }
  }
});
child.stdin.write(
  JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } }) + '\n'
);
