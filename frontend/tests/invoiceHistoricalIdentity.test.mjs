import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanDisplayString,
  getIdentitySourceLabel,
  getInvoiceItemProvenanceNotice,
  buildCustomerSubtitle,
  normalizeInvoice,
} from "../app/lib/invoices.ts";

test("cleanDisplayString preserves leading zeros and ignores blanks/non-strings", () => {
  assert.equal(cleanDisplayString("001234567"), "001234567");
  assert.equal(cleanDisplayString("  hello world  "), "  hello world  ");
  assert.equal(cleanDisplayString(""), null);
  assert.equal(cleanDisplayString("   "), null);
  assert.equal(cleanDisplayString(null), null);
  assert.equal(cleanDisplayString(undefined), null);
  assert.equal(cleanDisplayString(12345), null);
  assert.equal(cleanDisplayString({}), null);
});

test("getIdentitySourceLabel maps all sources to correct descriptive copy", () => {
  assert.equal(getIdentitySourceLabel("CAPTURED"), "Captured at sale");
  assert.equal(getIdentitySourceLabel("LEGACY_LIVE_FALLBACK"), "Legacy identity — current labels");
  assert.equal(getIdentitySourceLabel("LEGACY_UNAVAILABLE"), "Historical identity unavailable");
  assert.equal(getIdentitySourceLabel("DRAFT_CURRENT"), "Current draft identity");
  assert.equal(getIdentitySourceLabel("COMPATIBILITY_UNVERIFIED"), "Historical identity unverified");
  assert.equal(getIdentitySourceLabel("UNRESOLVED"), "Identity unavailable");
});

test("getInvoiceItemProvenanceNotice detects mixed item sources appropriately", () => {
  const allCaptured = [
    { id: "1", name: "Item 1", identitySource: "CAPTURED", qty: 1, unitPrice: 10, lineTotal: 10 },
    { id: "2", name: "Item 2", identitySource: "CAPTURED", qty: 2, unitPrice: 20, lineTotal: 40 },
  ];
  assert.equal(getInvoiceItemProvenanceNotice(allCaptured), null);

  const withLegacy = [
    { id: "1", name: "Item 1", identitySource: "CAPTURED", qty: 1, unitPrice: 10, lineTotal: 10 },
    { id: "2", name: "Item 2", identitySource: "LEGACY_LIVE_FALLBACK", qty: 1, unitPrice: 20, lineTotal: 20 },
  ];
  assert.equal(getInvoiceItemProvenanceNotice(withLegacy), "Contains items with current catalog labels");

  const withUnavailable = [
    { id: "1", name: "Item 1", identitySource: "CAPTURED", qty: 1, unitPrice: 10, lineTotal: 10 },
    { id: "2", name: "Item 2", identitySource: "LEGACY_UNAVAILABLE", qty: 1, unitPrice: 20, lineTotal: 20 },
  ];
  assert.equal(getInvoiceItemProvenanceNotice(withUnavailable), "Contains items with unavailable historical identity");

  const withCompatibility = [
    { id: "1", name: "Item 1", identitySource: "COMPATIBILITY_UNVERIFIED", qty: 1, unitPrice: 10, lineTotal: 10 },
  ];
  assert.equal(getInvoiceItemProvenanceNotice(withCompatibility), "Contains items with unverified historical identity");
});

test("buildCustomerSubtitle prefixes registered contact information and distinguishes walk-in", () => {
  // Registered customer with phone
  assert.equal(
    buildCustomerSubtitle({ phone: "9841234567" }, true),
    "Current customer information: 9841234567"
  );
  // Registered customer with wholesale and phone
  assert.equal(
    buildCustomerSubtitle({ wholesalePercent: 10, phone: "9841234567" }, true),
    "Current customer information: Wholesale customer | 9841234567"
  );
  // Registered customer with loyalty and email
  assert.equal(
    buildCustomerSubtitle({ loyaltyPercent: 5, email: "vip@example.com" }, true),
    "Current customer information: Loyalty customer | vip@example.com"
  );
  // Registered customer with empty/missing contact info should NOT return Walk-in customer
  assert.equal(buildCustomerSubtitle({}, true), "");
  assert.equal(buildCustomerSubtitle(null, true), "");

  // Walk-in customer without contact
  assert.equal(buildCustomerSubtitle(null, false), "Walk-in customer");
  assert.equal(buildCustomerSubtitle({}, false), "Walk-in customer");
  // Walk-in with ad-hoc phone
  assert.equal(
    buildCustomerSubtitle({ phone: "9800000000" }, false),
    "Current customer information: 9800000000"
  );
});

test("normalizeInvoice: B-1 regression: old finalized shape ignores raw snapshots and uses COMPATIBILITY_UNVERIFIED", () => {
  const rawWithRawSnapshotsOnly = {
    id: "inv-old-raw-snapshots",
    invoiceNo: "INV-RAW-SNAP-1",
    status: "PAID",
    customerId: null,
    // displayProduct omitted (old API shape), product relation omitted, legacy name/sku omitted
    items: [
      {
        id: "item-snap-only",
        qty: 1,
        unitPrice: 50,
        lineTotal: 50,
        productNameSnapshot: "Raw snapshot only - must not be read",
        productSkuSnapshot: "RAW-SNAP-SKU",
        snapshotCapturedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };

  const normalized = normalizeInvoice(rawWithRawSnapshotsOnly);
  assert.equal(normalized.items[0].identitySource, "COMPATIBILITY_UNVERIFIED");
  assert.equal(normalized.items[0].name, "Unknown item");
  assert.equal(normalized.items[0].sku, undefined);
});

test("normalizeInvoice: B-2 regression: old/id-less finalized invoice with contact info receives current customer information prefix", () => {
  const rawIdlessWithContact = {
    id: "inv-idless-contact",
    status: "PAID",
    customerId: null,
    customer: {
      phone: "9800000000",
      wholesalePercent: 5,
    },
    items: [],
  };

  const normalized = normalizeInvoice(rawIdlessWithContact);
  assert.equal(normalized.customerName, "Walk-in");
  assert.equal(
    normalized.customerSubtitle,
    "Current customer information: Wholesale customer | 9800000000"
  );
});

test("normalizeInvoice: CAPTURED source drives customer & item display, preserving PAN leading zeros and address", () => {
  const raw = {
    id: "inv-1",
    invoiceNo: "INV-2026-001",
    status: "PAID",
    customerId: "cust-1",
    customer: {
      id: "cust-1",
      name: "Edited Current Name",
      phone: "9841112233",
      wholesalePercent: 0,
    },
    displayCustomer: {
      name: "Original Historical Customer",
      panNo: "001234567",
      address: "Biratnagar, Nepal",
      source: "CAPTURED",
    },
    items: [
      {
        id: "item-1",
        productId: "prod-1",
        qty: 2,
        unitPrice: 100,
        lineTotal: 200,
        product: {
          id: "prod-1",
          name: "Live Product Name Changed",
          sku: "LIVE-SKU-999",
          barcode: "8901234567890",
        },
        displayProduct: {
          name: "Original Product Name At Sale",
          sku: "00HIST-SKU-01",
          source: "CAPTURED",
        },
      },
    ],
  };

  const normalized = normalizeInvoice(raw);

  assert.equal(normalized.customerName, "Original Historical Customer");
  assert.equal(normalized.customerIdentitySource, "CAPTURED");
  assert.equal(normalized.customerPanNo, "001234567");
  assert.equal(normalized.customerAddress, "Biratnagar, Nepal");
  assert.equal(normalized.customerSubtitle, "Current customer information: 9841112233");

  assert.equal(normalized.items.length, 1);
  assert.equal(normalized.items[0].name, "Original Product Name At Sale");
  assert.equal(normalized.items[0].sku, "00HIST-SKU-01");
  assert.equal(normalized.items[0].barcode, "8901234567890");
  assert.equal(normalized.items[0].identitySource, "CAPTURED");
  assert.equal(normalized.items[0].qty, 2);
  assert.equal(normalized.items[0].unitPrice, 100);
  assert.equal(normalized.items[0].lineTotal, 200);

  // Invariant: no cost projection
  assert.equal("cost" in normalized.items[0], false);
  assert.equal("costSnapshot" in normalized.items[0], false);
});

test("normalizeInvoice: captured null fields do not fall back to live labels", () => {
  const raw = {
    id: "inv-2",
    invoiceNo: "INV-2026-002",
    status: "PAID",
    customerId: "cust-2",
    customer: {
      id: "cust-2",
      name: "Live Customer Should Not Appear",
    },
    displayCustomer: {
      name: null,
      panNo: null,
      address: null,
      source: "CAPTURED",
    },
    items: [
      {
        id: "item-2",
        productId: "prod-2",
        qty: 1,
        unitPrice: 50,
        lineTotal: 50,
        product: {
          id: "prod-2",
          name: "Live Product Name Should Not Fallback",
          sku: "LIVE-SKU",
        },
        displayProduct: {
          name: null,
          sku: null,
          source: "CAPTURED",
        },
      },
    ],
  };

  const normalized = normalizeInvoice(raw);

  assert.equal(normalized.customerName, "Unknown customer");
  assert.equal(normalized.customerIdentitySource, "CAPTURED");
  assert.equal(normalized.customerPanNo, null);
  assert.equal(normalized.customerAddress, null);

  assert.equal(normalized.items[0].name, "Unknown item");
  assert.equal(normalized.items[0].sku, undefined);
  assert.equal(normalized.items[0].identitySource, "CAPTURED");
});

test("normalizeInvoice: known walk-in vs registered unknown distinction", () => {
  // Walk-in with captured null
  const walkIn = normalizeInvoice({
    id: "inv-walkin",
    status: "PAID",
    customerId: null,
    displayCustomer: {
      name: null,
      panNo: null,
      address: null,
      source: "CAPTURED",
    },
    items: [],
  });
  assert.equal(walkIn.customerName, "Walk-in");
  assert.equal(walkIn.customerSubtitle, "Walk-in customer");

  // Registered customer with captured null
  const registered = normalizeInvoice({
    id: "inv-reg",
    status: "PAID",
    customerId: "cust-99",
    displayCustomer: {
      name: null,
      panNo: null,
      address: null,
      source: "CAPTURED",
    },
    customer: {
      id: "cust-99",
      phone: "9812345678",
    },
    items: [],
  });
  assert.equal(registered.customerName, "Unknown customer");
  assert.equal(registered.customerSubtitle, "Current customer information: 9812345678");
});

test("normalizeInvoice: non-CAPTURED sources never expose PAN/Address as historical facts", () => {
  for (const source of ["LEGACY_LIVE_FALLBACK", "LEGACY_UNAVAILABLE", "DRAFT_CURRENT"]) {
    const raw = {
      id: "inv-3",
      status: source === "DRAFT_CURRENT" ? "DRAFT" : "PAID",
      customerId: "cust-3",
      displayCustomer: {
        name: "Customer Name",
        panNo: "123456789", // Should be ignored because source is not CAPTURED
        address: "Kathmandu",
        source,
      },
      items: [
        {
          id: "item-3",
          qty: 1,
          unitPrice: 10,
          lineTotal: 10,
          displayProduct: {
            name: "Product Name",
            sku: "SKU-1",
            source,
          },
        },
      ],
    };

    const normalized = normalizeInvoice(raw);
    assert.equal(normalized.customerIdentitySource, source);
    assert.equal(normalized.customerPanNo, null);
    assert.equal(normalized.customerAddress, null);
    assert.equal(normalized.items[0].identitySource, source);
  }
});

test("normalizeInvoice: old API shapes (absent displayCustomer/displayProduct) use COMPATIBILITY_UNVERIFIED branch", () => {
  const oldRaw = {
    id: "inv-old",
    invoiceNo: "INV-OLD-1",
    status: "PAID",
    customerId: "cust-old",
    customer: {
      id: "cust-old",
      name: "Old Relation Name",
      phone: "9800000001",
    },
    items: [
      {
        id: "item-old-1",
        productId: "prod-old-1",
        qty: 3,
        unitPrice: 100,
        lineTotal: 300,
        product: {
          id: "prod-old-1",
          name: "Old Product Relation Name",
          sku: "OLD-SKU-1",
        },
      },
    ],
  };

  const normalized = normalizeInvoice(oldRaw);
  assert.equal(normalized.customerName, "Old Relation Name");
  assert.equal(normalized.customerIdentitySource, "COMPATIBILITY_UNVERIFIED");
  assert.equal(normalized.customerPanNo, null);
  assert.equal(normalized.customerAddress, null);

  assert.equal(normalized.items[0].name, "Old Product Relation Name");
  assert.equal(normalized.items[0].sku, "OLD-SKU-1");
  assert.equal(normalized.items[0].identitySource, "COMPATIBILITY_UNVERIFIED");
});

test("normalizeInvoice: partially absent display groups are resolved independently", () => {
  const partialRaw = {
    id: "inv-partial",
    status: "PAID",
    customerId: "cust-p",
    displayCustomer: {
      name: "Captured Customer",
      panNo: "998877",
      address: "Pokhara",
      source: "CAPTURED",
    },
    // items omit displayProduct (old item shape)
    items: [
      {
        id: "item-p",
        qty: 1,
        unitPrice: 50,
        lineTotal: 50,
        product: {
          name: "Fallback Item Name",
          sku: "FALLBACK-SKU",
        },
      },
    ],
  };

  const normalized = normalizeInvoice(partialRaw);
  assert.equal(normalized.customerIdentitySource, "CAPTURED");
  assert.equal(normalized.customerName, "Captured Customer");
  assert.equal(normalized.customerPanNo, "998877");
  assert.equal(normalized.items[0].identitySource, "COMPATIBILITY_UNVERIFIED");
  assert.equal(normalized.items[0].name, "Fallback Item Name");
});

test("normalizeInvoice: malformed display groups fail closed to UNRESOLVED without fallback", () => {
  const malformedRaw = {
    id: "inv-malformed",
    status: "PAID",
    customerId: "cust-m",
    customer: {
      id: "cust-m",
      name: "Live Name Should Not Be Used",
    },
    displayCustomer: {
      name: "Ignored Name",
      source: "INVALID_UNKNOWN_SOURCE",
    },
    items: [
      {
        id: "item-m",
        qty: 1,
        unitPrice: 10,
        lineTotal: 10,
        product: {
          name: "Live Product Should Not Be Used",
        },
        displayProduct: null, // present null fails closed
      },
    ],
  };

  const normalized = normalizeInvoice(malformedRaw);
  assert.equal(normalized.customerIdentitySource, "UNRESOLVED");
  assert.equal(normalized.customerName, "Unknown customer");
  assert.equal(normalized.customerPanNo, null);
  assert.equal(normalized.customerAddress, null);

  assert.equal(normalized.items[0].identitySource, "UNRESOLVED");
  assert.equal(normalized.items[0].name, "Unknown item");
  assert.equal(normalized.items[0].sku, undefined);
});

test("normalizeInvoice: raw input object is not mutated and all financial/payment/return fields remain intact", () => {
  const raw = {
    id: "inv-preserve",
    invoiceNo: "INV-PRESERVE-001",
    status: "PARTIAL",
    paymentStatus: "PARTIAL",
    customerId: "cust-1",
    subTotal: 1000,
    loyaltyDiscountAmount: 100,
    netTotal: 900,
    paidTotal: 400,
    dueAmount: 500,
    notes: "Preserve this note",
    displayCustomer: {
      name: "Customer A",
      panNo: "123",
      address: "Kathmandu",
      source: "CAPTURED",
    },
    items: [
      {
        id: "item-1",
        productId: "p1",
        qty: 5,
        unitPrice: 200,
        appliedUnitPrice: 200,
        originalUnitPrice: 250,
        overrideUnitPrice: 200,
        overrideReason: "Discounted for loyalty",
        lineTotal: 1000,
        displayProduct: {
          name: "Product P1",
          sku: "SKU-P1",
          source: "CAPTURED",
        },
      },
    ],
    payments: [
      {
        id: "pay-1",
        method: "CASH",
        kind: "CHARGE",
        status: "SUCCESS",
        amount: 400,
        cashTendered: 500,
        changeAmount: 100,
        createdAt: "2026-04-18T10:00:00.000Z",
      },
    ],
    returnRequests: [
      {
        id: "ret-1",
        refundAmount: 200,
        items: [{ invoiceItemId: "item-1", qtyReturned: 2 }],
      },
    ],
    creditNotesAsOriginal: [
      {
        id: "cn-1",
        creditNoteNo: "CN-001",
        originalPaidTotal: 400,
        creditedAmount: 200,
        originalNetTotal: 900,
        replacementNetTotal: 700,
        createdAt: "2026-04-18T11:00:00.000Z",
      },
    ],
  };

  const rawSnapshot = JSON.stringify(raw);
  const normalized = normalizeInvoice(raw);

  // Raw input was not modified
  assert.equal(JSON.stringify(raw), rawSnapshot);

  // Financial fields
  assert.equal(normalized.status, "Partial");
  assert.equal(normalized.paymentMethod, "Cash");
  assert.equal(normalized.subtotal, 1000);
  assert.equal(normalized.discount, 100);
  assert.equal(normalized.netTotal, 900);
  assert.equal(normalized.paidAmount, 400);
  assert.equal(normalized.dueAmount, 500);
  assert.equal(normalized.notes, "Preserve this note");
  assert.equal(normalized.reservedRefundTotal, 200);

  // Item details & remaining returnable
  assert.equal(normalized.items[0].remainingReturnableQty, 3);
  assert.equal(normalized.items[0].overrideUnitPrice, 200);
  assert.equal(normalized.items[0].originalUnitPrice, 250);
  assert.equal(normalized.items[0].overrideReason, "Discounted for loyalty");

  // Credit notes
  assert.equal(normalized.creditNotes.length, 1);
  assert.equal(normalized.creditNotes[0].creditNoteNo, "CN-001");
  assert.equal(normalized.creditNotes[0].customerCreditAmount, 200);
});
