import { z } from "zod";
import { PlanStore } from "./plan-store.js";
import { digest } from "./hmi-authoring.js";
import { designSchema, validateDesignStructure } from "./hmi-design.js";
import { projectSpecSchema } from "./hmi-project.js";
import { unifiedResourcesShape, unifiedTagDataType, validateUnifiedResources } from './hmi-unified-resources.js';

const unifiedElement=designSchema.shape.screens.element.shape.elements.element.extend({type:z.enum(['text','rectangle','button','ioField','alarmView','trendView']),
  alarmSource:z.enum(['ActiveAlarms','AlarmDefinition']).default('ActiveAlarms'),alarmFilter:z.string().max(4096).default(''),
  trendSeries:z.array(z.object({tag:z.string().min(1).max(128),label:z.string().min(1).max(128),color:z.string().regex(/^#[0-9a-fA-F]{6}$/)}).strict()).max(8).default([]),
  trendWindowSeconds:z.number().int().min(1).max(86400).default(60),trendMin:z.number().finite().default(0),trendMax:z.number().finite().default(100)
}).strict();
const unifiedScreen=designSchema.shape.screens.element.extend({elements:z.array(unifiedElement).max(500)});

export const unifiedDesignSchema = designSchema.extend({
  ...unifiedResourcesShape,
  screens:z.array(unifiedScreen).min(1).max(100),
  templates:z.array(unifiedScreen.omit({number:true,template:true})).max(20).default([]),
  adapter: z.literal("wincc-unified-v20"),
  language: z.enum(["zh-CN", "en-US", "de-DE"]).default("zh-CN"),
  startScreen: z.string().min(1).max(128),
  internalTags: z.array(z.object({ name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/),
    dataType: unifiedTagDataType,
    initialValue: z.union([z.boolean(), z.number().finite(), z.string().max(254)]).optional()
  }).strict()).max(1000).default([])
}).strict();
export const unifiedProjectSpecSchema = projectSpecSchema.pick({outputParent:true,projectName:true,deviceName:true,typeIdentifier:true})
  .extend({design:unifiedDesignSchema}).strict();

export function generateUnifiedDesign(input: unknown) {
  if (Buffer.byteLength(JSON.stringify(input) ?? "") > 20_000_000) throw new Error("Unified design exceeds 20 MB.");
  const design = unifiedDesignSchema.parse(input);
  const resolutions=['1980x1280','1920x1200','1920x1080','1680x1050','1600x1200','1440x900','1366x768','1280x1024','1280x800','1200x1920','1200x1600','1080x1980','1080x1920','1050x1680','1024x1280','1024x768','900x1440','800x1280','800x600','800x480','768x1366','768x1024','640x480','600x800','480x800','480x640','480x272','320x240','272x480','240x320','240x80','3840x2160'];
  if(!resolutions.includes(`${design.device.width}x${design.device.height}`)) throw new Error('Resolution is not in the installed V20 Unified public ScreenResolution enum.');
  validateDesignStructure(design);
  if (!design.screens.some(s=>s.name===design.startScreen)) throw new Error("Unified startScreen must resolve to a design screen.");
  const tags = new Map<string,{dataType:string;writeEnabled:boolean}>();
  for(const tag of design.internalTags) {
    if(tags.has(tag.name)) throw new Error(`Duplicate Unified tag: ${tag.name}`);
    tags.set(tag.name,{dataType:tag.dataType,writeEnabled:true});
    const value=tag.initialValue;
    if(value === undefined) continue;
    if(tag.dataType==='Bool' ? typeof value!=='boolean' : tag.dataType==='WString' ? typeof value!=='string' : typeof value!=='number') throw new Error(`Initial value type mismatch: ${tag.name}`);
    const ranges:Record<string,[number,number]>={Int:[-32768,32767],DInt:[-2147483648,2147483647],UInt:[0,65535],Word:[0,65535],UDInt:[0,4294967295],DWord:[0,4294967295]};
    const range=ranges[tag.dataType];
    if(typeof value==='number' && range && (!Number.isInteger(value) || value<range[0] || value>range[1])) throw new Error(`Initial value out of range: ${tag.name}`);
    if(tag.dataType==='Real' && Math.abs(value as number)>3.4028234663852886e38) throw new Error(`Initial value out of range: ${tag.name}`);
  }
  validateUnifiedResources(design,tags);
  const screens=design.screens.map(screen=> {
    const layout=design.templates.find(t=>t.name===screen.template);
    const elements=[...(layout?.elements ?? []),...screen.elements];
    const names=new Set<string>();
    const compiled=elements.map(element=> {
      if(names.has(element.name)) throw new Error(`Expanded layout has duplicate object name: ${screen.name}/${element.name}`);
      names.add(element.name);
      if(['alarmView','trendView'].includes(element.type) && (element.text || element.fontSize!==24 || element.foreground!=='#202b38')) throw new Error('Unified native grid typography is used; text/font/foreground overrides are not mapped.');
      if(element.type!=='alarmView' && (element.alarmFilter || element.alarmSource!=='ActiveAlarms')) throw new Error('Alarm options require an alarmView control.');
      if(element.type==='trendView') {
        if(!element.trendSeries.length || element.trendMin>=element.trendMax)throw new Error('Trend view requires series and an increasing value range.');
        const seriesTags=new Set<string>();
        for(const series of element.trendSeries) {
          if(seriesTags.has(series.tag))throw new Error('Duplicate Unified trend source.');seriesTags.add(series.tag);
          if(!['Int','DInt','UInt','UDInt','Word','DWord','Real'].includes(tags.get(series.tag)?.dataType??''))throw new Error(`Unified trend requires an exact numeric tag: ${series.tag}`);
        }
      } else if(element.trendSeries.length || element.trendWindowSeconds!==60 || element.trendMin!==0 || element.trendMax!==100)throw new Error('Trend options require a trendView control.');
      if(element.unit) throw new Error("Unified unit formatting is not mapped; use an explicit adjacent text object.");
      if(element.valueTag && !tags.has(element.valueTag)) throw new Error(`Unresolved Unified value tag: ${element.valueTag}`);
      if(element.valueTag && element.ioMode==='InputOutput' && !tags.get(element.valueTag)?.writeEnabled) throw new Error(`Unified input field requires explicit writeEnabled: ${element.valueTag}`);
      if(element.momentaryTag && (tags.get(element.momentaryTag)?.dataType!=='Bool'||!tags.get(element.momentaryTag)?.writeEnabled)) throw new Error(`Unified press/release requires an explicitly writable Bool tag: ${element.momentaryTag}`);
      const events: Array<{event:string;code:string}>=[];
      // Code is a function body. IHmiScript owns the event signature.
      if(element.navigateTo) events.push({event:'Tapped',code:`HMIRuntime.UI.SysFct.ChangeScreen(${JSON.stringify(element.navigateTo)}, "//");`});
      if(element.momentaryTag) {
        events.push({event:'Down',code:`HMIRuntime.Tags.SysFct.SetTagValue(${JSON.stringify(element.momentaryTag)}, true);`});
        events.push({event:'Up',code:`HMIRuntime.Tags.SysFct.SetTagValue(${JSON.stringify(element.momentaryTag)}, false);`});
      }
      return {...element,events};
    });
    const reset=[...new Set(elements.flatMap(e=>e.momentaryTag?[e.momentaryTag]:[]))];
    return {...screen,template:undefined,elements:compiled,
      unloadScript:reset.map(t=>`HMIRuntime.Tags.SysFct.SetTagValue(${JSON.stringify(t)}, false);`).join('\n')};
  });
  const program={adapter:design.adapter,device:design.device,language:design.language,startScreen:design.startScreen,internalTags:design.internalTags,
    connections:design.connections,externalTags:design.externalTags,alarmClasses:design.alarmClasses,discreteAlarms:design.discreteAlarms,screens};
  const json=JSON.stringify(program);
  if(Buffer.byteLength(json)>20_000_000) throw new Error("Expanded Unified program exceeds 20 MB.");
  return {program,sha256:digest(json),artifactFormat:'public_api_creation_program',nativeImportArchive:false,
    nativeAcceptanceVerified:false,runtimeTested:false,templateMode:'expanded_reusable_layout',
    limitations:['Reusable layouts expand into native screen objects; they are not native faceplates.',
      'Connection driver/property names and addresses are explicit caller inputs; device and PLC compatibility require native validation. No network is probed.',
      'Press/release and unload reset are engineering candidates; they are not safety or communications-loss guarantees.']};
}

type UnifiedProjectPayload=z.infer<typeof unifiedProjectSpecSchema>&{program:ReturnType<typeof generateUnifiedDesign>['program'];programSha256:string;runtimeSha256:string};
export class UnifiedProjectPlans {
  private pending:PlanStore<UnifiedProjectPayload>;
  constructor(now:()=>number=Date.now) {this.pending=new PlanStore({label:'Unified project',ttlMs:600_000,maxPending:10,now});}
  create(input:unknown,runtimeSha256:string) {
    if(!/^[a-f0-9]{64}$/.test(runtimeSha256)) throw new Error('Missing runtime fingerprint.');
    const spec=unifiedProjectSpecSchema.parse(input),generated=generateUnifiedDesign(spec.design);
    const {confirmToken,planSha256,expiresAt}=this.pending.issue({...spec,program:generated.program,programSha256:generated.sha256,runtimeSha256},
      {bytes:25_000_000,message:'Unified plan exceeds 25 MB.'});
    return {confirmToken,planSha256,expiresAt,operation:'create_isolated_unified_project',
      outputParent:spec.outputParent,projectName:spec.projectName,deviceName:spec.deviceName,typeIdentifier:spec.typeIdentifier,
      ...generated,compileScope:'created_device',saveProject:true,opensExistingProject:false,overwriteExisting:false,download:false};
  }
  consume(token:string,hash:string) {
    return this.pending.consume(token,hash);
  }
}
