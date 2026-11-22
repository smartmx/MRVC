// esbuild bundler: single-file output, vscode stays external.
const esbuild = require('esbuild');
const path = require('path');

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [path.join(__dirname, 'src', 'extension.ts')],
  bundle: true,
  outfile: path.join(__dirname, 'out', 'extension.js'),
  // koffi stays external: a native module cannot be bundled. The vsix ships
  // the runtime at vendor-ffi/node_modules/koffi (see .vscodeignore); the
  // wildcard keeps esbuild from bundling that relative require as source.
  // serialport (SDI PRINT monitor) follows the same pattern at vendor-serial.
  external: ['vscode', 'koffi', '*vendor-ffi', 'serialport', '*vendor-serial'],
  format: 'cjs',
  platform: 'node',
  target: 'node16',
  sourcemap: true,
  logLevel: 'info',
};

/** second entry: the stdio MCP server (src/mcp, zero vscode imports) —
 *  shipped at <ext>/mcp/mcp-server.js (0.3.6: own folder instead of out/,
 *  user request — a dedicated dir for the AI-facing artifact). No sourcemap:
 *  it is a standalone tool, not a debug target. */
const mcpOptions = {
  ...options,
  entryPoints: [path.join(__dirname, 'src', 'mcp', 'server.ts')],
  outfile: path.join(__dirname, 'mcp', 'mcp-server.js'),
  sourcemap: false,
};

(async () => {
  if (watch) {
    const ctx = await esbuild.context(options);
    const ctxMcp = await esbuild.context(mcpOptions);
    await ctx.watch();
    await ctxMcp.watch();
  } else {
    await esbuild.build(options);
    await esbuild.build(mcpOptions);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
