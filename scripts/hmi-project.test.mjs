import test from 'node:test';
import assert from 'node:assert/strict';
import { HmiProjectPlans, projectSpecSchema } from '../dist/hmi-project.js';
import { generateHmiDesign } from '../dist/hmi-design.js';
import { editNativeText } from '../dist/hmi-text-edit.js';
import { digest } from '../dist/hmi-authoring.js';
import { previewHmiDesign } from '../dist/hmi-preview.js';

const design = {adapter:'wincc-classic-v20',device:{model:'explicit-test-model',width:800,height:480},screens:[
 {name:'Main',number:1,elements:[{name:'Navigate',type:'button',x:10,y:10,width:120,height:40,text:'诊断',navigateTo:'Diagnostics'}]},
 {name:'Diagnostics',number:2,elements:[{name:'Back',type:'button',x:10,y:10,width:120,height:40,text:'返回',navigateTo:'Main'}]}
]};
const spec = {outputParent:'D:\\Projects',projectName:'IsolatedTest',deviceName:'Panel_1',typeIdentifier:'OrderNumber:EXPLICIT-CATALOG-ID',design};

test('project plan binds destination, catalog identifier, exact generated artifacts and one-use approval',()=>{
 let now=0;const plans=new HmiProjectPlans(()=>now);const plan=plans.create(spec,'a'.repeat(64));
 assert.equal(plan.overwriteExisting,false);assert.equal(plan.opensExistingProject,false);assert.equal(plan.download,false);
 assert.equal(plan.artifacts.length,2);assert.equal(plan.nativeAcceptanceVerified,false);
 assert.throws(()=>plans.consume(plan.confirmToken,'b'.repeat(64)),/hash mismatch/);
 const payload=plans.consume(plan.confirmToken,plan.planSha256);assert.equal(payload.typeIdentifier,spec.typeIdentifier);
 assert.throws(()=>plans.consume(plan.confirmToken,plan.planSha256),/consumed/);
 const expired=plans.create(spec,'a'.repeat(64));now=600001;
 assert.throws(()=>plans.consume(expired.confirmToken,expired.planSha256),/expired/);
});
test('new project name cannot traverse, use a device-reserved name or silently accept another vendor',()=>{
 for(const projectName of ['../Other','CON','A.','A '])assert.throws(()=>projectSpecSchema.parse({...spec,projectName}));
 assert.throws(()=>projectSpecSchema.parse({...spec,typeIdentifier:'file:///secret'}));
 assert.throws(()=>projectSpecSchema.parse({...spec,design:{...design,adapter:'mcgse'}}));
});
test('cyclic navigation generates explicit events and validates screen references',()=>{
 const result=generateHmiDesign(design);
 assert.match(result.artifacts[0].xml,/<Name>ActivateScreen<\/Name>/);
 assert.ok(result.artifacts[0].dependencies.some(d=>d.kind==='screen'&&d.name==='Diagnostics'));
 const invalid=structuredClone(design);invalid.screens[0].elements[0].navigateTo='Missing';
 assert.throws(()=>generateHmiDesign(invalid),/Navigation/);
});
test('text editing changes one language/composition while preserving events and opposite button state',()=>{
 const xml=generateHmiDesign(design).artifacts[0].xml;
 const result=editNativeText(xml,digest(xml),'Navigate','zh-CN','诊断 & I/O','TextOff');
 assert.match(result.candidateXml,/诊断 &amp; I\/O/);
 assert.match(result.candidateXml,/<p>诊断<\/p>/);
 const event=xml.slice(xml.indexOf('<Hmi.Event.Event'),xml.indexOf('</Hmi.Event.Event>')+18);
 assert.ok(result.candidateXml.includes(event));
 assert.throws(()=>editNativeText(xml,digest(xml),'Navigate','de-DE','text','TextOff'),/Exactly one existing/);
 assert.throws(()=>editNativeText(xml,'0'.repeat(64),'Navigate','zh-CN','x','TextOff'),/hash mismatch/);
});
test('bindings and momentary commands require native resources with exact names and intact hashes',()=>{
 const bound=structuredClone(design);
 bound.screens[0].elements=[{name:'Value',type:'ioField',valueTag:'InternalValue',x:0,y:0,width:150,height:30},
 {name:'Command',type:'button',momentaryTag:'InternalCommand',x:0,y:40,width:150,height:40,text:'Hold'}];
 const plans=new HmiProjectPlans();
 assert.throws(()=>plans.create({...spec,design:bound},'a'.repeat(64)),/typed native tag/);
 const xml='<Document><Engineering version="V20"/><Hmi.Tag.TagTable ID="0"><AttributeList><Name>AuthoringTags</Name></AttributeList><ObjectList><Hmi.Tag.Tag ID="1"><AttributeList><Name>InternalValue</Name><DataType>DInt</DataType></AttributeList></Hmi.Tag.Tag><Hmi.Tag.Tag ID="2"><AttributeList><Name>InternalCommand</Name><DataType>Bool</DataType></AttributeList></Hmi.Tag.Tag></ObjectList></Hmi.Tag.TagTable></Document>';
 const resource={kind:'tagTable',name:'AuthoringTags',xml,sha256:digest(xml)};
 const plan=plans.create({...spec,design:bound,resources:[resource]},'a'.repeat(64));
 assert.equal(plan.artifacts[0].kind,'tagTable');
 assert.match(plan.artifacts[1].xml,/<Name>Press<\/Name>/);assert.match(plan.artifacts[1].xml,/<Name>Release<\/Name>/);
 assert.match(plan.artifacts[1].xml,/<Mode>Output<\/Mode>/);
 assert.throws(()=>plans.create({...spec,design:bound,resources:[{...resource,sha256:'0'.repeat(64)}]},'a'.repeat(64)),/hash/);
});
test('offline preview escapes script-breakout strings and identifies the lack of runtime connection',()=>{
 const attack=structuredClone(design);attack.screens[0].elements[0].text='</script><script>alert(1)</script>';
 const preview=previewHmiDesign(attack);
 assert.equal(preview.networkConnections,false);assert.equal(preview.tiaRuntimeSimulation,false);
 assert.ok(!preview.html.includes('</script><script>alert(1)'));
 assert.match(preview.html,/\\u003c\/script\\u003e/);
});
test('isolated project can generate internal tags without an existing native or visual template',()=>{
 const bound=structuredClone(design);bound.screens[0].elements=[{name:'TestCommand',type:'button',momentaryTag:'TestBit',x:0,y:0,width:120,height:40}];
 const plans=new HmiProjectPlans();
 const plan=plans.create({...spec,design:bound,internalTags:[{name:'TestBit',dataType:'Bool'}]},'a'.repeat(64));
 assert.equal(plan.artifacts[0].kind,'tagTable');assert.match(plan.artifacts[0].xml,/<DataType>Bool<\/DataType>/);
 assert.throws(()=>plans.create({...spec,design:bound,internalTags:[{name:'TestBit',dataType:'Real'}]},'a'.repeat(64)),/Boolean tag/);
 assert.throws(()=>plans.create({...spec,internalTags:[{name:'X',dataType:'Bool'},{name:'X',dataType:'Bool'}]},'a'.repeat(64)),/Ambiguous native tag/);
});
