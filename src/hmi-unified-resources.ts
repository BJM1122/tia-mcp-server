import { z } from 'zod';

const name=z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/);
export const unifiedTagDataType=z.enum(['Bool','Int','DInt','UInt','UDInt','Word','DWord','Real','WString']);
export const unifiedResourcesShape={
  connections:z.array(z.object({name,communicationDriver:z.string().min(1).max(256),initialAddress:z.string().max(2048),disabledAtStartup:z.boolean(),
    driverProperties:z.array(z.object({name:z.string().min(1).max(128).refine(s=>!/(password|secret|token|credential)/i.test(s),'Do not include credentials in reviewable engineering plans.'),value:z.string().max(2048)}).strict()).max(100).default([])
  }).strict()).max(32).default([]),
  externalTags:z.array(z.object({name,dataType:unifiedTagDataType,connection:name,accessMode:z.enum(['AbsoluteAccess','SymbolicAccess']),address:z.string().max(512).optional(),plcTag:z.string().max(512).optional(),writeEnabled:z.boolean()}).strict()).max(2000).default([]),
  alarmClasses:z.array(z.object({name,priority:z.number().int().min(0).max(255),stateMachine:z.enum(['Raise','RaiseClear','RaiseRequiresAcknowledgement','RaiseClearOptionalAcknowledgement','RaiseClearRequiresAcknowledgement','RaiseClearRequiresAcknowledgementAndReset'])}).strict()).max(64).default([]),
  discreteAlarms:z.array(z.object({name,id:z.number().int().min(1).max(4294967295),alarmClass:name,priority:z.number().int().min(0).max(255),triggerTag:name,triggerBit:z.number().int().min(0).max(31).default(0),triggerMode:z.enum(['OnRisingEdge','OnFallingEdge']).default('OnRisingEdge'),text:z.string().min(1).max(4096),infoText:z.string().max(4096).default('')}).strict()).max(2000).default([])
};
export const unifiedResourcesSchema=z.object(unifiedResourcesShape);
export type UnifiedResources=z.infer<typeof unifiedResourcesSchema>;
export function validateUnifiedResources(resources:UnifiedResources,tags:Map<string,{dataType:string;writeEnabled:boolean}>) {
  const connections=new Set<string>();
  for(const connection of resources.connections) {
    if(connections.has(connection.name))throw new Error(`Duplicate Unified connection: ${connection.name}`);
    connections.add(connection.name);
    const keys=new Set<string>();for(const property of connection.driverProperties){if(keys.has(property.name))throw new Error('Duplicate driver property.');keys.add(property.name);}
  }
  for(const tag of resources.externalTags) {
    if(tags.has(tag.name))throw new Error(`Duplicate Unified tag: ${tag.name}`);
    if(!connections.has(tag.connection))throw new Error(`Unresolved Unified connection: ${tag.connection}`);
    if(tag.accessMode==='AbsoluteAccess' ? !tag.address||Boolean(tag.plcTag) : !tag.plcTag||Boolean(tag.address))throw new Error(`External tag requires exactly the address field for its access mode: ${tag.name}`);
    tags.set(tag.name,{dataType:tag.dataType,writeEnabled:tag.writeEnabled});
  }
  const classes=new Set<string>();for(const item of resources.alarmClasses){if(classes.has(item.name))throw new Error('Duplicate Unified alarm class.');classes.add(item.name);}
  const ids=new Set<number>(),names=new Set<string>();
  const widths:Record<string,number>={Bool:1,Int:16,UInt:16,Word:16,DInt:32,UDInt:32,DWord:32};
  for(const alarm of resources.discreteAlarms) {
    if(ids.has(alarm.id)||names.has(alarm.name))throw new Error('Duplicate Unified alarm ID/name.');ids.add(alarm.id);names.add(alarm.name);
    if(!classes.has(alarm.alarmClass))throw new Error(`Unresolved Unified alarm class: ${alarm.alarmClass}`);
    const width=widths[tags.get(alarm.triggerTag)?.dataType??''];
    if(!width||alarm.triggerBit>=width)throw new Error(`Invalid Unified alarm trigger tag/bit: ${alarm.name}`);
  }
}
