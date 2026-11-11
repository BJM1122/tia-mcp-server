import test from 'node:test';
import assert from 'node:assert/strict';
import { generateHmiDesign, nativeReferences, nativeIdentity } from '../dist/hmi-design.js';
import { HmiImportPlans } from '../dist/hmi-import-plan.js';
import { updateNativeObject, digest } from '../dist/hmi-authoring.js';

const design = { adapter: 'wincc-classic-v20', device: {model:'offline-test-profile',width:800,height:480},
 templates: [{name:'Header',elements:[{name:'Banner',type:'rectangle',x:0,y:0,width:800,height:40}]}],
 screens: [{name:'Main',number:1,template:'Header',elements:[{name:'Title',type:'text',x:20,y:50,width:300,height:40,text:'温度 < 100 & 正常'}]},
 {name:'Diagnostics',number:2,template:'Header',elements:[]}] };
const generated = generateHmiDesign(design);
const baseline = generated.artifacts.find(a => a.name === 'Main').xml;
const candidate = updateNativeObject(baseline, digest(baseline), 'Title', {Left:30}).candidateXml;
const identity = {processId:123,processStartTimeUtc:'2026-11-01T00:00:00Z',projectPath:'C:\\test.ap20',targetPath:'HMI/RT',kind:'screen',objectPath:'Main',candidateXml:candidate,saveProject:false};
const hash = 'a'.repeat(64);

test('generates template and two native candidates with escaped text and dependency order', () => {
 assert.equal(generated.artifacts.length,3); assert.equal(generated.artifacts[0].kind,'template');
 assert.match(baseline,/温度 &lt; 100 &amp; 正常/);
 assert.deepEqual(nativeIdentity(baseline),{kind:'screen',name:'Main'});
 assert.deepEqual(nativeReferences(baseline),[{role:'Template',name:'Header'}]);
 assert.equal(generated.nativeImportVerified,false); assert.equal(generated.projectCreated,false);
});
test('rejects unsupported families, duplicate numbers/names, out-of-bounds controls and missing templates', () => {
 assert.throws(()=>generateHmiDesign({...design,adapter:'mcgspro'}));
 assert.throws(()=>generateHmiDesign({...design,screens:[design.screens[0],{...design.screens[1],number:1}]}),/Duplicate screen number/);
 assert.throws(()=>generateHmiDesign({...design,screens:[design.screens[0],{...design.screens[1],name:'Main'}]}),/Duplicate/);
 assert.throws(()=>generateHmiDesign({...design,device:{...design.device,width:200}}),/outside device/);
 assert.throws(()=>generateHmiDesign({...design,templates:[]}),/Unresolved template/);
});
test('named edits change only the selected existing scalar and reject ambiguous/unsupported edits', () => {
 assert.equal(candidate,baseline.replace('<Left>20</Left>','<Left>30</Left>'));
 assert.throws(()=>updateNativeObject(baseline,digest(baseline),'Missing',{Left:1}),/exactly one/);
 assert.throws(()=>updateNativeObject(baseline,digest(baseline),'Title',{ObjectName:'Rename'}),/Unsupported/);
 assert.throws(()=>updateNativeObject(baseline,digest(baseline),'Title',{ForeColor:'300,0,0'}),/RGB/);
});
test('exact plan diff, immutable payload, explicit hash, expiry and single-use consumption', () => {
 let now = 100000; const plans = new HmiImportPlans(()=>now);
 const input={...identity}; const plan=plans.create(input,baseline,hash,hash);
 assert.equal(plan.diff.before,'2'); assert.equal(plan.diff.after,'3');
 input.candidateXml='tampered';
 assert.throws(()=>plans.consume(plan.confirmToken,'0'.repeat(64)),/approval hash/);
 const consumed=plans.consume(plan.confirmToken,plan.planSha256);assert.equal(consumed.candidateXml,candidate);
 assert.throws(()=>plans.consume(plan.confirmToken,plan.planSha256),/consumed/);
 const expires=plans.create(identity,baseline,hash,hash);now+=600001;
 assert.throws(()=>plans.consume(expires.confirmToken,expires.planSha256),/expired/);
});
test('renaming and changed native dependencies cannot pass the replacement gate', () => {
 const plans=new HmiImportPlans();
 assert.throws(()=>plans.create({...identity,candidateXml:candidate.replace('<Name>Main</Name>','<Name>Other</Name>')},baseline,hash,hash),/identity/);
 assert.throws(()=>plans.create({...identity,candidateXml:candidate.replace('<Name>Header</Name>','<Name>Missing</Name>')},baseline,hash,hash),/references changed/);
 assert.throws(()=>plans.create({...identity,candidateXml:candidate.replace('<Number>1</Number>','<Number>2</Number>')},baseline,hash,hash),/number and device dimensions/);
 assert.throws(()=>plans.create({...identity,candidateXml:baseline},baseline,hash,hash),/No changes/);
});
