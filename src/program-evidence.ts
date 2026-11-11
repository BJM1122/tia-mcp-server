import { createHash } from "node:crypto";
import { analyzeExecutionBlock, semanticBlockXml, type ExecutionBlockAnalysis, type ExecutionBlockSource } from "./execution-model.js";

// Export timestamps are not source changes. Preserve line counts and rehash the actual evidence on every read.
export class ProgramAnalysisCache {
  private entries = new Map<string, { bytes: number; result: ExecutionBlockAnalysis }>();
  private bytes = 0;
  constructor(private readonly maxBytes = 32 * 1024 * 1024, private readonly maxEntries = 8) {}

  analyze(source: ExecutionBlockSource & { xml: string }): { result: ExecutionBlockAnalysis; cacheHit: boolean } {
    const semanticXml = semanticBlockXml(source.xml);
    const key = createHash("sha256").update(JSON.stringify({ ...source, xml: undefined, sha256: undefined })).update(semanticXml).digest("hex");
    const cached = this.entries.get(key);
    if (cached) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return { result: { ...cached.result, sha256: createHash("sha256").update(source.xml).digest("hex") }, cacheHit: true };
    }
    const result = analyzeExecutionBlock(source);
    const bytes = Buffer.byteLength(JSON.stringify(result));
    if (bytes <= this.maxBytes && this.maxEntries > 0) {
      while (this.entries.size && (this.bytes + bytes > this.maxBytes || this.entries.size >= this.maxEntries)) {
        const oldest = this.entries.keys().next().value!;
        this.bytes -= this.entries.get(oldest)!.bytes;
        this.entries.delete(oldest);
      }
      this.entries.set(key, { bytes, result });
      this.bytes += bytes;
    }
    return { result, cacheHit: false };
  }
}

export function boundProgramEvidence(result: ExecutionBlockAnalysis, limit: number) {
  let truncated = result.writeSites.length > limit || result.callSites.length > limit || result.controlSites.length > limit;
  const graph = result.graph?.slice(0, limit).map(sequence => {
    for (const values of [sequence.steps, sequence.transitions, sequence.connections, sequence.branches])
      truncated ||= values.length > limit;
    return { ...sequence, steps: sequence.steps.slice(0, limit), transitions: sequence.transitions.slice(0, limit),
      connections: sequence.connections.slice(0, limit), branches: sequence.branches.slice(0, limit) };
  });
  truncated ||= (result.graph?.length ?? 0) > limit;
  return { ...result, writeSites: result.writeSites.slice(0, limit), callSites: result.callSites.slice(0, limit),
    controlSites: result.controlSites.slice(0, limit), graph, truncated };
}

export function graphContext(result: ExecutionBlockAnalysis, focus: { sequence?: number; step?: string; transition?: string }, limit: number) {
  const candidates = (result.graph ?? []).filter(sequence =>
    (focus.sequence === undefined || sequence.sequence === focus.sequence) &&
    (focus.step === undefined || sequence.steps.some(s => s.number === focus.step)) &&
    (focus.transition === undefined || sequence.transitions.some(t => t.number === focus.transition)));
  if (candidates.length !== 1) return { status: candidates.length ? "ambiguous" : "not_found",
    matchingSequences: candidates.map(s => s.sequence), sequences: [], truncated: false };
  const sequence = candidates[0];
  const transitions = sequence.transitions.filter(t => focus.transition ? t.number === focus.transition : focus.step
    ? sequence.steps.find(s => s.number === focus.step)!.exits.some(e => e.transition === "Transition:" + t.number) : true);
  const selected = new Set(transitions.map(t => "Transition:" + t.number));
  const steps = sequence.steps.filter(s => s.number === focus.step || !focus.step && !focus.transition || s.exits.some(e => selected.has(e.transition)) ||
    sequence.steps.some(p => p.exits.some(e => selected.has(e.transition) && e.nextSteps.includes("Step:" + s.number))));
  const nodes = new Set([...selected, ...steps.map(s => "Step:" + s.number)]);
  const branches = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of sequence.connections) {
      for (const [near, far] of [[edge.from, edge.to], [edge.to, edge.from]]) {
        if ((nodes.has(near) || branches.has(near)) && far.startsWith("Branch:") && !branches.has(far)) {
          branches.add(far); changed = true;
        }
      }
    }
  }
  const branchEvidence = sequence.branches.filter(b => branches.has("Branch:" + b.number));
  const connections = sequence.connections.filter(e => branches.has(e.from) || branches.has(e.to) || nodes.has(e.from) && nodes.has(e.to));
  const stepNumbers = new Set(steps.map(s => s.number));
  const writes = result.writeSites.filter(w => w.graphAction?.sequence === sequence.sequence && stepNumbers.has(w.graphAction.step));
  return { status: "resolved", matchingSequences: [sequence.sequence],
    sequences: [{ sequence: sequence.sequence, steps: steps.slice(0, limit), transitions: transitions.slice(0, limit),
      branches: branchEvidence.slice(0, limit), connections: connections.slice(0, limit), issues: sequence.issues }],
    writeSites: writes.slice(0, limit), coverage: result.coverage,
    truncated: steps.length > limit || transitions.length > limit || branchEvidence.length > limit || connections.length > limit || writes.length > limit,
    semantics: "Source topology and guards only; no PLC runtime values or GRAPH scheduler simulation" };
}
