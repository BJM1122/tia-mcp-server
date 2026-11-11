import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const exe = path.resolve('tools', 'TiaOpennessImportBlock.exe');
const api = process.env.TIA_MCP_OPENNESS_API_DLL;
const available = process.platform === 'win32' && existsSync(exe) && api && existsSync(api);
const sample = '<Document><SW.Blocks.FC ID="0"><AttributeList><Name>Test</Name><Number>1</Number><ProgrammingLanguage>LAD</ProgrammingLanguage></AttributeList><ObjectList /></SW.Blocks.FC></Document>';

test('production importer validates candidates without attaching or modifying a project', {
  skip: available ? false : 'Build the importer and set TIA_MCP_OPENNESS_API_DLL.',
}, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tia-import-validation-'));
  const xml = path.join(dir, 'candidate.xml');
  const args = ['--api', api, '--validate-only', '--xml', xml, '--target-name', 'Test', '--target-number', '1', '--target-kind', 'FC'];
  const run = (extra = []) => {
    const result = spawnSync(exe, [...args, ...extra], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(result.error, undefined);
    return { ...result, json: JSON.parse(result.stdout.trim()) };
  };
  try {
    await writeFile(xml, sample);
    let result = run();
    assert.equal(result.status, 0);
    assert.equal(result.json.status, 'candidate_validated');
    assert.equal(result.json.projectModified, false);
    assert.equal(result.json.plcAccessed, false);
    const cases = [
      sample.replace('<Name>Test</Name>', '<Name>Different</Name>'),
      sample.replace('<Number>1</Number>', '<Number>2</Number>'),
      sample.replaceAll('SW.Blocks.FC', 'SW.Blocks.FB'),
      sample.replace('</Document>', '<SW.Blocks.FC ID="2" /></Document>'),
      sample.replace('<ObjectList />', '<ObjectList><SW.Blocks.CompileUnit ID="0" /></ObjectList>'),
      sample.replace('</Document>', '<SW.Tags.PlcTagTable /></Document>'),
      '<!DOCTYPE Document [<!ENTITY external SYSTEM "file:///missing.txt">]>' + sample,
    ];
    for (const invalid of cases) {
      await writeFile(xml, invalid);
      result = run();
      assert.equal(result.status, 1, invalid);
      assert.equal(result.json.ok, false);
    }
    await writeFile(xml, sample);
    for (const extra of [['--download'], ['--process-id', '1'], ['--target-name', 'Test']]) {
      result = run(extra);
      assert.equal(result.status, 1);
      assert.equal(result.json.ok, false);
    }
    assert.equal(await readFile(xml, 'utf8'), sample);
    // Match the MCP plan's concrete Simatic ML kind, not the generic DB label.
    for (const kind of ['GlobalDB', 'InstanceDB']) {
      await writeFile(xml, sample.replaceAll('SW.Blocks.FC', `SW.Blocks.${kind}`));
      const dbArgs = [...args];
      dbArgs[dbArgs.indexOf('--target-kind') + 1] = kind;
      const db = spawnSync(exe, dbArgs, { encoding: 'utf8', timeout: 10000, windowsHide: true });
      assert.equal(db.status, 0, db.stdout);
      assert.equal(JSON.parse(db.stdout.trim()).Kind, kind);
      dbArgs[dbArgs.indexOf('--target-kind') + 1] = 'DB';
      const mismatch = spawnSync(exe, dbArgs, { encoding: 'utf8', timeout: 10000, windowsHide: true });
      assert.equal(mismatch.status, 1);
    }
    const self = spawnSync(exe, ['--api', api, '--self-test'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    assert.equal(self.status, 0);
    const report = JSON.parse(self.stdout.trim());
    assert.equal(report.status, 'self_test_passed');
    assert.equal(report.safety.projectModified, false);
    assert.equal(report.safety.import, false);

    // Both native entry points reject an unapproved candidate or recycled PID
    // before attaching. The project below is an inert text fixture, never opened.
    await writeFile(xml, sample);
    const project = path.join(dir, 'NeverOpen.ap20');
    await writeFile(project, 'not a TIA project');
    const sha = createHash('sha256').update(sample).digest('hex');
    for (const verify of [false, true]) {
      const nativeArgs = args.filter(arg => arg !== '--validate-only').concat([
        '--project', project, '--process-id', String(process.pid),
        '--process-start-time-utc', '1970-01-01T00:00:00.0000000Z',
        '--baseline-sha256', 'a'.repeat(64), '--xml-sha256', '0'.repeat(64), '--compile-scope', 'block',
        '--out', path.join(dir, verify ? 'verify' : 'import'), '--timeout-ms', '1000', '--no-save',
        ...(verify ? ['--verify-only'] : [])
      ]);
      let guard = spawnSync(exe, nativeArgs, { encoding: 'utf8', timeout: 10000, windowsHide: true });
      assert.equal(guard.status, 1, guard.stdout);
      assert.match(JSON.parse(guard.stdout.trim()).error, /approved XML SHA-256/);
      nativeArgs[nativeArgs.indexOf('--xml-sha256') + 1] = sha;
      guard = spawnSync(exe, nativeArgs, { encoding: 'utf8', timeout: 10000, windowsHide: true });
      assert.equal(guard.status, 1, guard.stdout);
      assert.match(guard.stdout, /process identity changed/i);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
