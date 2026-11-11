import { createHash } from "node:crypto";

export interface HmiIdentity { projectPath: string; hmiName: string; hmiPath: string }
export interface HmiObservation {
  target: { name: string; path: string; type: string };
  hmi: {
    schemaVersion: number;
    records: unknown[];
    issues: unknown[];
    truncated: boolean;
    coverage: { sections: Array<{ section: string; state: string }>; [key: string]: unknown };
    [key: string]: unknown;
  };
}
export interface HmiSnapshot {
  schemaVersion: 1;
  identity: HmiIdentity;
  usable: boolean;
  observation: HmiObservation;
  sha256: string;
}
const sections = ["alarms", "tags", "connections", "screens", "scripts"];
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function hmiExportKey(identity: HmiIdentity): string { return hash(identity); }
export function createHmiSnapshot(identity: HmiIdentity, observation: HmiObservation): HmiSnapshot {
  const { target, hmi } = observation;
  if (!target || target.name !== identity.hmiName || (identity.hmiPath && target.path !== identity.hmiPath)
    || typeof target.path !== "string" || typeof target.type !== "string"
    || !hmi || hmi.schemaVersion !== 1 || !Array.isArray(hmi.records) || !hmi.records.length
    || !Array.isArray(hmi.issues) || typeof hmi.truncated !== "boolean" || !Array.isArray(hmi.coverage?.sections))
    throw new Error("Invalid HMI observation or target identity mismatch.");
  const usable = !hmi.truncated && !hmi.issues.length
    && sections.every(section => hmi.coverage.sections.some(item => item.section === section && item.state === "exposed"));
  return { schemaVersion: 1, identity, usable, observation, sha256: hash(observation) };
}
export function parseHmiSnapshot(text: string, identity: HmiIdentity): HmiSnapshot {
  const value = JSON.parse(text) as HmiSnapshot;
  if (value.schemaVersion !== 1 || hash(value.identity) !== hash(identity))
    throw new Error("HMI export identity mismatch.");
  const checked = createHmiSnapshot(identity, value.observation);
  if (value.sha256 !== checked.sha256 || value.usable !== checked.usable)
    throw new Error("HMI export integrity mismatch.");
  return checked;
}
