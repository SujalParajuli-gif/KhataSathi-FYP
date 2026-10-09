import test from "node:test";
import assert from "node:assert/strict";
import { retainManualPaymentFollowup, readManualPaymentFollowups, clearMatchingManualPaymentFollowup, manualReceiptStorageKey } from "../app/lib/manualPaymentFollowup.ts";
function storage() {
  const entries = new Map();
  return { get length() { return entries.size; }, key: (i) => [...entries.keys()][i] || null, getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: (key) => entries.delete(key) };
}
const item = { actorId: "cashier-a", invoiceId: "invoice-a", payload: { method: "BANK_TRANSFER", amount: 25, reference: "BT-1", status: "SUCCESS", receivingAccountId: "11111111-1111-4111-8111-111111111111", receivingAccountVersion: 3, manualReceiptConfirmed: true, manualOperationKey: "manual-original-key-1234" } };
test("receipt recovery survives dismissal/reload and isolates actor/invoice slots", () => {
  const s = storage();
  retainManualPaymentFollowup(s, item);
  retainManualPaymentFollowup(s, { ...item, invoiceId: "invoice-b" });
  retainManualPaymentFollowup(s, { ...item, actorId: "cashier-b" });
  assert.deepEqual(readManualPaymentFollowups(s, "cashier-a"), [item, { ...item, invoiceId: "invoice-b" }]);
  assert.deepEqual(readManualPaymentFollowups(s, "cashier-b"), [{ ...item, actorId: "cashier-b" }]);
  assert.ok(clearMatchingManualPaymentFollowup(s, item));
  assert.equal(readManualPaymentFollowups(s, "cashier-a").length, 1);
  assert.equal(readManualPaymentFollowups(s, "cashier-b").length, 1);
});
test("uncertain receipt cannot be overwritten/rekeyed; stale success cannot clear newer intent", () => {
  const s = storage(); retainManualPaymentFollowup(s, item);
  retainManualPaymentFollowup(s, structuredClone(item));
  const changed = { ...item, payload: { ...item.payload, manualOperationKey: "replacement-key-12345" } };
  assert.throws(() => retainManualPaymentFollowup(s, changed), /unresolved/);
  s.setItem(manualReceiptStorageKey(item.actorId, item.invoiceId), JSON.stringify(changed));
  assert.equal(clearMatchingManualPaymentFollowup(s, item), false);
  assert.deepEqual(readManualPaymentFollowups(s, item.actorId), [changed]);
});
test("tampered/malformed receipt slots are not replayed; storage denial prevents dispatch", () => {
  const s = storage();
  for (const patch of [{ amount: -1 }, { method: "ESEWA" }, { manualReceiptConfirmed: false }, { receivingDestinationSnapshot: {} }]) {
    assert.throws(() => retainManualPaymentFollowup(s, { ...item, payload: { ...item.payload, ...patch } }), /Invalid/);
  }
  s.setItem(manualReceiptStorageKey(item.actorId, item.invoiceId), JSON.stringify({ ...item, actorId: "other-actor" }));
  assert.deepEqual(readManualPaymentFollowups(s, item.actorId), []);
  assert.throws(() => retainManualPaymentFollowup({ ...storage(), setItem() { throw new Error("DENIED"); } }, item), /DENIED/);
});
