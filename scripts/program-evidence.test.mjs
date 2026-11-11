import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeExecutionBlock, buildExecutionModel, queryExecutionSymbol } from '../dist/execution-model.js';
import { ProgramAnalysisCache, boundProgramEvidence, graphContext } from '../dist/program-evidence.js';

const symbol = (id, name) => `<Access Scope="GlobalVariable" UId="${id}"><Symbol><Component Name="${name}"/></Symbol></Access>`;
const literal = (id, n) => `<Access Scope="LiteralConstant" UId="${id}"><Constant><ConstantType>Int</ConstantType><ConstantValue>${n}</ConstantValue></Constant></Access>`;
const wire = (...ends) => `<Wire UId="${wire.id++}">${ends.join('')}</Wire>`;
wire.id = 100;
const pin = (id, name) => `<NameCon UId="${id}" Name="${name}"/>`;
const ident = id => `<IdentCon UId="${id}"/>`;
const condition = `<FlgNet><Parts>${symbol(1, 'StationB.State')}${literal(2, 7)}${symbol(3, 'Fault')}${symbol(4, 'Enabled')}
<Part Name="Contact" UId="10"/><Part Name="Eq" UId="11"/><Part Name="Contact" UId="12"><Negated Name="operand"/></Part>
<Part Name="TrCoil" UId="13"/></Parts><Wires>
${wire('<Powerrail/>', pin(10, 'in'))}${wire(ident(4), pin(10, 'operand'))}${wire(pin(10, 'out'), pin(11, 'pre'))}
${wire(ident(1), pin(11, 'in1'))}${wire(ident(2), pin(11, 'in2'))}${wire(pin(11, 'out'), pin(12, 'in'))}
${wire(ident(3), pin(12, 'operand'))}${wire(pin(12, 'out'), pin(13, 'in'))}</Wires></FlgNet>`;
const edge = (a, b) => `<Connection><NodeFrom>${a}</NodeFrom><NodeTo>${b}</NodeTo><LinkType>Direct</LinkType></Connection>`;
function graph(name = 'Conveyor', transition = '92') {
  return `<Document><Sequence><Step Number="11" Name="Inspect" Init="true"><Actions><Action Qualifier="S"><Token Text="Latch"/></Action></Actions></Step>
<Step Number="22" Name="Return" Init="false"><Actions><Action Qualifier="N" Interlock="true"><Token Text="Command:=9"/></Action></Actions></Step>
<Branch Number="8"/><Transition Number="${transition}" Name="Exit" ProgrammingLanguage="LAD">${condition}</Transition>
${edge('<StepRef Number="11"/>', '<BranchRef Number="8" In="0"/>')}
${edge('<BranchRef Number="8" Out="0"/>', `<TransitionRef Number="${transition}"/>`)}
${edge(`<TransitionRef Number="${transition}"/>`, '<StepRef Number="22"/>')}</Sequence></Document>`;
}
const source = xml => ({ xml, name: 'Conveyor', kind: 'FB', number: '87', language: 'GRAPH' });

test('GRAPH preserves topology, action qualifiers, comparison pre and negated contacts', () => {
  const result = analyzeExecutionBlock(source(graph()));
  assert.equal(result.coverage.level, 'conservative');
  const seq = result.graph[0];
  assert.deepEqual(seq.steps[0].exits, [{ transition: 'Transition:92', nextSteps: ['Step:22'] }]);
  assert.equal(seq.steps[0].actions[0].qualifier, 'S');
  assert.equal(seq.steps[1].actions[0].interlocked, true);
  assert.equal(seq.transitions[0].condition.coverage, 'exact');
  const guard = JSON.stringify(seq.transitions[0].condition.guard);
  for (const expected of ['Enabled', 'StationB.State', 'Fault', '"value":"7"', '"kind":"not"']) assert.ok(guard.includes(expected), expected);
  assert.equal(result.writeSites.length, 2);
  assert.ok(result.writeSites.every(w => w.coverage === 'conservative' && w.guard.kind !== 'literal'), 'GRAPH writes must remain conditional candidates');
  const context = graphContext(result, { transition: '92' }, 20);
  assert.equal(context.status, 'resolved');
  assert.deepEqual(context.sequences[0].steps.map(s => s.number), ['11', '22']);
  assert.deepEqual(context.sequences[0].branches.map(b => b.number), ['8']);
  assert.equal(context.sequences[0].connections.length, 3);
  assert.equal(context.sequences[0].connections[1].fromPort, '0');
  assert.equal(context.writeSites.length, 2);
});

test('GRAPH token actions enter the shared index with exact step, effect, source line and interlock reads', () => {
  const xml = `<Document><Sequence><Step Number="4" Name="Reset">
<Actions>
<Action Qualifier="S"><Token Text="&quot;Alarms&quot;.Fault"/></Action>
<Action Qualifier="R" Event="S1" Interlock="true"><Token Text="&quot;Alarms&quot;.Fault"/></Action>
<Action Qualifier="N"><Token Text="&quot;Alarms&quot;.Code"/><Token Text=":="/><Token Text="0"/><Token Text="&#xA;"/></Action>
<Action Qualifier="N"><Token Text="&quot;Output&quot;"/><Token Text=":="/><Token Text="&quot;Input&quot;"/></Action>
</Actions><Interlock>${condition}</Interlock></Step></Sequence></Document>`;
  const block = { ...source(xml), softwarePath: 'CPU1', relativePath: 'FB87.xml' };
  const result = analyzeExecutionBlock(block);
  assert.equal(result.writeSites.length, 4);
  const [set, reset, assignment, copy] = result.writeSites;
  assert.equal(set.effect.mode, 'set');
  assert.equal(reset.effect.mode, 'reset');
  assert.equal(reset.graphAction.event, 'S1');
  assert.equal(reset.graphAction.step, '4');
  assert.equal(reset.graphAction.action, 2);
  assert.equal(reset.xmlLine, 4);
  assert.ok(reset.readSymbols.includes('Enabled'));
  assert.ok(JSON.stringify(reset.guard).includes('GRAPH event S1'));
  assert.equal(assignment.effect.value.value, '0');
  assert.ok(copy.readSymbols.includes('"Input"'));
  const model = buildExecutionModel([block]);
  const traced = queryExecutionSymbol(model, 'Alarms.Fault', { match: 'exact' });
  assert.equal(traced.writes.length, 2);
  assert.ok(traced.writes.every(w => w.sourceKind === 'GRAPH' && w.softwarePath === 'CPU1'));
  assert.equal(queryExecutionSymbol(model, 'Input', { match: 'exact' }).writes.length, 1);
});

test('timed, indirect and call actions stay explicitly unsupported and local writes retain scope', () => {
  const xml = `<Document><Sequence><Step Number="4" Name="Wait"><Actions>
<Action Qualifier="D"><Token Text="Delayed"/><Token Text="T#2s"/></Action>
<Action Qualifier="N"><Token Text="Data[Index]:=1"/></Action>
<Action Qualifier="N"><Token Text="CALL Foo()"/></Action>
<Action Qualifier="R"><Token Text="#LocalFault"/></Action>
<Action Qualifier="N"><Token Text="//DisabledTarget"/><Token Text="&#10;"/></Action>
<Action/>
</Actions></Step></Sequence></Document>`;
  const result = analyzeExecutionBlock(source(xml));
  assert.equal(result.writeSites.length, 1);
  assert.equal(result.writeSites[0].targetScope, 'LocalVariable');
  assert.ok(result.writeSites[0].normalizedTarget.includes('fb:87::localfault'));
  assert.equal(result.coverage.issues.filter(i => i.includes('unsupported action')).length, 3);
});

test('GRAPH sequence identity disambiguates duplicate numbers and unknown conditions stay unknown', () => {
  const doubled = graph() + graph('Other');
  const result = analyzeExecutionBlock(source(doubled));
  assert.equal(graphContext(result, { step: '11' }, 20).status, 'ambiguous');
  assert.equal(graphContext(result, { step: '11', sequence: 2 }, 20).status, 'resolved');
  const unsupported = analyzeExecutionBlock(source(graph().replace('Name="Eq"', 'Name="VendorOperation"')));
  assert.equal(unsupported.graph[0].transitions[0].condition.coverage, 'unsupported');
  assert.equal(boundProgramEvidence(result, 1).truncated, true);
  assert.equal(graphContext(result, { sequence: 1 }, 1).truncated, true);
});

test('analysis cache keys include source bytes and owner identity, with bounded eviction', () => {
  const cache = new ProgramAnalysisCache(1000000, 1);
  assert.equal(cache.analyze(source(graph())).cacheHit, false);
  assert.equal(cache.analyze(source(graph())).cacheHit, true);
  assert.equal(cache.analyze({ ...source(graph()), name: 'DifferentOwner' }).cacheHit, false);
  assert.equal(cache.analyze(source(graph())).cacheHit, false);
  assert.equal(cache.analyze(source(graph('Conveyor', '93'))).cacheHit, false);
  const timed = value => source(graph().replace('<Document>', `<Document><DocumentInfo><Created>${value}</Created></DocumentInfo>`));
  const before = cache.analyze(timed('2026-01-01')).result;
  const after = cache.analyze(timed('2026-01-02'));
  assert.equal(after.cacheHit, true);
  assert.notEqual(after.result.sha256, before.sha256);
});
