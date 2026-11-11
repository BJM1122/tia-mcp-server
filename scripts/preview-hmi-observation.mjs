import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

// This viewer consumes an existing observation. It never attaches to Portal.
export function buildModel(document, sourceSha256, screenNames) {
  const observation = document.observation?.hmi;
  if (!Array.isArray(observation?.records)) throw new Error('Expected an HMI configuration observation.');
  const records = observation.records, byId = new Map(), children = new Map();
  for (const record of records) {
    if (!record.id || byId.has(record.id)) throw new Error('Missing or duplicate observation record ID.');
    byId.set(record.id, record);
    const list = children.get(record.parentId) ?? [];
    list.push(record); children.set(record.parentId, list);
  }
  function descendants(id, seen = new Set()) {
    if (seen.has(id)) throw new Error('Cycle in observation records.');
    seen.add(id);
    const result = [];
    for (const child of children.get(id) ?? []) result.push(child, ...descendants(child.id, seen));
    seen.delete(id); return result;
  }
  const available = records.filter(r => r.type?.endsWith('.HmiScreen'));
  const selected = screenNames?.length ? screenNames.map(name => {
    const matches = available.filter(r => r.attributes?.Name === name);
    if (matches.length !== 1) throw new Error(`Screen not uniquely found: ${name}`);
    return matches[0];
  }) : available;
  const screens = selected.map(screen => {
    const items = (children.get(screen.id) ?? []).filter(r => r.relation === 'ScreenItems').map(item => {
      const details = descendants(item.id), a = item.attributes ?? {};
      const texts = details.filter(r => r.type?.endsWith('.MultilingualTextItem') && typeof r.attributes?.Text === 'string');
      return {
        id: item.id, name: a.Name ?? item.id, type: item.type?.split('.').at(-1) ?? 'Unknown',
        x: a.Left, y: a.Top, width: a.Width, height: a.Height,
        texts: texts.map(r => ({ text: r.attributes.Text, culture: r.attributes.Culture ?? null })),
        fontSize: details.find(r => r.relation === 'Font')?.attributes?.Size,
        attributes: a, details,
        tags: [...new Set(details.map(r => r.attributes?.Tag).filter(t => typeof t === 'string'))],
        scripts: details.filter(r => typeof r.attributes?.ScriptCode === 'string').map(r => ({
          event: byId.get(r.parentId)?.attributes?.EventType ?? null, code: r.attributes.ScriptCode,
          globalCode: r.attributes.GlobalDefinitionAreaScriptCode ?? '',
        })),
      };
    });
    return { id: screen.id, name: screen.attributes.Name, number: screen.attributes.ScreenNumber,
      width: screen.attributes.Width, height: screen.attributes.Height, items };
  });
  return { identity: document.identity, sourceSha256, partial: document.usable !== true,
    coverage: observation.coverage, truncated: Boolean(observation.truncated), screens };
}

export function renderViewer(model) {
  const json = JSON.stringify(model).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; form-action 'none'; base-uri 'none'">
<title>HMI 结构浏览</title><style>
*{box-sizing:border-box}body{margin:0;font:14px 'Microsoft YaHei',system-ui;background:#f3f5f8;color:#172b45}
header{background:#102a43;color:white;padding:18px 24px}h1{font-size:21px;margin:0 0 8px}header p{margin:4px 0;color:#d7e4ef;overflow-wrap:anywhere}
nav{padding:14px 20px;display:flex;gap:8px;flex-wrap:wrap;background:white;border-bottom:1px solid #d2dce6}
button,input{font:inherit}nav button{padding:9px 14px;border:1px solid #b9c9d9;background:white;border-radius:6px;cursor:pointer}nav button[aria-current=true]{background:#146c94;color:white}
.layout{display:grid;grid-template-columns:minmax(440px,1fr) 380px;gap:18px;padding:18px}.main{min-width:0}.notice{padding:12px;background:#fff4d9;border:1px solid #e8cc80;border-radius:6px;line-height:1.7;margin-bottom:14px}
.canvas-wrap{background:white;border:1px solid #cbd5e1;padding:10px;overflow:auto}svg{display:block;width:100%;height:auto;min-width:420px;background:#fafcfe}svg text{pointer-events:none;font-family:'Microsoft YaHei',sans-serif}svg g{cursor:pointer;outline:none}svg g:focus rect,svg g:hover rect,svg g.selected rect{stroke:#ef6c00;stroke-width:3}
aside{background:white;padding:16px;border:1px solid #cbd5e1;border-radius:6px;min-width:0}h2{font-size:17px;margin:0 0 12px}h3{font-size:14px;margin:16px 0 8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f5f9;padding:12px;border-radius:5px;font:12px/1.6 Consolas,monospace;max-height:360px;overflow:auto}
.search{display:flex;gap:10px;margin:12px 0;align-items:center;flex-wrap:wrap}input{padding:9px;border:1px solid #aabccc;border-radius:5px;flex:1;min-width:180px}.items{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px;margin-top:14px}.items button{text-align:left;padding:9px;border:1px solid #cad7e3;background:white;border-radius:4px;cursor:pointer;overflow-wrap:anywhere}.muted{color:#60758a;font-size:12px}details{margin-top:14px}summary{cursor:pointer}@media(max-width:900px){.layout{grid-template-columns:1fr}aside{order:2}}
</style><header><h1>HMI 结构浏览</h1><p id="identity"></p><p>从已保存的原生控件数据生成 · 点选控件查看原始属性、变量与事件脚本 · 无设备连接</p></header>
<nav id="pages" aria-label="页面"></nav><div class="layout"><main class="main"><div class="notice">这是结构视图，非原生画面渲染或仿真。颜色、图形资源、组合关系及未读取的动态效果不完整；组合内控件坐标可能是相对坐标。按钮仅用于查看数据，不执行任何设备命令。语言标识缺失时优先显示含中文的文本，并在详情中保留所有文本。</div><h2 id="page-title"></h2><div class="canvas-wrap"><svg id="canvas" role="group" aria-label="控件结构"></svg></div><div class="search"><input id="search" placeholder="查找文字、控件名、变量或脚本" aria-label="查找控件"><span id="count"></span></div><div id="items" class="items"></div></main><aside><h2 id="selection">点选控件</h2><div id="details">可从结构图或下方控件列表中选择。</div><details><summary>来源与覆盖范围</summary><pre id="provenance"></pre></details></aside></div>
<script id="data" type="application/json">${json}</script><script>
'use strict';
const model=JSON.parse(document.getElementById('data').textContent), $=id=>document.getElementById(id), ns='http://www.w3.org/2000/svg';
let current,selected;
function plain(raw){return String(raw).replace(/<br\\s*\\/?\\s*>/gi,'\\n').replace(/<\\/p>/gi,'\\n').replace(/<[^>]*>/g,'').replace(/&(amp|lt|gt|quot|apos|nbsp|#\\d+|#x[0-9a-f]+);/gi,(all,k)=>{const table={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};if(k[0]!=='#')return table[k.toLowerCase()]??all;const n=k[1].toLowerCase()==='x'?parseInt(k.slice(2),16):Number(k.slice(1));return Number.isInteger(n)&&n>=0&&n<=0x10ffff?String.fromCodePoint(n):all;}).trim();}
function label(item){return plain((item.texts.find(t=>/[\\u3400-\\u9fff]/.test(t.text))??item.texts[0])?.text??'');}
function node(tag,attrs){const n=document.createElementNS(ns,tag);for(const [key,value]of Object.entries(attrs))n.setAttribute(key,String(value));return n;}
function section(title,value){const h=document.createElement('h3');h.textContent=title;const p=document.createElement('pre');p.textContent=typeof value==='string'?value:JSON.stringify(value,null,2);$('details').append(h,p);}
function inspect(item){selected=item.id;$('selection').textContent=item.name+' · '+item.type;$('details').replaceChildren();section('页面与位置',{screen:current.name,screenNumber:current.number,x:item.x,y:item.y,width:item.width,height:item.height});section('全部原始文本',item.texts);section('读取到的变量',item.tags);for(const script of item.scripts)section('事件 '+(script.event??'未标明'),script.globalCode+'\\n'+script.code);section('原始属性',item.attributes);const d=document.createElement('details'),s=document.createElement('summary'),p=document.createElement('pre');s.textContent='完整子记录';p.textContent=JSON.stringify(item.details,null,2);d.append(s,p);$('details').append(d);for(const g of $('canvas').children)g.classList.toggle('selected',g.dataset.id===selected);}
function list(){const q=$('search').value.toLowerCase();$('items').replaceChildren();const found=current.items.filter(i=>JSON.stringify(i).toLowerCase().includes(q));$('count').textContent=found.length+' / '+current.items.length+' 个控件';for(const i of found){const b=document.createElement('button');b.textContent=(label(i)||i.type)+' · '+i.name;b.onclick=()=>inspect(i);$('items').append(b);}}
function show(page){current=page;selected=null;$('search').value='';$('selection').textContent='点选控件';$('details').textContent='可从结构图或下方控件列表中选择。';$('page-title').textContent=page.name+' · 画面 '+page.number+' · '+page.width+' × '+page.height;const svg=$('canvas');svg.replaceChildren();svg.setAttribute('viewBox','0 0 '+(page.width||1018)+' '+(page.height||758));
for(const i of page.items){if(![i.x,i.y,i.width,i.height].every(Number.isFinite)||i.width<0||i.height<0)continue;const g=node('g',{tabindex:0,role:'button','aria-label':i.name+' '+label(i)});g.dataset.id=i.id;const button=i.type==='HmiButton',box=i.type==='HmiIOField',shape=/Rectangle|Line/.test(i.type),graphic=/Graphic|Image|Widget/.test(i.type);g.append(node('rect',{x:i.x,y:i.y,width:Math.max(2,i.width),height:Math.max(2,i.height),rx:button?4:0,fill:button?'#e2edf6':box?'#fff':shape?'#f1f5f9':'transparent',stroke:graphic?'#9c6a32':'#9fb2c4','stroke-dasharray':graphic?'5 3':'none'}));const title=node('title',{});title.textContent=i.name+' · '+i.type;g.append(title);let text=label(i)||(graphic?'图形资源未读取':box?'数值未读取':'');const t=node('text',{x:i.x+i.width/2,y:i.y+i.height/2,'text-anchor':'middle','dominant-baseline':'middle','font-size':Math.min(Number(i.fontSize)||15,Math.max(9,i.height*.6)),fill:'#213d57'});t.textContent=text;g.append(t);g.onclick=()=>inspect(i);g.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();inspect(i);}};svg.append(g);}
for(const b of $('pages').children)b.setAttribute('aria-current',String(b.dataset.id===page.id));list();}
$('identity').textContent=model.identity.projectPath+' · '+model.identity.hmiPath;
$('provenance').textContent=JSON.stringify({identity:model.identity,sourceSha256:model.sourceSha256,partial:model.partial,truncated:model.truncated,coverage:model.coverage},null,2);
for(const p of model.screens){const b=document.createElement('button');b.textContent=p.name;b.dataset.id=p.id;b.onclick=()=>show(p);$('pages').append(b);}
$('search').oninput=list;if(model.screens.length)show(model.screens[0]);
</script></html>`;
}

export async function generate(inputPath, outputPath, screenNames) {
  const raw = await readFile(inputPath);
  const model = buildModel(JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')), createHash('sha256').update(raw).digest('hex'), screenNames);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderViewer(model), 'utf8');
  return { outputPath, screens: model.screens.length, items: model.screens.reduce((n, s) => n + s.items.length, 0), sourceSha256: model.sourceSha256, partial: model.partial };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output, ...screens] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: node preview-hmi-observation.mjs observation.json output.html [exact screen names...]');
  console.log(JSON.stringify(await generate(resolve(input), resolve(output), screens), null, 2));
}
