import { designSchema, generateHmiDesign } from "./hmi-design.js";
import { unifiedDesignSchema, generateUnifiedDesign } from "./hmi-unified.js";

export function previewHmiDesign(input: unknown) {
  const unified = (input as {adapter?:string})?.adapter === 'wincc-unified-v20';
  const design = unified ? unifiedDesignSchema.parse(input) : designSchema.parse(input);
  if(unified) generateUnifiedDesign(design); else generateHmiDesign(design);
  // Prevent design strings from escaping the JSON script element in local HTML.
  const json = JSON.stringify(design).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HMI offline preview</title><style>
body{margin:0;background:#17212b;color:#eef3f8;font:14px system-ui}header{padding:16px;display:flex;gap:16px;align-items:center}select{padding:8px}main{overflow:auto;padding:16px}.screen{position:relative;overflow:hidden;box-shadow:0 0 0 1px #789} .element{position:absolute;box-sizing:border-box;display:flex;align-items:center;white-space:pre-wrap;overflow:hidden}button.element{border:1px solid #64748b;border-radius:4px;cursor:pointer;touch-action:none}button:active{filter:brightness(.85)}input{width:100%;height:100%;box-sizing:border-box;font:inherit}footer{padding:16px;color:#b8c8d8}output{font-family:monospace}
</style><header><strong>HMI 离线交互预览</strong><select id="pages"></select><span>无设备连接 · 非 TIA 仿真 · 变量仅保存在本页</span></header><main><div id="screen" class="screen"></div></main><footer>预览标签：<output id="tags"></output></footer>
<script id="design" type="application/json">${json}</script><script>
'use strict';
const design=JSON.parse(document.getElementById('design').textContent), tags=Object.create(null), active=new Map();
for(const tag of design.internalTags??[])tags[tag.name]=tag.initialValue??(tag.dataType==='Bool'?false:tag.dataType==='WString'?'':0);
for(const tag of design.externalTags??[])tags[tag.name]=tag.dataType==='Bool'?false:tag.dataType==='WString'?'':0;
const screen=document.getElementById('screen'), pages=document.getElementById('pages');
function refresh(){document.getElementById('tags').textContent=JSON.stringify(tags);document.querySelectorAll('input[data-tag]').forEach(i=>{if(i.type==='checkbox')i.checked=Boolean(tags[i.dataset.tag]);else if(document.activeElement!==i)i.value=tags[i.dataset.tag]??(i.type==='text'?'':0);});}
function release(){for(const tag of active.values())tags[tag]=design.adapter==='wincc-unified-v20'?false:0;active.clear();refresh();}
function releasePointer(e){const tag=active.get(e.pointerId);active.delete(e.pointerId);if(tag && ![...active.values()].includes(tag))tags[tag]=design.adapter==='wincc-unified-v20'?false:0;refresh();}
function show(name){release();const page=design.screens.find(p=>p.name===name);pages.value=name;screen.replaceChildren();screen.style.width=design.device.width+'px';screen.style.height=design.device.height+'px';screen.style.background=page.background;
const template=design.templates.find(t=>t.name===page.template);
for(const item of [...(template?.elements??[]),...page.elements]){const el=document.createElement(item.type==='button'?'button':'div');el.className='element';Object.assign(el.style,{left:item.x+'px',top:item.y+'px',width:item.width+'px',height:item.height+'px',fontSize:item.fontSize+'px',color:item.foreground,background:item.transparent?'transparent':item.background});el.title=item.name;
if(item.type==='text'||item.type==='button')el.textContent=item.text;
if(item.navigateTo)el.addEventListener('click',()=>show(item.navigateTo));
if(item.momentaryTag){el.addEventListener('pointerdown',e=>{el.setPointerCapture(e.pointerId);active.set(e.pointerId,item.momentaryTag);tags[item.momentaryTag]=design.adapter==='wincc-unified-v20'?true:1;refresh();});for(const event of ['pointerup','pointercancel','lostpointercapture'])el.addEventListener(event,releasePointer);}
if(item.type==='ioField'){const i=document.createElement('input'),kind=[...(design.internalTags??[]),...(design.externalTags??[])].find(t=>t.name===item.valueTag)?.dataType;i.type=kind==='Bool'?'checkbox':kind==='WString'?'text':'number';i.dataset.tag=item.valueTag;i.value=tags[item.valueTag]??(i.type==='text'?'':0);i.checked=Boolean(tags[item.valueTag]);i.readOnly=item.ioMode==='Output';if(i.type==='checkbox')i.disabled=item.ioMode==='Output';i.setAttribute('aria-label',item.name);i.addEventListener('change',()=>{if(item.ioMode==='Output')return;if(i.type==='checkbox')tags[item.valueTag]=i.checked;else if(i.type==='text')tags[item.valueTag]=i.value;else if(Number.isFinite(Number(i.value)))tags[item.valueTag]=Number(i.value);refresh();});el.append(i);if(item.unit){const unit=document.createElement('span');unit.textContent=item.unit;el.append(unit);}}
if(item.type==='alarmView'){el.style.fontSize='16px';el.style.alignItems='flex-start';el.style.overflow='auto';el.textContent='报警配置预览（无实时状态，不执行原生筛选）'+String.fromCharCode(10)+(design.discreteAlarms??[]).map(a=>a.id+' | '+a.text+' | '+a.triggerTag+'.'+a.triggerBit).join(String.fromCharCode(10));}
if(item.type==='trendView'){el.style.fontSize='16px';el.style.alignItems='flex-start';el.textContent='趋势配置预览（无实时采样）'+String.fromCharCode(10)+'时间窗 '+item.trendWindowSeconds+' s / 量程 '+item.trendMin+' ~ '+item.trendMax+String.fromCharCode(10)+item.trendSeries.map(s=>s.label+' → '+s.tag).join(String.fromCharCode(10));}
screen.append(el);}refresh();}
for(const page of design.screens){const option=document.createElement('option');option.value=page.name;option.textContent=page.name;pages.append(option);}pages.addEventListener('change',()=>show(pages.value));window.addEventListener('blur',release);document.addEventListener('visibilitychange',()=>{if(document.hidden)release();});show(design.startScreen??design.screens[0].name);
</script></html>`;
  return { html, offlineOnly: true, networkConnections: false, tiaRuntimeSimulation: false, nativeVisualMatchVerified: false };
}
