import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { analyzeHmiAlarms, readAlarmRows, symbolKey } from '../dist/hmi-alarm-analysis.js';
import { createHmiSnapshot, hmiExportKey } from '../dist/hmi-export.js';

function record(id, type, attributes, parentId = 'root') {
  return { id, type, attributes, parentId, relation: type, collections: [], unreadableAttributes: [] };
}
function records() {
  return [record('root', 'Siemens.Engineering.Hmi.HmiTarget', { Name: 'Panel' }, null),
    record('conn', 'Siemens.Engineering.Hmi.Connection', { Name: 'PLC link', Station: 'Station', Partner: 'CPU' }),
    record('tag', 'Siemens.Engineering.Hmi.Tag', { Name: 'AlarmWord', Connection: 'PLC link', PlcTag: '"Alarms".Fault' }),
    record('ack', 'Siemens.Engineering.Hmi.Tag', { Name: 'Ack', Connection: 'PLC link', PlcTag: 'AckPlc' }),
    record('alarm', 'Siemens.Engineering.Hmi.DiscreteAlarm', { Name: 'Press fault', TriggerTag: 'AlarmWord', TriggerBit: 3, AcknowledgementHmiTag: 'Ack', AcknowledgementHmiBit: 0 })];
}
function site(target, softwarePath, effect, readSymbols = []) {
  return { target, softwarePath, effect, readSymbols, guard: { kind: 'symbol', symbol: 'Reset' }, network: 2, statementOrder: 1, relativePath: 'FC1.xml' };
}
const definitions = [
  { symbol: '"Alarms".Fault', aliases: ['DB10.Fault'], softwarePath: 'CPU1', datatype: 'Word', source: 'DB10.xml' },
  { symbol: '"Alarms".Fault', aliases: ['DB10.Fault'], softwarePath: 'CPU2', datatype: 'Word', source: 'other/DB10.xml' },
  { symbol: 'AckPlc', aliases: ['%M1.0'], softwarePath: 'CPU1', datatype: 'Bool', source: 'Tags.xml' }
];
const writes = [site('"Alarms".Fault', 'CPU1', { kind: 'assign', value: { kind: 'literal', value: '0' } }, ['AckPlc']),
  site('"Alarms".Fault', 'CPU2', { kind: 'assign', value: { kind: 'literal', value: '1' } })];
function analyze(extra = {}) {
  return analyzeHmiAlarms({ records: records(), definitions, writes, bindings: [{ connectionName: 'PLC link', softwarePath: 'CPU1' }], limit: 5, ...extra });
}
test('alarm trace keeps exact PLC identity, clear guards and acknowledgement consumers separate', () => {
  const result = analyze();
  const trigger = result.alarms[0].roles[0];
  assert.equal(trigger.status, 'resolved_source');
  assert.equal(trigger.bit, 3);
  assert.equal(trigger.writers.length, 1);
  assert.equal(trigger.writers[0].softwarePath, 'CPU1');
  assert.equal(trigger.clearCandidates[0].site.guard.symbol, 'Reset');
  assert.equal(result.alarms[0].roles[1].consumers.length, 1);
  assert.equal(result.alarms[0].roles[1].clearCandidates.length, 0);
});
test('missing bindings, duplicate definitions and expressions cannot become exact mappings', () => {
  assert.equal(analyze({ bindings: [] }).alarms[0].roles[0].status, 'plc_binding_required');
  assert.equal(analyze({ definitions: [...definitions, definitions[0]] }).alarms[0].roles[0].status, 'plc_symbol_ambiguous');
  const changed = records(); changed[2].attributes.PlcTag = 'Alarms.Fault + 1';
  assert.equal(analyze({ records: changed }).alarms[0].roles[0].status, 'plc_symbol_unresolved');
});
test('DB aliases and absolute tag addresses resolve without guessing DB byte layouts', () => {
  const changed = records(); changed[2].attributes.PlcTag = 'DB10.Fault'; changed[3].attributes.PlcTag = 'M1.0';
  assert.equal(analyze({ records: changed }).alarms[0].roles[0].status, 'resolved_source');
  assert.equal(analyze({ records: changed }).alarms[0].roles[1].status, 'resolved_source');
  changed[2].attributes.PlcTag = 'DB10.DBW4';
  assert.equal(analyze({ records: changed }).alarms[0].roles[0].status, 'plc_symbol_unresolved');
  assert.notEqual(symbolKey('"A.B"'), symbolKey('A.B'));
  assert.equal(symbolKey('"Alarms" . "Fault"'), symbolKey('Alarms.Fault'));
});
test('observed screen references are returned; text mentioning a tag is not a binding', () => {
  const changed = records();
  changed.push(record('button', 'Hmi.ScreenButton', { Name: 'Reset', Tag: { refId: 'ack' } }));
  changed.push(record('label', 'Hmi.ScreenText', { Name: 'Label', Text: 'Ack' }));
  const result = analyze({ records: changed, resetTagNames: ['Ack'] });
  assert.deepEqual(result.resetTags[0].screenBindings.map(r => r.id), ['button']);
});
test('selected bit writes are included while other bits and invalid bit indices are excluded', () => {
  const changed = [...writes, site('"Alarms".Fault.%X3', 'CPU1', { kind: 'coil', mode: 'reset' }),
    site('"Alarms".Fault.%X4', 'CPU1', { kind: 'coil', mode: 'set' })];
  const result = analyze({ writes: changed });
  assert.equal(result.alarms[0].roles[0].writers.length, 2);
  assert.equal(result.alarms[0].roles[0].clearCandidates.length, 2);
  const observed = records(); observed[4].attributes.TriggerBit = 16;
  assert.equal(analyze({ records: observed }).alarms[0].roles[0].status, 'invalid_or_unsupported_bit');
});
test('classic alarm columns preserve multilingual text and row evidence', () => {
  const result = readAlarmRows({ sha256: 'fixture', sheets: [{ name: 'Discrete alarms', rows: [
    { row: 1, cells: { A: 'ID', B: 'Trigger tag', C: 'Trigger bit', D: 'Event text [zh-CN]', E: 'PLC acknowledgement tag' } },
    { row: 2, cells: { A: '12', B: 'AlarmWord', C: '3', D: '压力异常', E: 'Ack' } }
  ] }] });
  assert.equal(result.records[0].attributes['Event text [zh-CN]'], '压力异常');
  assert.equal(result.records[0].attributes.AcknowledgementPlcTag, 'Ack');
  assert.equal(result.sources[result.records[0].id].row, 2);
  assert.equal(readAlarmRows({ sha256: '', sheets: [{ name: 'Unknown', rows: [] }] }).issues[0].code, 'unsupported_alarm_sheet_headers');
});

// Stored ZIP fixtures exercise the actual .NET XLSX reader without Excel or a package dependency.
function zip(parts) {
  const local = []; const central = []; let offset = 0;
  for (const [name, text] of Object.entries(parts)) {
    const data = Buffer.from(text); const filename = Buffer.from(name); let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(filename.length, 26);
    local.push(h, filename, data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(filename.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, filename); offset += h.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(parts).length, 8); end.writeUInt16LE(Object.keys(parts).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
test('MCP reads real XLSX structure and analyzes saved HMI/PLC evidence with no live core', { timeout: 60000 }, async () => {
  const serverRoot = path.resolve(import.meta.dirname, '..');
  const root = path.resolve(process.env.TIA_MCP_WORKSPACE_ROOT?.trim() || serverRoot, 'tia-exports');
  const temp = path.join(root, `.alarm-test-${randomUUID()}`);
  const identity = { projectPath: path.join(temp, 'project.ap20').toLowerCase(), hmiName: 'Panel', hmiPath: 'Panel/Runtime' };
  const snapshotFile = path.join(root, 'hmi', `${hmiExportKey(identity)}.json`);
  const client = new Client({ name: 'alarm-test', version: '1' });
  const parts = {
    'xl/workbook.xml': '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Discrete alarms" r:id="r1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>压力异常</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>ID</t></is></c><c r="B1" t="inlineStr"><is><t>Trigger tag</t></is></c><c r="C1" t="inlineStr"><is><t>Trigger bit</t></is></c><c r="D1" t="inlineStr"><is><t>Event text [zh-CN]</t></is></c></row><row r="2"><c r="A2"><v>12</v></c><c r="B2" t="inlineStr"><is><t>AlarmWord</t></is></c><c r="C2"><v>3</v></c><c r="D2" t="s"><v>0</v></c></row></sheetData></worksheet>'
  };
  try {
    await mkdir(path.join(temp, '_codex_index'), { recursive: true });
    await mkdir(path.dirname(snapshotFile), { recursive: true });
    const workbook = path.join(temp, 'alarms.xlsx'); const bytes = zip(parts); await writeFile(workbook, bytes);
    await writeFile(snapshotFile, JSON.stringify(createHmiSnapshot(identity, {
      target: { name: identity.hmiName, path: identity.hmiPath, type: 'Siemens.Engineering.Hmi.HmiTarget' },
      hmi: { schemaVersion: 1, records: records(), issues: [{ code: 'classic_hmi_alarms_unsupported' }], truncated: false,
        coverage: { sections: [{ section: 'alarms', state: 'unavailable' }] } }
    })));
    const xml = '<Document><SW.Blocks.GlobalDB><AttributeList><Name>Alarms</Name><Number>10</Number><Interface><Sections><Section Name="Static"><Member Name="Fault" Datatype="Word"/></Section></Sections></Interface></AttributeList></SW.Blocks.GlobalDB></Document>';
    await writeFile(path.join(temp, 'DB10.xml'), xml);
    const tagsXml = '<Document><SW.Tags.PlcTagTable><AttributeList><Name>Tags</Name></AttributeList><ObjectList><SW.Tags.PlcTag><AttributeList><Name>AckPlc</Name><DataTypeName>Bool</DataTypeName><LogicalAddress>%M1.0</LogicalAddress></AttributeList></SW.Tags.PlcTag></ObjectList></SW.Tags.PlcTagTable></Document>';
    await writeFile(path.join(temp, 'Tags.xml'), tagsXml);
    const index = { projectPath: identity.projectPath, generatedAt: '2026-09-19', items: [{ name: 'Alarms', number: '10', kind: 'GlobalDB', relativePath: 'DB10.xml', softwarePath: 'CPU1', sha256: createHash('sha256').update(xml).digest('hex') },
      { name: 'Tags', kind: 'Tag.Table', relativePath: 'Tags.xml', softwarePath: 'CPU1', sha256: createHash('sha256').update(tagsXml).digest('hex') }], calls: [] };
    await writeFile(path.join(temp, '_codex_index/tia-export-index.json'), JSON.stringify(index));
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(serverRoot, 'dist/index.js')], cwd: serverRoot,
      env: { ...process.env, TIA_MCP_ALLOWED_PROJECT_ROOTS: temp, TIA_MCP_LIVE_CORE_EXE: path.join(temp, 'absent.exe') } }));
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 45000 });
      if (result.structuredContent?.ok) console.log(name + ': ' + result.content[0].text.length + ' characters');
      return result.structuredContent;
    };
    const read = await call('tia_read_hmi_alarm_export', { file: workbook });
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.equal(read.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(read.records[0].attributes['Event text [zh-CN]'], '压力异常');
    const args = { ...identity, exportDir: temp, connectionBindings: [{ connectionName: 'PLC link', softwarePath: 'CPU1' }], alarmWorkbook: workbook, resetTagNames: ['Ack'] };
    const analysis = await call('tia_analyze_hmi_alarms', args);
    assert.equal(analysis.ok, true, JSON.stringify(analysis));
    assert.equal(analysis.hmiPartial, true);
    assert.equal(analysis.alarms[0].roles[0].status, 'resolved_source', JSON.stringify(analysis));
    assert.equal(analysis.resetTags[0].status, 'resolved_source', JSON.stringify(analysis));
    index.projectPath = path.join(temp, 'different.ap20');
    await writeFile(path.join(temp, '_codex_index/tia-export-index.json'), JSON.stringify(index));
    assert.equal((await call('tia_analyze_hmi_alarms', args)).ok, false);
    await writeFile(workbook, zip({ ...parts, 'xl/worksheets/sheet1.xml': parts['xl/worksheets/sheet1.xml'].replace('<v>12</v>', '<f>1+11</f><v>12</v>') }));
    assert.equal((await call('tia_read_hmi_alarm_export', { file: workbook })).ok, false);
  } finally {
    await client.close();
    assert.ok(temp.startsWith(root + path.sep));
    await rm(temp, { recursive: true, force: true });
    await rm(snapshotFile, { force: true });
  }
});
