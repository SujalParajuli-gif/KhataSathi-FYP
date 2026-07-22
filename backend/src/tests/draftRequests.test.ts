import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDraftRequestWhereForActor,
  canActorReadDraftRequest,
  normalizeDraftItems,
} from "../modules/draft-requests/service";

test("normalizeDraftItems merges duplicate products and preserves the first note", () => {
  const items = normalizeDraftItems([
    { productId: "product-1", qty: 1, note: "first" },
    { productId: "product-2", qty: 2.25 },
    { productId: "product-1", qty: 3.125, note: "second" },
  ]);

  assert.deepEqual(items, [
    { productId: "product-1", qty: 4.125, note: "first" },
    { productId: "product-2", qty: 2.25, note: null },
  ]);
});

test("normalizeDraftItems rejects empty or non-positive product quantities", () => {
  assert.throws(() => normalizeDraftItems([]), /Add at least one product/);
  assert.throws(
    () => normalizeDraftItems([{ productId: "product-1", qty: 0 }]),
    /greater than 0/,
  );
});

test("buildDraftRequestWhereForActor applies role visibility rules", () => {
  assert.deepEqual(
    buildDraftRequestWhereForActor({ id: "admin-1", role: "ADMIN" }, { status: "pending" }),
    { status: "PENDING" },
  );
  assert.deepEqual(
    buildDraftRequestWhereForActor({ id: "staff-1", role: "STAFF" }),
    { createdById: "staff-1" },
  );
  assert.deepEqual(
    buildDraftRequestWhereForActor({ id: "cashier-1", role: "CASHIER" }),
    { OR: [{ assignedCashierId: "cashier-1" }, { assignedCashierId: null }] },
  );
  assert.deepEqual(
    buildDraftRequestWhereForActor(
      { id: "cashier-1", role: "CASHIER" },
      { scope: "unassigned" },
    ),
    { assignedCashierId: null },
  );
});

test("canActorReadDraftRequest allows staff creators and assigned or open cashiers only", () => {
  const openRequest = { createdById: "staff-1", assignedCashierId: null };
  const assignedRequest = { createdById: "staff-1", assignedCashierId: "cashier-1" };

  assert.equal(canActorReadDraftRequest({ id: "admin-1", role: "ADMIN" }, assignedRequest), true);
  assert.equal(canActorReadDraftRequest({ id: "staff-1", role: "STAFF" }, assignedRequest), true);
  assert.equal(canActorReadDraftRequest({ id: "staff-2", role: "STAFF" }, assignedRequest), false);
  assert.equal(canActorReadDraftRequest({ id: "cashier-1", role: "CASHIER" }, assignedRequest), true);
  assert.equal(canActorReadDraftRequest({ id: "cashier-2", role: "CASHIER" }, assignedRequest), false);
  assert.equal(canActorReadDraftRequest({ id: "cashier-2", role: "CASHIER" }, openRequest), true);
});
