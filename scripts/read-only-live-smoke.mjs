import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const processId = Number(process.argv[2]);
const name = process.argv[3];
const transition = process.argv[4];
if (!Number.isInteger(processId) || !name || !transition || !process.argv.includes('--authorization-ready'))
  throw new Error('Usage: node scripts/read-only-live-smoke.mjs <Portal PID> <exact GRAPH block name> <transition number> --authorization-ready');
const client = new Client({ name: 'tia-read-only-live-smoke', version: '1' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], cwd: process.cwd() }));
async function call(tool, args) {
  const started = Date.now();
  const response = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 120000 });
  const result = response.structuredContent ?? JSON.parse(response.content.find(c => c.type === 'text').text);
  console.log(JSON.stringify({ tool, elapsedMs: Date.now() - started, result }));
  assert.equal(result.ok, true, tool);
  return result;
}
try {
  await call('tia_doctor', { portalVersion: 'V20' });
  await call('tia_get_current_ui_context', { processId });
  await call('tia_prepare_live_session', { processId, confirmPortalAuthorizationReady: true, timeoutMs: 45000 });
  const search = await call('tia_search_live_objects', { processId, resourceKind: 'block', query: name, maxResults: 10 });
  assert.equal(search.matches.length, 1);
  for (let i = 0; i < 2; i++) {
    const context = await call('tia_get_graph_context', { processId, name, transition, timeoutMs: 45000 });
    assert.equal(context.requestedActionCompleted, true);
  }
} finally { await client.close(); }
