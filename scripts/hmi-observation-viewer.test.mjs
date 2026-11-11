import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, renderViewer } from './preview-hmi-observation.mjs';

const record = (id, parentId, relation, type, attributes) => ({ id, parentId, relation, type, attributes });
const fixture = () => ({ identity: { projectPath: 'test.ap20', hmiPath: 'HMI_1/HMI_RT_3' }, usable: false,
  observation: { hmi: { records: [
    record('s', null, 'Screens', 'API.HmiScreen', { Name: 'Manual', ScreenNumber: 21, Width: 1018, Height: 758 }),
    record('b', 's', 'ScreenItems', 'API.HmiButton', { Name: 'Stop', Left: 595, Top: 39, Width: 90, Height: 50 }),
    record('t', 'b', 'Text', 'API.MultilingualText', {}),
    record('z', 't', 'Items', 'API.MultilingualTextItem', { Text: '<body><p>停止</p></body>' }),
    record('e', 'b', 'EventHandlers', 'API.HmiButtonEventHandler', { EventType: 'Down' }),
    record('c', 'e', 'Script', 'API.ScriptDynamization', { ScriptCode: 'HMIRuntime.Tags.SysFct.SetBitInTag("tag",0);' }),
    record('d', 'b', 'Dynamizations', 'API.TagDynamization', { Tag: 'tag', PropertyName: 'BackColor' }),
  ], truncated: false, coverage: { unifiedReadMode: 'explicit_public_property_allowlist' } } } });

test('keeps native identities, coordinates, raw texts, tag and event evidence without running scripts', () => {
  const model = buildModel(fixture(), 'hash', ['Manual']);
  assert.equal(model.partial, true);
  assert.equal(model.sourceSha256, 'hash');
  assert.equal(model.screens.length, 1);
  const item = model.screens[0].items[0];
  assert.equal(item.x, 595);
  assert.equal(item.texts[0].text, '<body><p>停止</p></body>');
  assert.deepEqual(item.tags, ['tag']);
  assert.equal(item.scripts[0].event, 'Down');
  assert.equal(item.scripts[0].code, 'HMIRuntime.Tags.SysFct.SetBitInTag("tag",0);');
});

test('rejects missing/ambiguous screens and duplicate record IDs instead of mixing targets', () => {
  assert.throws(() => buildModel(fixture(), '', ['Missing']), /not uniquely/);
  const doc = fixture(); doc.observation.hmi.records.push(doc.observation.hmi.records[0]);
  assert.throws(() => buildModel(doc, ''), /duplicate/);
});

test('untrusted script bodies and markup cannot break out of embedded JSON', () => {
  const doc = fixture(); doc.observation.hmi.records[5].attributes.ScriptCode = '</script><script>alert(1)</script>';
  const html = renderViewer(buildModel(doc, 'hash'));
  const data = html.match(/<script id="data" type="application\/json">([\s\S]*?)<\/script>/)[1];
  assert.ok(!data.includes('<'));
  assert.equal(JSON.parse(data).screens[0].items[0].scripts[0].code, '</script><script>alert(1)</script>');
  assert.ok(html.includes("connect-src 'none'"));
  assert.ok(!html.includes('eval('));
  assert.ok(html.includes('非原生画面渲染或仿真'));
});
