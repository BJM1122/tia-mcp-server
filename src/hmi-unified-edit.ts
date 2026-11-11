import { z } from 'zod';
import { PlanStore } from './plan-store.js';

export const unifiedIdentitySchema={processId:z.number().int().positive(),processStartTimeUtc:z.string().datetime({offset:true}),projectPath:z.string().min(1),targetPath:z.string().min(1),screenPath:z.string().min(1),objectName:z.string().min(1),language:z.enum(['zh-CN','en-US','de-DE']).default('zh-CN')};
export const unifiedPropertiesSchema=z.object({Left:z.number().int().min(0).max(8192).optional(),Top:z.number().int().min(0).max(8192).optional(),
  Width:z.number().int().min(1).max(8192).optional(),Height:z.number().int().min(1).max(8192).optional(),
  BackColor:z.string().regex(/^#[0-9a-fA-F]{8}$/).optional(),ForeColor:z.string().regex(/^#[0-9a-fA-F]{8}$/).optional(),
  Text:z.string().max(20000).optional(),FontSize:z.number().min(8).max(120).optional()
}).strict();
export const unifiedEditInputSchema=z.object({...unifiedIdentitySchema,properties:unifiedPropertiesSchema,saveProject:z.boolean().default(false)}).strict();
export type UnifiedEditInput=z.infer<typeof unifiedEditInputSchema>;
export type UnifiedObservation={objectType:string;properties:Record<string,string|number>;dynamicProperties:string[];screenWidth:number;screenHeight:number;baselineSha256:string};
type UnifiedEditPayload=UnifiedEditInput&{baseline:UnifiedObservation;runtimeSha256:string};
export class UnifiedEditPlans {
  private plans:PlanStore<UnifiedEditPayload>;
  constructor(now:()=>number=Date.now) {this.plans=new PlanStore({label:'Unified edit',ttlMs:600000,maxPending:20,now});}
  create(input:UnifiedEditInput,baseline:UnifiedObservation,runtimeSha256:string) {
    const parsed=unifiedEditInputSchema.parse(input);
    if(!/^[a-f0-9]{64}$/.test(baseline.baselineSha256)||!/^[a-f0-9]{64}$/.test(runtimeSha256)) throw new Error('Missing Unified baseline/runtime hash.');
    const properties=Object.fromEntries(Object.entries(parsed.properties).map(([key,value])=>[key,key.endsWith('Color')?(value as string).toUpperCase():value]));
    const diff=Object.entries(properties).map(([property,after])=>{
      if(!Object.hasOwn(baseline.properties,property)) throw new Error(`Property unavailable on selected Unified object: ${property}`);
      if(baseline.dynamicProperties.includes(property==='FontSize'?'Font.Size':property)) throw new Error(`Cannot replace a dynamic Unified property: ${property}`);
      return {property,before:baseline.properties[property],after};
    }).filter(row=>row.before!==row.after);
    if(!diff.length) throw new Error('No changes to plan.');
    const final={...baseline.properties,...properties};
    if(Number(final.Left)+Number(final.Width)>baseline.screenWidth||Number(final.Top)+Number(final.Height)>baseline.screenHeight) throw new Error('Updated Unified object exceeds screen bounds.');
    const {confirmToken,planSha256,expiresAt}=this.plans.issue({...parsed,properties:Object.fromEntries(diff.map(d=>[d.property,d.after])),baseline,runtimeSha256});
    const {properties:_,saveProject,...identity}=parsed;
    return {confirmToken,planSha256,expiresAt,identity,diff,baselineSha256:baseline.baselineSha256,
      operation:'set_existing_unified_object_properties',compileScope:'entire_hosting_device',saveProject,
      saveScope:saveProject?'Entire attached project, including other unsaved changes.':'Do not save.',
      preservation:'Only selected public property setters are called; no object reconstruction or XML import.',
      backup:'Scoped property baseline, not a complete native object or project backup.',
      rollback:'No automatic rollback; failure requires readback and a new exact plan.',download:false};
  }
  consume(token:string,hash:string) {
    return this.plans.consume(token,hash);
  }
}
