import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { generateUnifiedDesign, UnifiedProjectPlans } from '../dist/hmi-unified.js';
import { UnifiedEditPlans } from '../dist/hmi-unified-edit.js';
import { previewHmiDesign } from '../dist/hmi-preview.js';

const geometry={x:10,y:10,width:100,height:30};
const design={adapter:'wincc-unified-v20',device:{model:'test-catalog-profile',width:800,height:480},startScreen:'Main',
  internalTags:[{name:'TestBit',dataType:'Bool',initialValue:false},{name:'TestValue',dataType:'Real',initialValue:12.5}],
  templates:[{name:'Navigation',elements:[{name:'Nav',type:'button',...geometry,navigateTo:'Second',text:'下一页'}]}],
  screens:[{name:'Main',number:1,template:'Navigation',elements:[{name:'Hold',type:'button',...geometry,y:80,momentaryTag:'TestBit'},
    {name:'Value',type:'ioField',...geometry,y:120,valueTag:'TestValue',ioMode:'InputOutput'}]},
    {name:'Second',number:2,elements:[]}]};
const spec={outputParent:'D:\\Projects',projectName:'UnifiedTest',deviceName:'Panel_1',typeIdentifier:'OrderNumber:EXPLICIT-TEST-ID',design};

test('Unified expands layouts into a distinct public API program with startup screen and bindings',()=>{
  const result=generateUnifiedDesign(design);
  assert.equal(result.nativeImportArchive,false); assert.equal(result.nativeAcceptanceVerified,false);
  assert.equal(result.program.screens.length,2); assert.equal(result.program.screens[0].elements.length,3);
  assert.equal(result.program.screens[0].elements[2].valueTag,'TestValue');
  assert.equal(result.program.startScreen,'Main'); assert.ok(!JSON.stringify(result).includes('Hmi.Screen.Screen'));
});
test('Unified navigation, press/release and unload scripts execute only their declared calls',()=>{
  const result=generateUnifiedDesign(design).program.screens[0],calls=[];
  const context={HMIRuntime:{UI:{SysFct:{ChangeScreen:(...args)=>calls.push(['navigate',...args])}},Tags:{SysFct:{SetTagValue:(...args)=>calls.push(['tag',...args])}}}};
  for(const element of result.elements)for(const event of element.events)vm.runInNewContext(event.code,context);
  vm.runInNewContext(result.unloadScript,context);
  assert.deepEqual(calls,[['navigate','Second','//'],['tag','TestBit',true],['tag','TestBit',false],['tag','TestBit',false]]);
  const attack=structuredClone(design);attack.screens[1].name='Name"); throw new Error("bad");("';attack.templates[0].elements[0].navigateTo=attack.screens[1].name;
  const candidate=generateUnifiedDesign(attack);vm.runInNewContext(candidate.program.screens[0].elements[0].events[0].code,context);
  assert.deepEqual(calls.at(-1),['navigate',attack.screens[1].name,'//']);
});
test('Unified rejects unresolved bindings, wrong command type, duplicate inherited identity and unsupported resolution',()=>{
  const missing=structuredClone(design);missing.internalTags=[];assert.throws(()=>generateUnifiedDesign(missing),/Bool|Unresolved/);
  const wrong=structuredClone(design);wrong.internalTags[0]={name:'TestBit',dataType:'Real'};assert.throws(()=>generateUnifiedDesign(wrong),/Bool/);
  const duplicate=structuredClone(design);duplicate.screens[0].elements[0].name='Nav';assert.throws(()=>generateUnifiedDesign(duplicate),/duplicate object/);
  assert.throws(()=>generateUnifiedDesign({...design,startScreen:'Missing'}),/startScreen/);
  assert.throws(()=>generateUnifiedDesign({...design,device:{...design.device,width:801}}),/Resolution/);
  assert.throws(()=>generateUnifiedDesign({...design,adapter:'wincc-classic-v20'}));
});
test('Unified tag initial values are typed and range checked before a plan',()=>{
  for(const tag of [{name:'TestBit',dataType:'Bool',initialValue:1},{name:'X',dataType:'Int',initialValue:32768},{name:'X',dataType:'DInt',initialValue:1.25},{name:'X',dataType:'Real',initialValue:1e99}]) {
    assert.throws(()=>generateUnifiedDesign({...design,internalTags:[tag]}),/Initial value/);
  }
  assert.throws(()=>generateUnifiedDesign({...design,internalTags:[...design.internalTags,design.internalTags[0]]}),/Duplicate/);
});
test('Unified creation approval is immutable, hash-bound, expiring and consumed once',()=>{
  let now=0;const plans=new UnifiedProjectPlans(()=>now),input=structuredClone(spec),p=plans.create(input,'a'.repeat(64));
  input.design.startScreen='Second';assert.equal(p.program.startScreen,'Main');assert.equal(p.compileScope,'created_device');
  assert.throws(()=>plans.consume(p.confirmToken,'b'.repeat(64)),/hash mismatch/);
  const saved=plans.consume(p.confirmToken,p.planSha256);assert.equal(saved.design.startScreen,'Main');
  assert.throws(()=>plans.consume(p.confirmToken,p.planSha256),/consumed/);
  const exp=plans.create(spec,'a'.repeat(64));now=600001;assert.throws(()=>plans.consume(exp.confirmToken,exp.planSha256),/expired/);
});
const edit={processId:42,processStartTimeUtc:'2026-11-01T00:00:00Z',projectPath:'D:\\Projects\\P.ap20',targetPath:'Panel/Runtime',screenPath:'Group/Main',objectName:'Label',language:'zh-CN',properties:{Text:'新标题'},saveProject:false};
const baseline={objectType:'Siemens.Engineering.HmiUnified.UI.Widgets.HmiTextBox',properties:{Left:10,Top:10,Width:100,Height:30,Text:'原标题',BackColor:'#FFFFFFFF',FontSize:24},dynamicProperties:[],screenWidth:800,screenHeight:480,baselineSha256:'a'.repeat(64)};
test('Unified scoped edit binds exact identity and preserves a complete immutable recovery baseline',()=>{
  const plans=new UnifiedEditPlans(),original=structuredClone(baseline),p=plans.create(edit,original,'b'.repeat(64));
  original.properties.Text='later mutation';assert.deepEqual(p.diff,[{property:'Text',before:'原标题',after:'新标题'}]);
  assert.equal(p.identity.screenPath,'Group/Main');assert.equal(p.compileScope,'entire_hosting_device');assert.equal(p.saveProject,false);
  assert.throws(()=>plans.consume(p.confirmToken,'0'.repeat(64)),/hash mismatch/);
  const saved=plans.consume(p.confirmToken,p.planSha256);assert.equal(saved.baseline.properties.Text,'原标题');
  assert.throws(()=>plans.consume(p.confirmToken,p.planSha256),/consumed/);
});
test('Unified scoped edit rejects dynamic properties, unknown properties, empty changes and out-of-bounds geometry',()=>{
  const plans=new UnifiedEditPlans();
  assert.throws(()=>plans.create(edit,{...baseline,dynamicProperties:['Text']},'b'.repeat(64)),/dynamic/);
  assert.throws(()=>plans.create({...edit,properties:{FontSize:30}},{...baseline,dynamicProperties:['Font.Size']},'b'.repeat(64)),/dynamic/);
  assert.throws(()=>plans.create({...edit,properties:{Delete:true}},baseline,'b'.repeat(64)));
  assert.throws(()=>plans.create({...edit,properties:{Left:750}},baseline,'b'.repeat(64)),/bounds/);
  assert.throws(()=>plans.create({...edit,properties:{Text:'原标题'}},baseline,'b'.repeat(64)),/No changes/);
  assert.throws(()=>plans.create({...edit,properties:{ForeColor:'#FF000000'}},baseline,'b'.repeat(64)),/unavailable/);
  const color=plans.create({...edit,properties:{BackColor:'#ffaabbcc'}},baseline,'b'.repeat(64));assert.equal(color.diff[0].after,'#FFAABBCC');
});
test('Unified preview accepts the separate adapter and contains no equipment connection',()=>{
  const preview=previewHmiDesign(design);assert.equal(preview.networkConnections,false);assert.equal(preview.tiaRuntimeSimulation,false);
  assert.match(preview.html,/wincc-unified-v20/);assert.match(preview.html,/12.5/);
});

const connection={name:'CellPlc',communicationDriver:'EXPLICIT_DRIVER_FROM_CATALOG',initialAddress:'EXPLICIT_ADDRESS',disabledAtStartup:true,driverProperties:[{name:'EXPLICIT_DRIVER_PROPERTY',value:'EXPLICIT_VALUE'}]};
const externalTag={name:'AlarmBits',dataType:'Word',connection:'CellPlc',accessMode:'AbsoluteAccess',address:'DB10.DBW0',writeEnabled:false};
const alarmClass={name:'ProcessFaults',priority:100,stateMachine:'RaiseClearRequiresAcknowledgement'};
const alarm={name:'CellFault',id:1001,alarmClass:'ProcessFaults',priority:100,triggerTag:'AlarmBits',triggerBit:15,text:'单元故障'};
test('Unified resources bind exact connection, access mode and alarm bit without guessing driver settings',()=>{
  const result=generateUnifiedDesign({...design,connections:[connection],externalTags:[externalTag],alarmClasses:[alarmClass],discreteAlarms:[alarm]});
  assert.equal(result.program.connections[0].disabledAtStartup,true);
  assert.equal(result.program.externalTags[0].address,'DB10.DBW0');
  assert.equal(result.program.discreteAlarms[0].triggerBit,15);
  assert.equal(result.program.discreteAlarms[0].triggerMode,'OnRisingEdge');
});
test('Unified external tags reject missing connections and ambiguous absolute/symbolic addresses',()=>{
  assert.throws(()=>generateUnifiedDesign({...design,externalTags:[externalTag]}),/Unresolved Unified connection/);
  assert.throws(()=>generateUnifiedDesign({...design,connections:[connection],externalTags:[{...externalTag,plcTag:'Other'}]}),/exactly the address/);
  assert.throws(()=>generateUnifiedDesign({...design,connections:[connection],externalTags:[{...externalTag,name:'TestBit'}]}),/Duplicate Unified tag/);
  assert.throws(()=>generateUnifiedDesign({...design,connections:[{...connection,driverProperties:[{name:'Password',value:'never-include'}]}]}));
});
test('Unified writing widgets require explicit write permission on the exact external tag',()=>{
  const input=structuredClone(design);input.connections=[connection];input.externalTags=[externalTag];input.screens[0].elements[1].valueTag='AlarmBits';
  assert.throws(()=>generateUnifiedDesign(input),/explicit writeEnabled/);
  input.externalTags[0]={...externalTag,writeEnabled:true};assert.equal(generateUnifiedDesign(input).program.externalTags[0].writeEnabled,true);
});
test('Unified alarm resources reject invalid bit widths, duplicate IDs and unresolved alarm classes',()=>{
  const input={...design,connections:[connection],externalTags:[externalTag],alarmClasses:[alarmClass],discreteAlarms:[alarm]};
  assert.throws(()=>generateUnifiedDesign({...input,discreteAlarms:[{...alarm,triggerBit:16}]}),/trigger tag\/bit/);
  assert.throws(()=>generateUnifiedDesign({...input,discreteAlarms:[alarm,{...alarm,name:'Other'}]}),/Duplicate Unified alarm/);
  assert.throws(()=>generateUnifiedDesign({...input,alarmClasses:[]}),/Unresolved Unified alarm class/);
  assert.throws(()=>generateUnifiedDesign({...input,discreteAlarms:[{...alarm,triggerTag:'TestValue'}]}),/trigger tag\/bit/);
});
test('Unified alarm view remains distinct from native text widgets and preview does not claim live alarms',()=>{
  const input=structuredClone(design);input.screens[1].elements=[{name:'Alarms',type:'alarmView',x:10,y:10,width:700,height:350,alarmSource:'ActiveAlarms'}];
  const result=generateUnifiedDesign(input);assert.equal(result.program.screens[1].elements[0].type,'alarmView');
  assert.match(previewHmiDesign(input).html,/无实时状态/);
  input.screens[1].elements[0].fontSize=40;assert.throws(()=>generateUnifiedDesign(input),/native grid typography/);
});
test('Unified realtime trend resolves exact numeric sources and validates ranges before native creation',()=>{
  const input=structuredClone(design);input.screens[1].elements=[{name:'Trend',type:'trendView',x:10,y:10,width:700,height:350,trendMin:-10,trendMax:200,trendWindowSeconds:120,trendSeries:[{tag:'TestValue',label:'温度',color:'#33AACC'}]}];
  const trend=generateUnifiedDesign(input).program.screens[1].elements[0];assert.equal(trend.trendSeries[0].tag,'TestValue');
  assert.equal(trend.trendWindowSeconds,120);assert.match(previewHmiDesign(input).html,/无实时采样/);
  const bad=structuredClone(input);bad.screens[1].elements[0].trendSeries[0].tag='TestBit';assert.throws(()=>generateUnifiedDesign(bad),/numeric tag/);
  bad.screens[1].elements[0].trendSeries=trend.trendSeries;bad.screens[1].elements[0].trendMin=200;assert.throws(()=>generateUnifiedDesign(bad),/increasing value range/);
});
