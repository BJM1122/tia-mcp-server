// Native candidates use the FunctionListEventHandler structure found in classic
// exports. Vendor parameter serialization still requires native acceptance tests.
const xml = (value: string) => value.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
type Parameter = { name: string; reference?: string; value?: number; type?: "System.Double" | "System.Int32" };
export function classicEvent(id: () => string, event: "Click" | "Press" | "Release", fn: "ActivateScreen" | "SetTag", parameters: Parameter[]) {
  const parameterXml = parameters.map(p => {
    const value = p.reference !== undefined
      ? `<LinkList><Value TargetID="@OpenLink"><Name>${xml(p.reference)}</Name></Value></LinkList>` : "";
    const constant = p.reference === undefined ? `<Value Type="${p.type ?? 'System.Double'}">${p.value}</Value>` : "";
    return `<Hmi.Event.FunctionListEntryParameter ID="${id()}" CompositionName="Parameters"><AttributeList><Name>${p.name}</Name>${constant}</AttributeList>${value}</Hmi.Event.FunctionListEntryParameter>`;
  }).join("");
  return `<Hmi.Event.Event ID="${id()}" CompositionName="Events"><AttributeList><Name>${event}</Name></AttributeList><ObjectList><Hmi.Event.FunctionListEventHandler ID="${id()}" CompositionName="EventHandler"><ObjectList><Hmi.Event.FunctionListEntry ID="${id()}" CompositionName="FunctionListEntries"><AttributeList><Name>${fn}</Name><Type>SystemFunction</Type></AttributeList><ObjectList>${parameterXml}</ObjectList></Hmi.Event.FunctionListEntry></ObjectList></Hmi.Event.FunctionListEventHandler></ObjectList></Hmi.Event.Event>`;
}
export function navigationEvent(id: () => string, destination: string) {
  return classicEvent(id,"Click","ActivateScreen",[{name:"ScreenName",reference:destination},{name:"ObjectNumber",value:0,type:"System.Int32"}]);
}
export function momentaryEvents(id: () => string, tag: string) {
  return classicEvent(id,"Press","SetTag",[{name:"Tag",reference:tag},{name:"Value",value:1}])
    + classicEvent(id,"Release","SetTag",[{name:"Tag",reference:tag},{name:"Value",value:0}]);
}
