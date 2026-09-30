import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import {
  buildActiveReturnBlockMessage,
  buildCheckoutPayloadHash,
  getInvoice,
  projectReplayInvoiceItem,
  publicInvoiceItemSelect,
  shouldAssignFinalInvoiceNo,
  toPublicCheckoutResponse,
} from "../modules/invoices/service";
import { checkoutBodySchema } from "../modules/invoices/validation";

test("buildActiveReturnBlockMessage explains why invoice edits are blocked", () => {
  const message = buildActiveReturnBlockMessage("modify this invoice", "APPROVED");

  assert.equal(
    message,
    "Cannot modify this invoice because this invoice has an approved return/refund request. Finish or reject returns before changing the invoice.",
  );
});

test("buildActiveReturnBlockMessage covers invoice cancellation too", () => {
  const message = buildActiveReturnBlockMessage("cancel this invoice", "PENDING");

  assert.match(message, /Cannot cancel this invoice/);
  assert.match(message, /pending return\/refund request/);
});

test("parked draft numbers are replaced with final invoice numbers at checkout", () => {
  assert.equal(
    shouldAssignFinalInvoiceNo("PARKED-20260626-AB12CD34"),
    true,
  );
});

test("legacy INV draft numbers are preserved to avoid burning a second number", () => {
  assert.equal(shouldAssignFinalInvoiceNo("INV-20260626-0007"), false);
});

test("checkout requires a bounded operation key", () => {
  const base = { items: [{ productId: "product-1", qty: 1 }] };
  assert.equal(checkoutBodySchema.safeParse(base).success, false);
  assert.equal(
    checkoutBodySchema.safeParse({ ...base, operationKey: "short" }).success,
    false,
  );
  assert.equal(
    checkoutBodySchema.safeParse({
      ...base,
      operationKey: "checkout-operation-123",
    }).success,
    true,
  );
});

test("checkout fingerprint detects bill changes without persisting PINs", () => {
  const items = [{ productId: "product-1", qty: 2 }];
  const payments = [
    {
      method: "CASH" as const,
      amount: 100,
      reference: undefined,
      tenderedAmount: undefined,
    },
  ];
  const first = buildCheckoutPayloadHash(
    {
      operationKey: "checkout-operation-123",
      overridePin: "1111",
      items,
      payments,
    },
    items,
    payments,
  );
  const sameBillDifferentPin = buildCheckoutPayloadHash(
    {
      operationKey: "checkout-operation-123",
      overridePin: "9999",
      items,
      payments,
    },
    items,
    payments,
  );
  const changedBill = buildCheckoutPayloadHash(
    {
      operationKey: "checkout-operation-123",
      items: [{ productId: "product-1", qty: 3 }],
      payments,
    },
    [{ productId: "product-1", qty: 3 }],
    payments,
  );

  assert.equal(first, sameBillDifferentPin);
  assert.notEqual(first, changedBill);
  assert.doesNotMatch(first, /1111|9999/);
});

test("getInvoice query uses explicit publicInvoiceItemSelect", async () => {
  // 1. Verify publicInvoiceItemSelect definition preserves required public fields and excludes internal fields
  assert.equal(publicInvoiceItemSelect.id, true);
  assert.equal(publicInvoiceItemSelect.invoiceId, true);
  assert.equal(publicInvoiceItemSelect.productId, true);
  assert.equal(publicInvoiceItemSelect.qty, true);
  assert.equal(publicInvoiceItemSelect.appliedUnitPrice, true);
  assert.equal(publicInvoiceItemSelect.originalUnitPrice, true);
  assert.equal(publicInvoiceItemSelect.overrideUnitPrice, true);
  assert.equal(publicInvoiceItemSelect.overrideReason, true);
  assert.equal(publicInvoiceItemSelect.overrideById, true);
  assert.equal(publicInvoiceItemSelect.overrideAt, true);
  assert.equal(publicInvoiceItemSelect.lineTotal, true);
  assert.equal(publicInvoiceItemSelect.createdAt, true);
  assert.deepEqual(publicInvoiceItemSelect.product.select, {
    id: true,
    name: true,
    sku: true,
    barcode: true,
  });
  assert.equal("costAtSale" in publicInvoiceItemSelect, false);

  // 2. Verify getInvoice passes publicInvoiceItemSelect to Prisma findUnique
  let capturedArgs: any = null;
  const originalFindUnique = prisma.invoice.findUnique;
  try {
    (prisma.invoice as any).findUnique = async (args: any) => {
      capturedArgs = args;
      return {
        id: "inv-live-1",
        invoiceNo: "INV-20260930-0001",
        items: [
          {
            id: "item-1",
            invoiceId: "inv-live-1",
            productId: "prod-1",
            qty: 2,
            appliedUnitPrice: 100,
            originalUnitPrice: null,
            overrideUnitPrice: null,
            overrideReason: null,
            overrideById: null,
            overrideAt: null,
            lineTotal: 200,
            createdAt: new Date("2026-09-30T10:00:00Z"),
            product: { id: "prod-1", name: "Mustard Oil 1L", sku: "OIL-001", barcode: null },
          },
        ],
      };
    };

    const invoice = await getInvoice("inv-live-1");
    assert.ok(invoice);
    assert.deepEqual(capturedArgs?.include?.items?.select, publicInvoiceItemSelect);
    assert.equal(invoice.items[0].id, "item-1");
    assert.equal("costAtSale" in invoice.items[0], false);

    // When invoice is not found in database, getInvoice returns null
    (prisma.invoice as any).findUnique = async () => null;
    const notFoundResult = await getInvoice("missing-invoice-id");
    assert.equal(notFoundResult, null);
  } finally {
    prisma.invoice.findUnique = originalFindUnique;
  }
});

test("stored replay projection excludes unexpected item and product fields via allowlist", () => {
  const legacyStoredItem = {
    id: "item-stored-1",
    invoiceId: "inv-stored-1",
    productId: "prod-stored-1",
    qty: 3,
    appliedUnitPrice: 250,
    originalUnitPrice: 250,
    overrideUnitPrice: null,
    overrideReason: null,
    overrideById: null,
    overrideAt: null,
    lineTotal: 750,
    createdAt: "2026-05-20T10:00:00.000Z",
    // unexpected/internal fields that must be scrubbed:
    costAtSale: 180,
    supplierCost: 165,
    inventoryBatchId: "BATCH-99",
    product: {
      id: "prod-stored-1",
      name: "Organic Honey 500g",
      sku: "HON-500",
      barcode: "8901234567890",
      // internal product fields that must be scrubbed:
      ratePerPiece: 180,
      vendorSource: "Apiary Direct",
    },
  };

  const publicItem = projectReplayInvoiceItem(legacyStoredItem);

  assert.equal(publicItem.id, "item-stored-1");
  assert.equal(publicItem.qty, 3);
  assert.equal("costAtSale" in publicItem, false);
  assert.equal("supplierCost" in publicItem, false);
  assert.equal("inventoryBatchId" in publicItem, false);
  assert.equal(publicItem.product?.id, "prod-stored-1");
  assert.equal(publicItem.product?.name, "Organic Honey 500g");
  assert.equal("ratePerPiece" in (publicItem.product || {}), false);
  assert.equal("vendorSource" in (publicItem.product || {}), false);
});

test("stored replay response preserves existing response fields and valid legacy payloads", () => {
  // 1. Valid legacy replay item without product or override fields
  const validLegacyItem = {
    id: "item-legacy-1",
    invoiceId: "inv-legacy-1",
    productId: "prod-legacy-1",
    qty: 1,
    appliedUnitPrice: 150,
    lineTotal: 150,
    createdAt: "2026-04-10T12:00:00.000Z",
  };
  const projectedItem = projectReplayInvoiceItem(validLegacyItem);
  assert.equal(projectedItem.id, "item-legacy-1");
  assert.equal(projectedItem.product, undefined);
  assert.equal(projectedItem.originalUnitPrice, null);
  assert.equal(projectedItem.overrideUnitPrice, null);

  // Schema-permitted historical row with promotional 0 price or 0 qty is not rejected
  const zeroPriceItem = projectReplayInvoiceItem({ ...validLegacyItem, appliedUnitPrice: 0, lineTotal: 0 });
  assert.equal(zeroPriceItem.appliedUnitPrice, 0);

  // 2. Replay envelope preserves custom metadata and payment intent without synthetic defaults
  const legacyStoredReplayJson = {
    invoice: {
      id: "inv-replayed-1",
      invoiceNo: "INV-20260410-0001",
      items: [
        {
          ...validLegacyItem,
          costAtSale: 110, // unstripped legacy cost
        },
      ],
    },
    customMetaField: "legacy-v1",
    esewaPaymentIntent: { id: "intent-123" },
  };

  const replayed = toPublicCheckoutResponse(legacyStoredReplayJson);
  assert.equal("costAtSale" in replayed.invoice!.items[0], false);
  assert.equal(replayed.customMetaField, "legacy-v1");
  assert.deepEqual(replayed.esewaPaymentIntent, { id: "intent-123" });

  // 3. Null invoice replay is preserved
  const nullInvoiceReplay = toPublicCheckoutResponse({ invoice: null });
  assert.equal(nullInvoiceReplay.invoice, null);
});

test("stored replay structural validation fails clearly on malformed data without coercing", () => {
  const baseValid = {
    id: "item-1",
    invoiceId: "inv-1",
    productId: "prod-1",
    qty: 2,
    appliedUnitPrice: 100,
    lineTotal: 200,
    createdAt: "2026-05-01T00:00:00Z",
  };

  // Rejects non-object items
  assert.throws(() => projectReplayInvoiceItem(null), /Replay invoice item must be an object/);
  assert.throws(() => projectReplayInvoiceItem([]), /Replay invoice item must be an object/);

  // Missing or non-string required identifiers (does not coerce)
  assert.throws(() => projectReplayInvoiceItem({ ...baseValid, id: "" }), /missing required string id/);
  assert.throws(() => projectReplayInvoiceItem({ ...baseValid, id: 123 }), /missing required string id/);
  assert.throws(() => projectReplayInvoiceItem({ ...baseValid, invoiceId: undefined }), /missing required string invoiceId/);
  assert.throws(() => projectReplayInvoiceItem({ ...baseValid, productId: null }), /missing required string productId/);

  // Missing or non-numeric required numbers (does not coerce "2" or NaN)
  assert.throws(() => projectReplayInvoiceItem({ ...baseValid, qty: "2" }), /missing required numeric qty/);
  assert.throws(() => projectReplayInvoiceItem({ ...baseValid, qty: NaN }), /missing required numeric qty/);
  assert.throws(() => projectReplayInvoiceItem({ ...baseValid, appliedUnitPrice: undefined }), /missing required numeric appliedUnitPrice/);
  assert.throws(() => projectReplayInvoiceItem({ ...baseValid, lineTotal: null }), /missing required numeric lineTotal/);

  // Missing createdAt
  assert.throws(() => projectReplayInvoiceItem({ ...baseValid, createdAt: null }), /missing required createdAt/);

  // Malformed product
  assert.throws(() => projectReplayInvoiceItem({ ...baseValid, product: "not-an-object" }), /product must be an object or null/);
  assert.throws(() => projectReplayInvoiceItem({ ...baseValid, product: { id: "p1" } }), /product must include valid id and name/);

  // Replay response envelope malformed structure
  assert.throws(() => toPublicCheckoutResponse(null), /Checkout response must be an object/);
  assert.throws(() => toPublicCheckoutResponse({}), /Checkout response must contain an invoice property/);
  assert.throws(() => toPublicCheckoutResponse({ invoice: { items: "not-an-array" } }), /invoice items must be an array/);
});
