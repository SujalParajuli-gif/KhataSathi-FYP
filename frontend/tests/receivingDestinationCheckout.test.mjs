import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveCandidateCheckoutState,
  computeReviewFingerprint,
  resolvePendingCheckoutSnapshot,
  isValidUuid,
} from "../app/lib/billingCheckout.ts";
import {
  parseReceivingDestinationSnapshot,
  normalizeInvoice,
} from "../app/lib/invoices.ts";

const VALID_ACCOUNT_ID = "550e8400-e29b-41d4-a716-446655440000";
const VALID_ACCOUNT_ID_2 = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function mockProduct(id, name, price = 500, stock = 10) {
  return {
    id,
    name,
    retailPrice: price,
    wholesalePrice: price * 0.9,
    stock,
    active: true,
    quantityStep: 1,
  };
}

const defaultProductsById = new Map([
  ["p1", mockProduct("p1", "Test Product 1", 500, 10)],
  ["p2", mockProduct("p2", "Test Product 2", 300, 10)],
]);

const defaultCart = [
  { productId: "p1", qty: 2 }, // 1000
];

const mockCustomer = {
  id: "cust-1",
  name: "Walk-in Regular",
  isWholesale: false,
};

test("isValidUuid helper validates RFC 4122 UUIDs strictly", () => {
  assert.equal(isValidUuid(VALID_ACCOUNT_ID), true);
  assert.equal(isValidUuid(VALID_ACCOUNT_ID_2), true);
  assert.equal(isValidUuid("not-a-uuid"), false);
  assert.equal(isValidUuid(""), false);
  assert.equal(isValidUuid(null), false);
  assert.equal(isValidUuid(undefined), false);
  assert.equal(isValidUuid(123), false);
});

test("deriveCandidateCheckoutState emits destination fields for linked Fonepay Paid", () => {
  const res = deriveCandidateCheckoutState({
    cart: defaultCart,
    latestProductsById: defaultProductsById,
    selectedCustomer: mockCustomer,
    subtotalDiscountPercent: 0,
    paymentMethod: "Fonepay",
    paymentStatus: "Paid",
    paidAmountStr: "1000",
    cashTenderedStr: "",
    fonepayReference: "TXN12345",
    receivingAccountId: VALID_ACCOUNT_ID,
    receivingAccountVersion: 2,
    receivingAccountLabel: "Nabil Fonepay QR",
    manualReceiptConfirmed: true,
    splitPayments: [],
    shouldUseQuantityWholesalePrice: () => false,
  });

  assert.equal(res.success, true);
  if (!res.success) return;

  assert.equal(res.candidate.payments?.length, 1);
  const payment = res.candidate.payments[0];
  assert.equal(payment.method, "FONEPAY");
  assert.equal(payment.amount, 1000);
  assert.equal(payment.reference, "TXN12345");
  assert.equal(payment.receivingAccountId, VALID_ACCOUNT_ID);
  assert.equal(payment.receivingAccountVersion, 2);
  assert.equal(payment.manualReceiptConfirmed, true);

  assert.equal(res.candidate.display.receivingAccountId, VALID_ACCOUNT_ID);
  assert.equal(res.candidate.display.receivingAccountVersion, 2);
  assert.equal(res.candidate.display.manualReceiptConfirmed, true);
});

test("deriveCandidateCheckoutState emits destination fields for linked Bank Transfer Paid", () => {
  const res = deriveCandidateCheckoutState({
    cart: defaultCart,
    latestProductsById: defaultProductsById,
    selectedCustomer: mockCustomer,
    subtotalDiscountPercent: 0,
    paymentMethod: "Bank Transfer",
    paymentStatus: "Paid",
    paidAmountStr: "1000",
    cashTenderedStr: "",
    fonepayReference: "",
    bankTransferReference: "NABIL-REF-9988",
    receivingAccountId: VALID_ACCOUNT_ID_2,
    receivingAccountVersion: 1,
    receivingAccountLabel: "Global IME Current",
    manualReceiptConfirmed: true,
    splitPayments: [],
    shouldUseQuantityWholesalePrice: () => false,
  });

  assert.equal(res.success, true);
  if (!res.success) return;

  assert.equal(res.candidate.payments?.length, 1);
  const payment = res.candidate.payments[0];
  assert.equal(payment.method, "BANK_TRANSFER");
  assert.equal(payment.amount, 1000);
  assert.equal(payment.reference, "NABIL-REF-9988");
  assert.equal(payment.receivingAccountId, VALID_ACCOUNT_ID_2);
  assert.equal(payment.receivingAccountVersion, 1);
  assert.equal(payment.manualReceiptConfirmed, true);
});

test("deriveCandidateCheckoutState omits destination fields for unlinked manual Fonepay (legacy compatible)", () => {
  const res = deriveCandidateCheckoutState({
    cart: defaultCart,
    latestProductsById: defaultProductsById,
    selectedCustomer: mockCustomer,
    subtotalDiscountPercent: 0,
    paymentMethod: "Fonepay",
    paymentStatus: "Paid",
    paidAmountStr: "1000",
    cashTenderedStr: "",
    fonepayReference: "LEGACY-REF-11",
    receivingAccountId: null,
    receivingAccountVersion: null,
    manualReceiptConfirmed: false,
    splitPayments: [],
    shouldUseQuantityWholesalePrice: () => false,
  });

  assert.equal(res.success, true);
  if (!res.success) return;

  assert.equal(res.candidate.payments?.length, 1);
  const payment = res.candidate.payments[0];
  assert.equal(payment.method, "FONEPAY");
  assert.equal(payment.amount, 1000);
  assert.equal(payment.reference, "LEGACY-REF-11");
  assert.equal("receivingAccountId" in payment, false);
  assert.equal("receivingAccountVersion" in payment, false);
  assert.equal("manualReceiptConfirmed" in payment, false);
});

test("deriveCandidateCheckoutState omits destination fields for Cash and eSewa payments", () => {
  const cashRes = deriveCandidateCheckoutState({
    cart: defaultCart,
    latestProductsById: defaultProductsById,
    selectedCustomer: mockCustomer,
    subtotalDiscountPercent: 0,
    paymentMethod: "Cash",
    paymentStatus: "Paid",
    paidAmountStr: "1000",
    cashTenderedStr: "1000",
    fonepayReference: "",
    splitPayments: [],
    shouldUseQuantityWholesalePrice: () => false,
  });

  assert.equal(cashRes.success, true);
  if (!cashRes.success) return;
  const cashPayment = cashRes.candidate.payments?.[0];
  assert.equal(cashPayment?.method, "CASH");
  assert.equal("receivingAccountId" in (cashPayment || {}), false);
  assert.equal("receivingAccountVersion" in (cashPayment || {}), false);
  assert.equal("manualReceiptConfirmed" in (cashPayment || {}), false);

  const esewaRes = deriveCandidateCheckoutState({
    cart: defaultCart,
    latestProductsById: defaultProductsById,
    selectedCustomer: mockCustomer,
    subtotalDiscountPercent: 0,
    paymentMethod: "eSewa",
    paymentStatus: "Paid",
    paidAmountStr: "1000",
    cashTenderedStr: "",
    fonepayReference: "",
    splitPayments: [],
    shouldUseQuantityWholesalePrice: () => false,
  });

  assert.equal(esewaRes.success, true);
  if (!esewaRes.success) return;
  const esewaPayment = esewaRes.candidate.payments?.[0];
  assert.equal(esewaPayment?.method, "ESEWA");
  assert.equal("receivingAccountId" in (esewaPayment || {}), false);
  assert.equal("receivingAccountVersion" in (esewaPayment || {}), false);
  assert.equal("manualReceiptConfirmed" in (esewaPayment || {}), false);
});

test("deriveCandidateCheckoutState rejects overreceipt on single Partial payment without clamping", () => {
  const res = deriveCandidateCheckoutState({
    cart: defaultCart, // total 1000
    latestProductsById: defaultProductsById,
    selectedCustomer: mockCustomer,
    subtotalDiscountPercent: 0,
    paymentMethod: "Fonepay",
    paymentStatus: "Partial",
    paidAmountStr: "1500", // exceeds 1000
    cashTenderedStr: "",
    fonepayReference: "TXN-OVER",
    receivingAccountId: VALID_ACCOUNT_ID,
    receivingAccountVersion: 1,
    manualReceiptConfirmed: true,
    splitPayments: [],
    shouldUseQuantityWholesalePrice: () => false,
  });

  assert.equal(res.success, false);
  if (!res.success) {
    assert.match(res.error, /cannot exceed the bill total/i);
  }
});

test("deriveCandidateCheckoutState requires receipt confirmation on linked single Fonepay", () => {
  const res = deriveCandidateCheckoutState({
    cart: defaultCart,
    latestProductsById: defaultProductsById,
    selectedCustomer: mockCustomer,
    subtotalDiscountPercent: 0,
    paymentMethod: "Fonepay",
    paymentStatus: "Paid",
    paidAmountStr: "1000",
    cashTenderedStr: "",
    fonepayReference: "TXN-CONFIRM-TEST",
    receivingAccountId: VALID_ACCOUNT_ID,
    receivingAccountVersion: 1,
    manualReceiptConfirmed: false, // unconfirmed
    splitPayments: [],
    shouldUseQuantityWholesalePrice: () => false,
  });

  assert.equal(res.success, false);
  if (!res.success) {
    assert.match(res.error, /confirm that you checked/i);
  }
});

test("deriveCandidateCheckoutState rejects destination fields attached to Cash split row", () => {
  const res = deriveCandidateCheckoutState({
    cart: defaultCart,
    latestProductsById: defaultProductsById,
    selectedCustomer: mockCustomer,
    subtotalDiscountPercent: 0,
    paymentMethod: "Split",
    paymentStatus: "Paid",
    paidAmountStr: "1000",
    cashTenderedStr: "",
    fonepayReference: "",
    splitPayments: [
      {
        method: "CASH",
        amount: "500",
        receivingAccountId: VALID_ACCOUNT_ID, // forbidden on Cash
        manualReceiptConfirmed: true,
      },
      {
        method: "FONEPAY",
        amount: "500",
        reference: "TXN500",
        receivingAccountId: VALID_ACCOUNT_ID,
        receivingAccountVersion: 1,
        manualReceiptConfirmed: true,
      },
    ],
    shouldUseQuantityWholesalePrice: () => false,
  });

  assert.equal(res.success, false);
  if (!res.success) {
    assert.match(res.error, /cannot be attached to Cash/i);
  }
});

test("deriveCandidateCheckoutState validates split with mixed Cash and linked Bank Transfer", () => {
  const res = deriveCandidateCheckoutState({
    cart: defaultCart, // total 1000
    latestProductsById: defaultProductsById,
    selectedCustomer: mockCustomer,
    subtotalDiscountPercent: 0,
    paymentMethod: "Split",
    paymentStatus: "Paid",
    paidAmountStr: "1000",
    cashTenderedStr: "",
    fonepayReference: "",
    splitPayments: [
      {
        method: "CASH",
        amount: "400",
        tenderedAmount: "500",
      },
      {
        method: "BANK_TRANSFER",
        amount: "600",
        reference: "BT-SPLIT-99",
        receivingAccountId: VALID_ACCOUNT_ID_2,
        receivingAccountVersion: 3,
        receivingAccountLabel: "Nabil Main",
        manualReceiptConfirmed: true,
      },
    ],
    shouldUseQuantityWholesalePrice: () => false,
  });

  assert.equal(res.success, true);
  if (!res.success) return;

  assert.equal(res.candidate.payments?.length, 2);
  const cash = res.candidate.payments[0];
  assert.equal(cash.method, "CASH");
  assert.equal(cash.amount, 400);
  assert.equal(cash.tenderedAmount, 500);
  assert.equal("receivingAccountId" in cash, false);

  const bt = res.candidate.payments[1];
  assert.equal(bt.method, "BANK_TRANSFER");
  assert.equal(bt.amount, 600);
  assert.equal(bt.reference, "BT-SPLIT-99");
  assert.equal(bt.receivingAccountId, VALID_ACCOUNT_ID_2);
  assert.equal(bt.receivingAccountVersion, 3);
  assert.equal(bt.manualReceiptConfirmed, true);

  assert.equal(res.candidate.display.changeDue, 100);
  assert.equal(res.candidate.display.splitRows?.length, 2);
});

test("deriveCandidateCheckoutState rejects split over-allocation on Partial without clamping", () => {
  const res = deriveCandidateCheckoutState({
    cart: defaultCart, // total 1000
    latestProductsById: defaultProductsById,
    selectedCustomer: mockCustomer,
    subtotalDiscountPercent: 0,
    paymentMethod: "Split",
    paymentStatus: "Partial",
    paidAmountStr: "",
    cashTenderedStr: "",
    fonepayReference: "",
    splitPayments: [
      { method: "CASH", amount: "600" },
      {
        method: "FONEPAY",
        amount: "700", // total 1300 > 1000
        reference: "TXN700",
        receivingAccountId: VALID_ACCOUNT_ID,
        receivingAccountVersion: 1,
        manualReceiptConfirmed: true,
      },
    ],
    shouldUseQuantityWholesalePrice: () => false,
  });

  assert.equal(res.success, false);
  if (!res.success) {
    assert.match(res.error, /cannot exceed bill total/i);
  }
});

test("computeReviewFingerprint changes when receiving account or attestation changes", () => {
  const baseParams = {
    cart: defaultCart,
    productsById: defaultProductsById,
    selectedCustomerId: "cust-1",
    selectedCustomer: mockCustomer,
    discountPercent: 0,
    paymentMethod: "Fonepay",
    paymentStatus: "Paid",
    paidAmount: "1000",
    cashTendered: "",
    fonepayReference: "TXN1",
    receivingAccountId: VALID_ACCOUNT_ID,
    receivingAccountVersion: 1,
    manualReceiptConfirmed: true,
    splitPayments: [],
  };

  const fp1 = computeReviewFingerprint(baseParams);

  // Different account version
  const fp2 = computeReviewFingerprint({
    ...baseParams,
    receivingAccountVersion: 2,
  });
  assert.notEqual(fp1, fp2);

  // Different account ID
  const fp3 = computeReviewFingerprint({
    ...baseParams,
    receivingAccountId: VALID_ACCOUNT_ID_2,
  });
  assert.notEqual(fp1, fp3);

  // Unconfirmed
  const fp4 = computeReviewFingerprint({
    ...baseParams,
    manualReceiptConfirmed: false,
  });
  assert.notEqual(fp1, fp4);

  // Split row change
  const fpSplit1 = computeReviewFingerprint({
    ...baseParams,
    paymentMethod: "Split",
    splitPayments: [
      {
        method: "FONEPAY",
        amount: "1000",
        reference: "TXN1",
        receivingAccountId: VALID_ACCOUNT_ID,
        receivingAccountVersion: 1,
        manualReceiptConfirmed: true,
      },
    ],
  });
  const fpSplit2 = computeReviewFingerprint({
    ...baseParams,
    paymentMethod: "Split",
    splitPayments: [
      {
        method: "FONEPAY",
        amount: "1000",
        reference: "TXN1",
        receivingAccountId: VALID_ACCOUNT_ID_2, // changed account in split
        receivingAccountVersion: 1,
        manualReceiptConfirmed: true,
      },
    ],
  });
  assert.notEqual(fpSplit1, fpSplit2);
});

test("resolvePendingCheckoutSnapshot preserves exact operationKey and body despite new inputs", () => {
  const existingPending = {
    operationKey: "op-orig-12345",
    payload: {
      items: [{ productId: "p1", qty: 2 }],
      payments: [
        {
          method: "FONEPAY",
          amount: 1000,
          reference: "TXN-ORIG",
          receivingAccountId: VALID_ACCOUNT_ID,
          receivingAccountVersion: 1,
          manualReceiptConfirmed: true,
        },
      ],
    },
    activeDraftRequestId: null,
  };

  const resolved = resolvePendingCheckoutSnapshot(
    existingPending,
    "op-new-different",
    {
      items: [],
      payments: [
        {
          method: "FONEPAY",
          amount: 1000,
          reference: "TXN-NEW",
          receivingAccountId: VALID_ACCOUNT_ID_2,
          receivingAccountVersion: 2,
        },
      ],
    },
    "new-req-id",
  );

  assert.deepEqual(resolved, existingPending);
});

const VALID_QR_ASSET_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

test("deriveCandidateCheckoutState rejects underpayment on linked Paid single Fonepay", () => {
  const res = deriveCandidateCheckoutState({
    cart: defaultCart, // total 1000
    latestProductsById: defaultProductsById,
    selectedCustomer: mockCustomer,
    subtotalDiscountPercent: 0,
    paymentMethod: "Fonepay",
    paymentStatus: "Paid",
    paidAmountStr: "500", // underpayment
    cashTenderedStr: "",
    fonepayReference: "TXN12345",
    receivingAccountId: VALID_ACCOUNT_ID,
    receivingAccountVersion: 1,
    manualReceiptConfirmed: true,
    splitPayments: [],
    shouldUseQuantityWholesalePrice: () => false,
  });

  assert.equal(res.success, false);
  if (!res.success) {
    assert.match(res.error, /does not match bill total/i);
  }
});

test("deriveCandidateCheckoutState rejects overpayment on linked Paid single Fonepay", () => {
  const res = deriveCandidateCheckoutState({
    cart: defaultCart, // total 1000
    latestProductsById: defaultProductsById,
    selectedCustomer: mockCustomer,
    subtotalDiscountPercent: 0,
    paymentMethod: "Fonepay",
    paymentStatus: "Paid",
    paidAmountStr: "1500", // overpayment
    cashTenderedStr: "",
    fonepayReference: "TXN12345",
    receivingAccountId: VALID_ACCOUNT_ID,
    receivingAccountVersion: 1,
    manualReceiptConfirmed: true,
    splitPayments: [],
    shouldUseQuantityWholesalePrice: () => false,
  });

  assert.equal(res.success, false);
  if (!res.success) {
    assert.match(res.error, /does not match bill total/i);
  }
});

test("deriveCandidateCheckoutState rejects NaN or empty paid amount on linked Paid single Fonepay", () => {
  for (const invalidAmount of ["", "   ", "abc", "NaN", "-100", "0"]) {
    const res = deriveCandidateCheckoutState({
      cart: defaultCart, // total 1000
      latestProductsById: defaultProductsById,
      selectedCustomer: mockCustomer,
      subtotalDiscountPercent: 0,
      paymentMethod: "Fonepay",
      paymentStatus: "Paid",
      paidAmountStr: invalidAmount,
      cashTenderedStr: "",
      fonepayReference: "TXN12345",
      receivingAccountId: VALID_ACCOUNT_ID,
      receivingAccountVersion: 1,
      manualReceiptConfirmed: true,
      splitPayments: [],
      shouldUseQuantityWholesalePrice: () => false,
    });

    assert.equal(res.success, false);
    if (!res.success) {
      assert.match(res.error, /paid amount must be a valid/i);
    }
  }
});

test("deriveCandidateCheckoutState handles zero-total bill without requiring reference or attestation", () => {
  const res = deriveCandidateCheckoutState({
    cart: defaultCart,
    latestProductsById: defaultProductsById,
    selectedCustomer: mockCustomer,
    subtotalDiscountPercent: 100, // 100% discount => total 0
    paymentMethod: "Fonepay",
    paymentStatus: "Paid",
    paidAmountStr: "0",
    cashTenderedStr: "",
    fonepayReference: "", // empty reference allowed for zero-total
    receivingAccountId: null,
    receivingAccountVersion: null,
    manualReceiptConfirmed: false,
    splitPayments: [],
    shouldUseQuantityWholesalePrice: () => false,
  });

  assert.equal(res.success, true);
  if (!res.success) return;
  assert.equal(res.candidate.confirmation.payableTotal, 0);
  assert.equal(res.candidate.payments?.length, 0);
  assert.equal(res.candidate.display.effectivePaidAmount, 0);
  assert.equal(res.candidate.display.balanceDue, 0);
});

test("deriveCandidateCheckoutState handles Unpaid bill without demanding reference, attestation, or payments", () => {
  const res = deriveCandidateCheckoutState({
    cart: defaultCart,
    latestProductsById: defaultProductsById,
    selectedCustomer: mockCustomer,
    subtotalDiscountPercent: 0,
    paymentMethod: "Fonepay",
    paymentStatus: "Unpaid",
    paidAmountStr: "",
    cashTenderedStr: "",
    fonepayReference: "", // empty reference allowed for unpaid
    receivingAccountId: VALID_ACCOUNT_ID,
    receivingAccountVersion: 1,
    manualReceiptConfirmed: false,
    splitPayments: [],
    shouldUseQuantityWholesalePrice: () => false,
  });

  assert.equal(res.success, true);
  if (!res.success) return;
  assert.equal(res.candidate.payments?.length, 0);
  assert.equal(res.candidate.display.effectivePaidAmount, 0);
  assert.equal(res.candidate.display.balanceDue, 1000);
  assert.equal(res.candidate.display.paymentMethod, "None");
});

test("parseReceivingDestinationSnapshot parses valid schemaVersion=1 snapshots", () => {
  const raw = {
    schemaVersion: 1,
    accountId: VALID_ACCOUNT_ID,
    accountVersion: 2,
    providerLabel: "Nabil Fonepay QR",
    accountHolder: "KhataSathi Merchant Store",
    accountIdentifier: "9800000000",
    settlementMethod: "FONEPAY",
    confirmationMode: "MANUAL_RECEIPT",
    qrAssetId: VALID_QR_ASSET_ID,
    qrChecksum: "a".repeat(64),
    confirmedById: "user-1",
    confirmedAt: "2026-10-07T12:00:00.000Z",
  };

  const parsed = parseReceivingDestinationSnapshot(raw);
  assert.notEqual(parsed, null);
  assert.equal(parsed?.schemaVersion, 1);
  assert.equal(parsed?.accountId, VALID_ACCOUNT_ID);
  assert.equal(parsed?.accountVersion, 2);
  assert.equal(parsed?.providerLabel, "Nabil Fonepay QR");
  assert.equal(parsed?.accountHolder, "KhataSathi Merchant Store");
  assert.equal(parsed?.accountIdentifier, "9800000000");
  assert.equal(parsed?.settlementMethod, "FONEPAY");
  assert.equal(parsed?.confirmationMode, "MANUAL_RECEIPT");
  assert.equal(parsed?.qrAssetId, VALID_QR_ASSET_ID);
  assert.equal(parsed?.qrChecksum, "a".repeat(64));
  assert.equal(parsed?.confirmedById, "user-1");
  assert.equal(parsed?.confirmedAt, "2026-10-07T12:00:00.000Z");
});

test("parseReceivingDestinationSnapshot returns null for malformed or non-v1 snapshots", () => {
  assert.equal(parseReceivingDestinationSnapshot(null), null);
  assert.equal(parseReceivingDestinationSnapshot(undefined), null);
  assert.equal(parseReceivingDestinationSnapshot("invalid string"), null);
  assert.equal(parseReceivingDestinationSnapshot({ schemaVersion: 2 }), null);
  assert.equal(
    parseReceivingDestinationSnapshot({
      schemaVersion: 1,
      accountId: "", // empty
      accountVersion: 1,
      providerLabel: "Test",
      accountHolder: "Test",
      accountIdentifier: null,
      settlementMethod: "FONEPAY",
      confirmationMode: "MANUAL_RECEIPT",
      qrAssetId: VALID_QR_ASSET_ID,
      qrChecksum: "a".repeat(64),
      confirmedById: "user-1",
      confirmedAt: "2026-10-07T12:00:00.000Z",
    }),
    null,
  );
  assert.equal(
    parseReceivingDestinationSnapshot({
      schemaVersion: 1,
      accountId: VALID_ACCOUNT_ID,
      accountVersion: 0, // non-positive version
      providerLabel: "Test",
      accountHolder: "Test",
      accountIdentifier: null,
      settlementMethod: "FONEPAY",
      confirmationMode: "MANUAL_RECEIPT",
      qrAssetId: VALID_QR_ASSET_ID,
      qrChecksum: "a".repeat(64),
      confirmedById: "user-1",
      confirmedAt: "2026-10-07T12:00:00.000Z",
    }),
    null,
  );
  assert.equal(
    parseReceivingDestinationSnapshot({
      schemaVersion: 1,
      accountId: VALID_ACCOUNT_ID,
      accountVersion: 1,
      providerLabel: "Test",
      accountHolder: "Test",
      // missing accountIdentifier field (must be explicitly null or string)
      settlementMethod: "FONEPAY",
      confirmationMode: "MANUAL_RECEIPT",
      qrAssetId: VALID_QR_ASSET_ID,
      qrChecksum: "a".repeat(64),
      confirmedById: "user-1",
      confirmedAt: "2026-10-07T12:00:00.000Z",
    }),
    null,
  );
  assert.equal(
    parseReceivingDestinationSnapshot({
      schemaVersion: 1,
      accountId: VALID_ACCOUNT_ID,
      accountVersion: 1,
      providerLabel: "Test",
      accountHolder: "Test",
      accountIdentifier: null,
      settlementMethod: "ESEWA", // invalid settlementMethod
      confirmationMode: "MANUAL_RECEIPT",
      qrAssetId: VALID_QR_ASSET_ID,
      qrChecksum: "a".repeat(64),
      confirmedById: "user-1",
      confirmedAt: "2026-10-07T12:00:00.000Z",
    }),
    null,
  );
  assert.equal(
    parseReceivingDestinationSnapshot({
      schemaVersion: 1,
      accountId: VALID_ACCOUNT_ID,
      accountVersion: 1,
      providerLabel: "Test",
      accountHolder: "Test",
      accountIdentifier: null,
      settlementMethod: "FONEPAY",
      confirmationMode: "DISPLAY_ONLY", // DISPLAY_ONLY is not accepted
      qrAssetId: VALID_QR_ASSET_ID,
      qrChecksum: "a".repeat(64),
      confirmedById: "user-1",
      confirmedAt: "2026-10-07T12:00:00.000Z",
    }),
    null,
  );
  assert.equal(
    parseReceivingDestinationSnapshot({
      schemaVersion: 1,
      accountId: VALID_ACCOUNT_ID,
      accountVersion: 1,
      providerLabel: "Test",
      accountHolder: "Test",
      accountIdentifier: null,
      settlementMethod: "FONEPAY",
      confirmationMode: "MANUAL_RECEIPT",
      qrAssetId: "not-a-uuid", // invalid asset uuid
      qrChecksum: "a".repeat(64),
      confirmedById: "user-1",
      confirmedAt: "2026-10-07T12:00:00.000Z",
    }),
    null,
  );
  assert.equal(
    parseReceivingDestinationSnapshot({
      schemaVersion: 1,
      accountId: VALID_ACCOUNT_ID,
      accountVersion: 1,
      providerLabel: "Test",
      accountHolder: "Test",
      accountIdentifier: null,
      settlementMethod: "FONEPAY",
      confirmationMode: "MANUAL_RECEIPT",
      qrAssetId: VALID_QR_ASSET_ID,
      qrChecksum: "short-checksum", // invalid checksum
      confirmedById: "user-1",
      confirmedAt: "2026-10-07T12:00:00.000Z",
    }),
    null,
  );
});

test("normalizeInvoice parses receivingDestinationSnapshot and handles null legacy payments", () => {
  const rawInvoice = {
    id: "inv-1",
    invoiceNo: "INV-2026-001",
    createdAt: "2026-10-07T12:00:00.000Z",
    status: "PAID",
    customer: { id: "cust-1", name: "Walk-in" },
    items: [],
    payments: [
      {
        id: "pay-1",
        method: "FONEPAY",
        amount: 500,
        status: "SUCCESS",
        receivingAccountId: VALID_ACCOUNT_ID,
        receivingDestinationSnapshot: {
          schemaVersion: 1,
          accountId: VALID_ACCOUNT_ID,
          accountVersion: 1,
          providerLabel: "Nabil Bank QR",
          accountHolder: "KhataSathi",
          accountIdentifier: null,
          settlementMethod: "FONEPAY",
          confirmationMode: "MANUAL_RECEIPT",
          qrAssetId: VALID_QR_ASSET_ID,
          qrChecksum: "a".repeat(64),
          confirmedById: "cashier-1",
          confirmedAt: "2026-10-07T12:00:00.000Z",
        },
      },
      {
        id: "pay-2",
        method: "BANK_TRANSFER",
        amount: 500,
        status: "SUCCESS",
        receivingAccountId: null,
        receivingDestinationSnapshot: null, // legacy null
      },
    ],
  };

  const normalized = normalizeInvoice(rawInvoice);
  assert.equal(normalized.payments.length, 2);

  const p1 = normalized.payments[0];
  assert.equal(p1.receivingAccountId, VALID_ACCOUNT_ID);
  assert.notEqual(p1.receivingDestinationSnapshot, null);
  assert.equal(p1.receivingDestinationSnapshot?.providerLabel, "Nabil Bank QR");
  assert.equal(p1.receivingDestinationSnapshot?.accountIdentifier, null);

  const p2 = normalized.payments[1];
  assert.equal(p2.receivingAccountId, undefined);
  assert.equal(p2.receivingDestinationSnapshot, null);
});
