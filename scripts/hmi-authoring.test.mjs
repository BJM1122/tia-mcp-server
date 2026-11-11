import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, editNativeXml, validateNativeXml, hmiAdapters } from '../dist/hmi-authoring.js';
import { runHmiNative, hmiTimeoutMs } from '../dist/hmi-authoring-tools.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const original = '<?xml version="1.0" encoding="utf-8"?><Document><Hmi.Screen.Screen ID="1"><AttributeList><Name>主画面</Name></AttributeList><Vendor.Extension event="Press"><![CDATA[opaque <script>]]></Vendor.Extension></Hmi.Screen.Screen></Document>';
const start = original.indexOf('主画面');
const edit = { start, end: start + 3, expected: '主画面', replacement: '生产总览' };
test('scoped edit preserves unknown native data and every untouched character', () => {
  const result = editNativeXml(original, digest(original), [edit]);
  assert.equal(result.candidateXml, original.replace('主画面', '生产总览'));
  assert.equal(result.candidateSha256, digest(result.candidateXml));
  assert.equal(result.nativeImportVerified, false);
});
test('stale baseline, incorrect expected text and overlapping ranges are rejected', () => {
  assert.throws(() => editNativeXml(original, '0'.repeat(64), [edit]), /hash mismatch/);
  assert.throws(() => editNativeXml(original, digest(original), [{ ...edit, expected: 'other' }]), /Expected text/);
  assert.throws(() => editNativeXml(original, digest(original), [edit, edit]), /overlapping/);
});
test('invalid XML and active entity declarations never produce a candidate', () => {
  assert.throws(() => editNativeXml(original, digest(original), [{ ...edit, replacement: '<broken>' }]), /Invalid native XML/);
  assert.throws(() => validateNativeXml('<!DOCTYPE Document SYSTEM "file:///secret"><Document/>'), /DTD/);
  assert.throws(() => validateNativeXml('<Document><Hmi.Screen.Screen ID="1"/><Hmi.Screen.Screen ID="2"/></Document>'), /Exactly one/);
});
test('software families remain distinct and unverified adapters are not enabled', () => {
  assert.equal(new Set(hmiAdapters.map(a => a.id)).size, 4);
  assert.ok(hmiAdapters.filter(a => a.id !== 'wincc-classic-v20').every(a => a.import === 'not_enabled'));
  assert.equal(hmiAdapters.find(a => a.id === 'mcgspro').version, null);
});
test('companion transport preserves split UTF-8 and rejects a hung process', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hmi-transport-'));
  try {
    const fixture = path.join(dir, 'fixture.cjs');
    await writeFile(fixture, `process.stdin.resume(); process.stdin.on('end',()=>{const b=Buffer.from(JSON.stringify({ok:true,xml:'主画面'}));let i=0;const t=setInterval(()=>{if(i===b.length){clearInterval(t);return;}process.stdout.write(b.subarray(i,i+1));i++;},1);});`);
    const result = await runHmiNative(process.execPath, fixture, { projectPath: '中文路径' });
    assert.equal(result.xml, '主画面');
    await writeFile(fixture,'process.stdin.resume();process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({ok:true}),()=>process.exit(1));});');
    const abnormal=await runHmiNative(process.execPath,fixture,{operation:'create_unified_project'});
    assert.equal(abnormal.ok,false);assert.equal(abnormal.requiresFreshReadback,true);
    await writeFile(fixture, 'setInterval(()=>{},1000);');
    await assert.rejects(runHmiNative(process.execPath, fixture, {}, 100), /timed out/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('companion limits keep writes far above reads and ignore invalid overrides', () => {
  const saved = { read: process.env.TIA_MCP_HMI_READ_TIMEOUT_MS, write: process.env.TIA_MCP_HMI_WRITE_TIMEOUT_MS };
  try {
    delete process.env.TIA_MCP_HMI_READ_TIMEOUT_MS; delete process.env.TIA_MCP_HMI_WRITE_TIMEOUT_MS;
    assert.deepEqual([hmiTimeoutMs('read'), hmiTimeoutMs('bundle'), hmiTimeoutMs('write')], [120_000, 600_000, 900_000]);
    for (const bad of ['', 'abc', '9999', '99999999', '20000.5']) {
      process.env.TIA_MCP_HMI_WRITE_TIMEOUT_MS = bad;
      assert.equal(hmiTimeoutMs('write'), 900_000, bad);
    }
    process.env.TIA_MCP_HMI_WRITE_TIMEOUT_MS = '20000';
    assert.equal(hmiTimeoutMs('write'), 120_000);
    process.env.TIA_MCP_HMI_WRITE_TIMEOUT_MS = '1800000';
    process.env.TIA_MCP_HMI_READ_TIMEOUT_MS = '30000';
    assert.deepEqual([hmiTimeoutMs('read'), hmiTimeoutMs('bundle'), hmiTimeoutMs('write')], [30_000, 600_000, 1_800_000]);
  } finally {
    for (const [key, name] of [['read', 'TIA_MCP_HMI_READ_TIMEOUT_MS'], ['write', 'TIA_MCP_HMI_WRITE_TIMEOUT_MS']]) {
      if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key];
    }
  }
});
