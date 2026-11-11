import assert from "node:assert/strict";
import { test } from "node:test";

import { PlanStore, planDigest } from "../dist/plan-store.js";

const store = (overrides = {}) => {
  const clock = { now: 1_000 };
  const plans = new PlanStore({ label: "Test", ttlMs: 100, maxPending: 2, now: () => clock.now, ...overrides });
  return { plans, clock };
};

test("issued plans are immutable, hash-bound and single-use", () => {
  const { plans } = store();
  const payload = { target: "Main", values: [1, 2] };
  const issued = plans.issue(payload);
  payload.values.push(3);
  assert.equal(issued.planSha256, planDigest(JSON.stringify({ target: "Main", values: [1, 2] })));
  assert.match(issued.confirmToken, /^[0-9a-f-]{36}$/);
  assert.throws(() => plans.consume(issued.confirmToken), /approval hash mismatch/);
  assert.throws(() => plans.consume(issued.confirmToken, "0".repeat(64)), /approval hash mismatch/);
  // A wrong hash leaves the plan; the exact hash consumes it once.
  assert.deepEqual(plans.consume(issued.confirmToken, issued.planSha256), { target: "Main", values: [1, 2] });
  assert.throws(() => plans.consume(issued.confirmToken, issued.planSha256), /Test plan missing, expired or already consumed/);
});

test("expiry, peek copies and discard", () => {
  const { plans, clock } = store();
  const issued = plans.issue({ n: 1 });
  const copy = plans.peek(issued.confirmToken);
  copy.n = 2;
  assert.deepEqual(plans.peek(issued.confirmToken), { n: 1 });
  plans.discard(issued.confirmToken);
  assert.equal(plans.peek(issued.confirmToken), undefined);
  const late = plans.issue({ n: 3 });
  clock.now += 100;
  assert.equal(plans.peek(late.confirmToken), undefined);
  assert.throws(() => plans.consume(late.confirmToken, late.planSha256), /expired/);
});

test("capacity rejects or evicts, and expired plans free their slots", () => {
  const { plans, clock } = store();
  plans.issue({ n: 1 });
  plans.issue({ n: 2 });
  assert.throws(() => plans.issue({ n: 3 }), /Too many pending Test plans/);
  clock.now += 100;
  plans.issue({ n: 4 });
  assert.equal(plans.size, 1);

  const evicting = store({ overflow: "evict-oldest", tokenPrefix: "TIA_IMPORT_", approvalHash: false }).plans;
  const first = evicting.issue({ n: 1 });
  const second = evicting.issue({ n: 2 });
  const third = evicting.issue({ n: 3 });
  assert.match(third.confirmToken, /^TIA_IMPORT_[0-9a-f-]{36}$/);
  assert.equal(evicting.peek(first.confirmToken), undefined);
  assert.deepEqual(evicting.consume(second.confirmToken), { n: 2 });
  // Without an approval hash a supplied hash is still checked.
  assert.throws(() => evicting.consume(third.confirmToken, "0".repeat(64)), /approval hash mismatch/);
  assert.deepEqual(evicting.consume(third.confirmToken, third.planSha256), { n: 3 });
});

test("size limit is checked on the exact serialization", () => {
  const { plans } = store();
  assert.throws(() => plans.issue({ text: "x".repeat(50) }, { bytes: 40, message: "Too big." }), /Too big/);
  assert.equal(plans.size, 0);
});
