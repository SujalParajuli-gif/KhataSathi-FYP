import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDraftRequestWhereForActor,
  canActorReadDraftRequest,
  getBusinessDayQueueExpiry,
  getDraftDeliveryState,
  normalizeDraftItems,
} from "../modules/draft-requests/service";
import { resolveAcceptedDraftRequestSchema } from "../modules/draft-requests/validation";

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
    buildDraftRequestWhereForActor(
      { id: "cashier-1", role: "CASHIER" },
      { status: "active" },
    ),
    {
      status: { in: ["PENDING", "MODIFIED"] },
      OR: [{ assignedCashierId: "cashier-1" }, { assignedCashierId: null }],
    },
  );
  assert.deepEqual(
    buildDraftRequestWhereForActor(
      { id: "cashier-1", role: "CASHIER" },
      { status: "open" },
    ),
    {
      status: {
        in: ["PENDING", "MODIFIED", "ACCEPTED", "PARTIALLY_ACCEPTED"],
      },
      OR: [{ assignedCashierId: "cashier-1" }, { assignedCashierId: null }],
    },
  );
  assert.deepEqual(
    buildDraftRequestWhereForActor(
      { id: "cashier-1", role: "CASHIER" },
      { status: "actionable" },
    ),
    {
      status: {
        in: ["PENDING", "MODIFIED", "ACCEPTED", "PARTIALLY_ACCEPTED"],
      },
      OR: [{ assignedCashierId: "cashier-1" }, { assignedCashierId: null }],
    },
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

test("delivery state distinguishes queued, viewed, inactive assignment, and closed requests", () => {
  assert.equal(getDraftDeliveryState({ status: "PENDING" }), "QUEUED");
  assert.equal(
    getDraftDeliveryState({
      status: "MODIFIED",
      firstViewedAt: "2026-07-23T10:00:00.000Z",
    }),
    "VIEWED",
  );
  assert.equal(
    getDraftDeliveryState({
      status: "PENDING",
      assignedCashier: { isActive: false },
    }),
    "NEEDS_REASSIGNMENT",
  );
  assert.equal(getDraftDeliveryState({ status: "ACCEPTED" }), "CLOSED");
});

test("offline queue expiry is the end of the current Kathmandu business day", () => {
  assert.equal(
    getBusinessDayQueueExpiry(new Date("2026-07-23T10:00:00.000Z")).toISOString(),
    "2026-07-23T18:14:59.999Z",
  );
});

test("accepted request resolution requires an explicit supported action and reason", () => {
  assert.equal(
    resolveAcceptedDraftRequestSchema.safeParse({
      action: "RETURN_TO_QUEUE",
      reason: "Cashier shift ended",
    }).success,
    true,
  );
  assert.equal(
    resolveAcceptedDraftRequestSchema.safeParse({
      action: "CANCEL",
      reason: "Customer left before payment",
    }).success,
    true,
  );
  assert.equal(
    resolveAcceptedDraftRequestSchema.safeParse({
      action: "DELETE",
      reason: "No",
    }).success,
    false,
  );
});
