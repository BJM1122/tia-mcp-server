import { createHash, randomUUID } from "node:crypto";

// One write gate for every write path: a plan is an immutable JSON payload
// behind a single-use, short-lived token. The payload is stored serialized, so
// later mutation of the caller's objects cannot change what was approved, and
// planSha256 is the digest of exactly that serialization.

export interface PlanStoreOptions {
  // Shown in errors, e.g. "HMI" -> "HMI plan missing, expired or already consumed."
  label: string;
  ttlMs: number;
  maxPending: number;
  // "reject" refuses new plans while full; "evict-oldest" drops the oldest.
  overflow?: "reject" | "evict-oldest";
  tokenPrefix?: string;
  // Default true: consume must present the exact planSha256 the caller approved.
  // false only for gates that bind the request fields instead (PLC import).
  approvalHash?: boolean;
  now?: () => number;
}

export interface IssuedPlan {
  confirmToken: string;
  planSha256: string;
  expiresAt: string;
}

export const planDigest = (json: string): string => createHash("sha256").update(json, "utf8").digest("hex");

export class PlanStore<T> {
  private readonly pending = new Map<string, { json: string; planSha256: string; expires: number }>();
  private readonly now: () => number;

  constructor(private readonly options: PlanStoreOptions) {
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    this.prune();
    return this.pending.size;
  }

  issue(payload: T, sizeLimit?: { bytes: number; message: string }): IssuedPlan {
    const json = JSON.stringify(payload);
    if (sizeLimit && Buffer.byteLength(json) > sizeLimit.bytes) throw new Error(sizeLimit.message);
    this.prune();
    const evict = this.options.overflow === "evict-oldest";
    if (!evict && this.pending.size >= this.options.maxPending) throw new Error(`Too many pending ${this.options.label} plans.`);
    const confirmToken = `${this.options.tokenPrefix ?? ""}${randomUUID()}`;
    const planSha256 = planDigest(json), expires = this.now() + this.options.ttlMs;
    this.pending.set(confirmToken, { json, planSha256, expires });
    while (evict && this.pending.size > this.options.maxPending) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pending.delete(oldest);
    }
    return { confirmToken, planSha256, expiresAt: new Date(expires).toISOString() };
  }

  // Read without consuming, for gates that validate before the point of no
  // return. Returns a fresh copy; undefined when missing or expired.
  peek(token: string): T | undefined {
    const plan = this.live(token);
    return plan ? JSON.parse(plan.json) as T : undefined;
  }

  discard(token: string): void {
    this.pending.delete(token);
  }

  // Consume before the write starts, and before any slow check that could let
  // a second request through: a failed or uncertain write must never replay a
  // token. A wrong approval hash leaves the plan in place.
  consume(token: string, planSha256?: string): T {
    const plan = this.live(token);
    if (!plan) throw new Error(`${this.options.label} plan missing, expired or already consumed.`);
    const hashRequired = this.options.approvalHash !== false;
    if ((hashRequired || planSha256 !== undefined) && plan.planSha256 !== planSha256) throw new Error(`${this.options.label} plan approval hash mismatch.`);
    this.pending.delete(token);
    return JSON.parse(plan.json) as T;
  }

  private live(token: string) {
    const plan = this.pending.get(token);
    if (plan && plan.expires > this.now()) return plan;
    this.pending.delete(token);
    return undefined;
  }

  private prune(): void {
    const now = this.now();
    for (const [token, plan] of this.pending) if (plan.expires <= now) this.pending.delete(token);
  }
}
