import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildCheckoutPayloadHash,
  captureReceivingDestinationTx,
  normalizeCheckoutPayment,
  normalizeCheckoutPayments,
  projectPublicPayment,
  toPublicCheckoutResponse,
} from "../modules/invoices/service";
import {
  checkoutBodySchema,
  checkoutPaymentSchema,
} from "../modules/invoices/validation";

const VALID_ACCOUNT_ID = "c460cfb9-6232-47ef-a0d4-1a3b5ebfb001";
const VALID_ASSET_ID = "d571d0ca-7343-48fa-b1e5-2b4c6fcac002";
const VALID_ASSET_CHECKSUM =
  "a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0";
const VALID_SOURCE_CHECKSUM =
  "b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef01";

test("checkoutPaymentSchema accepts valid destination fields on FONEPAY and BANK_TRANSFER", () => {
  const fonepay = checkoutPaymentSchema.safeParse({
    method: "FONEPAY",
    amount: 1500,
    reference: "FP-REF-12345",
    receivingAccountId: VALID_ACCOUNT_ID,
    receivingAccountVersion: 2,
    manualReceiptConfirmed: true,
  });
  assert.equal(fonepay.success, true);

  const bankTransfer = checkoutPaymentSchema.safeParse({
    method: "BANK_TRANSFER",
    amount: 2500,
    reference: "BT-REF-9999",
    receivingAccountId: VALID_ACCOUNT_ID,
    receivingAccountVersion: 1,
    manualReceiptConfirmed: true,
  });
  assert.equal(bankTransfer.success, true);
});

test("checkoutPaymentSchema rejects incomplete or invalid destination field tuples", () => {
  // Missing version and confirmation
  const missingVersion = checkoutPaymentSchema.safeParse({
    method: "FONEPAY",
    amount: 500,
    reference: "REF-1",
    receivingAccountId: VALID_ACCOUNT_ID,
  });
  assert.equal(missingVersion.success, false);

  // manualReceiptConfirmed is false
  const falseConfirmation = checkoutPaymentSchema.safeParse({
    method: "FONEPAY",
    amount: 500,
    reference: "REF-1",
    receivingAccountId: VALID_ACCOUNT_ID,
    receivingAccountVersion: 1,
    manualReceiptConfirmed: false,
  });
  assert.equal(falseConfirmation.success, false);

  // Non-UUID account ID
  const invalidUuid = checkoutPaymentSchema.safeParse({
    method: "FONEPAY",
    amount: 500,
    reference: "REF-1",
    receivingAccountId: "not-a-uuid-123",
    receivingAccountVersion: 1,
    manualReceiptConfirmed: true,
  });
  assert.equal(invalidUuid.success, false);

  // Non-positive version
  const zeroVersion = checkoutPaymentSchema.safeParse({
    method: "FONEPAY",
    amount: 500,
    reference: "REF-1",
    receivingAccountId: VALID_ACCOUNT_ID,
    receivingAccountVersion: 0,
    manualReceiptConfirmed: true,
  });
  assert.equal(zeroVersion.success, false);

  // Missing reference when destination is present
  const missingRef = checkoutPaymentSchema.safeParse({
    method: "FONEPAY",
    amount: 500,
    reference: "   ",
    receivingAccountId: VALID_ACCOUNT_ID,
    receivingAccountVersion: 1,
    manualReceiptConfirmed: true,
  });
  assert.equal(missingRef.success, false);
});

test("checkoutPaymentSchema rejects destination fields on CASH, ESEWA, or NONE", () => {
  const cashWithDest = checkoutPaymentSchema.safeParse({
    method: "CASH",
    amount: 500,
    receivingAccountId: VALID_ACCOUNT_ID,
    receivingAccountVersion: 1,
    manualReceiptConfirmed: true,
  });
  assert.equal(cashWithDest.success, false);

  const esewaWithDest = checkoutPaymentSchema.safeParse({
    method: "ESEWA",
    amount: 500,
    receivingAccountId: VALID_ACCOUNT_ID,
    receivingAccountVersion: 1,
    manualReceiptConfirmed: true,
  });
  assert.equal(esewaWithDest.success, false);

  const noneWithDest = checkoutPaymentSchema.safeParse({
    method: "NONE",
    receivingAccountId: VALID_ACCOUNT_ID,
  });
  assert.equal(noneWithDest.success, false);
});

test("checkoutBodySchema accepts legacy absent-destination payments", () => {
  const body = {
    operationKey: "checkout-op-key-123456",
    items: [{ productId: "prod-1", qty: 2 }],
    payments: [
      { method: "CASH", amount: 100 },
      { method: "FONEPAY", amount: 200, reference: "REF-99" },
    ],
  };
  assert.equal(checkoutBodySchema.safeParse(body).success, true);
});

test("normalizeCheckoutPayment preserves exact legacy normalized shape when destination is absent", () => {
  const legacyCash = normalizeCheckoutPayment({
    method: "CASH",
    amount: 100,
    tenderedAmount: 150,
  });
  assert.deepEqual(legacyCash, {
    method: "CASH",
    amount: 100,
    reference: undefined,
    tenderedAmount: 150,
  });
  assert.equal("receivingAccountId" in legacyCash, false);
  assert.equal("receivingAccountVersion" in legacyCash, false);
  assert.equal("manualReceiptConfirmed" in legacyCash, false);

  const legacyFonepay = normalizeCheckoutPayment({
    method: "FONEPAY",
    amount: 250,
    reference: "REF-LEGACY",
  });
  assert.deepEqual(legacyFonepay, {
    method: "FONEPAY",
    amount: 250,
    reference: "REF-LEGACY",
    tenderedAmount: undefined,
  });
  assert.equal("receivingAccountId" in legacyFonepay, false);
});

test("normalizeCheckoutPayment validates destination before NONE return and nonfinite checks", () => {
  // NONE method with destination fields throws
  assert.throws(
    () =>
      normalizeCheckoutPayment({
        method: "NONE",
        receivingAccountId: VALID_ACCOUNT_ID,
      }),
    /Receiving destination is only supported for Fonepay and Bank Transfer payments/,
  );

  // CASH with destination and invalid amount throws destination error first
  assert.throws(
    () =>
      normalizeCheckoutPayment({
        method: "CASH",
        amount: -10,
        receivingAccountId: VALID_ACCOUNT_ID,
      }),
    /Receiving destination is only supported for Fonepay and Bank Transfer payments/,
  );

  // FONEPAY with non-UUID throws
  assert.throws(
    () =>
      normalizeCheckoutPayment({
        method: "FONEPAY",
        amount: 100,
        reference: "REF-1",
        receivingAccountId: "bad-uuid",
        receivingAccountVersion: 1,
        manualReceiptConfirmed: true,
      }),
    /Receiving account ID must be a valid UUID/,
  );
});

test("normalizeCheckoutPayments enforces single eSewa payment constraint", () => {
  assert.throws(
    () =>
      normalizeCheckoutPayments({
        operationKey: "op-1234567890123456",
        items: [{ productId: "p1", qty: 1 }],
        payments: [
          { method: "ESEWA", amount: 100 },
          { method: "ESEWA", amount: 200 },
        ],
      }),
    /Only one eSewa payment can be created during checkout/,
  );
});

test("buildCheckoutPayloadHash produces byte-identical legacy hash when destination is absent", () => {
  const items = [{ productId: "product-1", qty: 1 }];
  const payments = [
    {
      method: "FONEPAY" as const,
      amount: 500,
      reference: "REF-123",
      tenderedAmount: undefined,
    },
  ];

  const legacyPayload = {
    draftInvoiceId: null,
    customerId: null,
    discountAmount: null,
    notes: null,
    items: [
      {
        productId: "product-1",
        qty: 1,
        overrideUnitPrice: null,
        overrideReason: null,
      },
    ],
    payments: [
      {
        method: "FONEPAY",
        amount: 500,
        reference: "REF-123",
        tenderedAmount: null,
      },
    ],
  };
  const expectedHash = createHash("sha256")
    .update(JSON.stringify(legacyPayload))
    .digest("hex");

  const actualHash = buildCheckoutPayloadHash(
    { operationKey: "checkout-op-123456789", items },
    items,
    payments,
  );
  assert.equal(actualHash, expectedHash);
});

test("buildCheckoutPayloadHash includes destination fields when present", () => {
  const items = [{ productId: "product-1", qty: 1 }];
  const paymentsWithDest = [
    {
      method: "FONEPAY" as const,
      amount: 500,
      reference: "REF-123",
      tenderedAmount: undefined,
      receivingAccountId: VALID_ACCOUNT_ID,
      receivingAccountVersion: 1,
      manualReceiptConfirmed: true as const,
    },
  ];

  const hash1 = buildCheckoutPayloadHash(
    { operationKey: "checkout-op-123456789", items },
    items,
    paymentsWithDest,
  );

  const hash2VersionChanged = buildCheckoutPayloadHash(
    { operationKey: "checkout-op-123456789", items },
    items,
    [
      {
        ...paymentsWithDest[0],
        receivingAccountVersion: 2,
      },
    ],
  );

  assert.notEqual(hash1, hash2VersionChanged);
});

test("captureReceivingDestinationTx returns null when wholly absent", async () => {
  const mockTx = {};
  const result = await captureReceivingDestinationTx(
    mockTx,
    { method: "CASH" },
    "user-1",
  );
  assert.equal(result, null);
});

test("captureReceivingDestinationTx builds immutable server snapshot on valid locked account", async () => {
  const mockTx = {
    $queryRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
      const sql = strings.join("?");
      if (sql.includes("FROM PaymentReceivingAccount")) {
        return [
          {
            id: VALID_ACCOUNT_ID,
            providerLabel: "Fonepay Official",
            accountHolder: "KhataSathi Store",
            accountIdentifier: "9800000000",
            settlementMethod: "FONEPAY",
            confirmationMode: "MANUAL_RECEIPT",
            enabled: 1,
            sortOrder: 0,
            version: 3,
            creationPayloadHash: "hash-123",
            activeQrAssetId: VALID_ASSET_ID,
          },
        ];
      }
      if (sql.includes("FROM PaymentReceivingQrAsset")) {
        return [
          {
            id: VALID_ASSET_ID,
            accountId: VALID_ACCOUNT_ID,
            publicationExpectedVersion: 3,
            storedPath: "payment-accounts/c460cfb9/qr.png",
            fileName: "qr.png",
            thumbnailFileName: "qr-thumb.png",
            mimeType: "image/png",
            sizeBytes: 1024,
            thumbnailSizeBytes: 512,
            width: 800,
            height: 800,
            checksum: VALID_ASSET_CHECKSUM,
            sourceChecksum: VALID_SOURCE_CHECKSUM,
            createdById: "admin-1",
            createdAt: new Date(),
          },
        ];
      }
      return [];
    },
  };

  const captured = await captureReceivingDestinationTx(
    mockTx,
    {
      receivingAccountId: VALID_ACCOUNT_ID,
      receivingAccountVersion: 3,
      manualReceiptConfirmed: true,
      method: "FONEPAY",
    },
    "cashier-1",
  );

  assert.ok(captured);
  assert.equal(captured.receivingAccountId, VALID_ACCOUNT_ID);
  const snapshot = captured.receivingDestinationSnapshot as any;
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.accountId, VALID_ACCOUNT_ID);
  assert.equal(snapshot.accountVersion, 3);
  assert.equal(snapshot.providerLabel, "Fonepay Official");
  assert.equal(snapshot.accountHolder, "KhataSathi Store");
  assert.equal(snapshot.accountIdentifier, "9800000000");
  assert.equal(snapshot.settlementMethod, "FONEPAY");
  assert.equal(snapshot.confirmationMode, "MANUAL_RECEIPT");
  assert.equal(snapshot.qrAssetId, VALID_ASSET_ID);
  assert.equal(snapshot.qrChecksum, VALID_ASSET_CHECKSUM);
  assert.equal(snapshot.confirmedById, "cashier-1");
  assert.ok(typeof snapshot.confirmedAt === "string");
});

test("captureReceivingDestinationTx throws 409 RECEIVING_ACCOUNT_CHANGED when account is disabled or stale", async () => {
  // 1. Disabled account
  const disabledTx = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      if (strings.join("?").includes("FROM PaymentReceivingAccount")) {
        return [
          {
            id: VALID_ACCOUNT_ID,
            providerLabel: "Fonepay",
            accountHolder: "Store",
            accountIdentifier: null,
            settlementMethod: "FONEPAY",
            confirmationMode: "MANUAL_RECEIPT",
            enabled: 0,
            sortOrder: 0,
            version: 1,
            activeQrAssetId: VALID_ASSET_ID,
          },
        ];
      }
      return [];
    },
  };

  await assert.rejects(
    async () => {
      await captureReceivingDestinationTx(
        disabledTx,
        {
          receivingAccountId: VALID_ACCOUNT_ID,
          receivingAccountVersion: 1,
          manualReceiptConfirmed: true,
          method: "FONEPAY",
        },
        "cashier-1",
      );
    },
    (err: any) => {
      assert.equal(err.code, "RECEIVING_ACCOUNT_CHANGED");
      assert.equal(err.statusCode, 409);
      assert.match(err.message, /disabled/);
      return true;
    },
  );

  // 2. Version changed (stale)
  const staleTx = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      if (strings.join("?").includes("FROM PaymentReceivingAccount")) {
        return [
          {
            id: VALID_ACCOUNT_ID,
            providerLabel: "Fonepay",
            accountHolder: "Store",
            accountIdentifier: null,
            settlementMethod: "FONEPAY",
            confirmationMode: "MANUAL_RECEIPT",
            enabled: 1,
            sortOrder: 0,
            version: 2, // Live version is 2
            activeQrAssetId: VALID_ASSET_ID,
          },
        ];
      }
      return [];
    },
  };

  await assert.rejects(
    async () => {
      await captureReceivingDestinationTx(
        staleTx,
        {
          receivingAccountId: VALID_ACCOUNT_ID,
          receivingAccountVersion: 1, // Caller sent version 1
          manualReceiptConfirmed: true,
          method: "FONEPAY",
        },
        "cashier-1",
      );
    },
    (err: any) => {
      assert.equal(err.code, "RECEIVING_ACCOUNT_CHANGED");
      assert.equal(err.statusCode, 409);
      assert.match(err.message, /version changed/);
      return true;
    },
  );
});

test("projectPublicPayment strips internal fields and preserves safe snapshot", () => {
  const rawPayment = {
    id: "pay-1",
    invoiceId: "inv-1",
    method: "FONEPAY",
    amount: 1200,
    status: "SUCCESS",
    reference: "REF-123",
    createdById: "cashier-1",
    manualOperationKey: "secret-key-12345678",
    manualPayloadHash: "secret-hash-abcdef",
    receivingAccountId: VALID_ACCOUNT_ID,
    receivingDestinationSnapshot: {
      schemaVersion: 1,
      accountId: VALID_ACCOUNT_ID,
      accountVersion: 1,
      providerLabel: "Fonepay",
      accountHolder: "Store",
      accountIdentifier: "9800000000",
      settlementMethod: "FONEPAY",
      confirmationMode: "MANUAL_RECEIPT",
      qrAssetId: VALID_ASSET_ID,
      qrChecksum: VALID_ASSET_CHECKSUM,
      confirmedById: "cashier-1",
      confirmedAt: "2026-10-07T12:00:00.000Z",
    },
    createdAt: new Date("2026-10-07T12:00:00.000Z"),
    createdBy: { id: "cashier-1", name: "Cashier Ram", role: "CASHIER", passwordHash: "secret" },
  };

  const projected = projectPublicPayment(rawPayment);
  assert.equal(projected.id, "pay-1");
  assert.equal(projected.invoiceId, "inv-1");
  assert.equal(projected.amount, 1200);
  assert.equal(projected.receivingAccountId, VALID_ACCOUNT_ID);
  assert.deepEqual(projected.createdBy, { id: "cashier-1", name: "Cashier Ram" });
  assert.equal("manualOperationKey" in projected, false);
  assert.equal("manualPayloadHash" in projected, false);
  assert.ok(projected.receivingDestinationSnapshot);
  assert.equal(projected.receivingDestinationSnapshot.schemaVersion, 1);
  assert.equal(projected.receivingDestinationSnapshot.providerLabel, "Fonepay");
});

test("toPublicCheckoutResponse sanitizes both invoice items and payments on replay", () => {
  const responsePayload = {
    invoice: {
      id: "inv-1",
      items: [
        {
          id: "item-1",
          invoiceId: "inv-1",
          productId: "prod-1",
          qty: 2,
          appliedUnitPrice: 100,
          lineTotal: 200,
          createdAt: "2026-10-07T12:00:00.000Z",
        },
      ],
      payments: [
        {
          id: "pay-1",
          invoiceId: "inv-1",
          method: "FONEPAY",
          amount: 200,
          status: "SUCCESS",
          createdById: "cashier-1",
          manualOperationKey: "leaked-key",
          receivingAccountId: VALID_ACCOUNT_ID,
          createdAt: "2026-10-07T12:00:00.000Z",
        },
      ],
    },
  };

  const publicResponse = toPublicCheckoutResponse(responsePayload);
  const payment = (publicResponse.invoice?.payments as any[])[0];
  assert.equal(payment.id, "pay-1");
  assert.equal(payment.amount, 200);
  assert.equal("manualOperationKey" in payment, false);
});

test("captureReceivingDestinationTx rejects explicitly supplied null/false/empty destination without acquiring locks", async () => {
  let queryCount = 0;
  const spyTx = {
    $queryRaw: async () => {
      queryCount += 1;
      return [];
    },
  };

  // 1. Explicitly supplied null on CASH
  await assert.rejects(
    async () => {
      await captureReceivingDestinationTx(
        spyTx,
        { method: "CASH", receivingAccountId: null },
        "cashier-1",
      );
    },
    /Receiving destination is only supported for Fonepay and Bank Transfer payments/,
  );
  assert.equal(queryCount, 0, "No queries or locks should be acquired on invalid CASH destination");

  // 2. Explicitly supplied null on ESEWA
  await assert.rejects(
    async () => {
      await captureReceivingDestinationTx(
        spyTx,
        {
          method: "ESEWA",
          receivingAccountId: null,
          receivingAccountVersion: null,
          manualReceiptConfirmed: null,
        },
        "cashier-1",
      );
    },
    /Receiving destination is only supported for Fonepay and Bank Transfer payments/,
  );
  assert.equal(queryCount, 0, "No queries or locks should be acquired on invalid ESEWA destination");

  // 3. Explicitly supplied null on NONE
  await assert.rejects(
    async () => {
      await captureReceivingDestinationTx(
        spyTx,
        { method: "NONE", receivingAccountId: null },
        "cashier-1",
      );
    },
    /Receiving destination is only supported for Fonepay and Bank Transfer payments/,
  );
  assert.equal(queryCount, 0, "No queries or locks should be acquired on invalid NONE destination");

  // 4. Explicitly supplied false on FONEPAY manualReceiptConfirmed
  await assert.rejects(
    async () => {
      await captureReceivingDestinationTx(
        spyTx,
        {
          method: "FONEPAY",
          receivingAccountId: VALID_ACCOUNT_ID,
          receivingAccountVersion: 1,
          manualReceiptConfirmed: false,
        },
        "cashier-1",
      );
    },
    /Cashier manual receipt confirmation is required for receiving destination/,
  );
  assert.equal(queryCount, 0, "No queries or locks should be acquired when manual receipt confirmation is false");
});

test("normalizeCheckoutPayment rejects control characters and HTML tags in reference", () => {
  // Control character (NUL, newline, etc.)
  assert.throws(
    () =>
      normalizeCheckoutPayment({
        method: "FONEPAY",
        amount: 100,
        reference: "FP\x00REF",
        receivingAccountId: VALID_ACCOUNT_ID,
        receivingAccountVersion: 1,
        manualReceiptConfirmed: true,
      }),
    /Payment reference cannot contain control characters/,
  );

  assert.throws(
    () =>
      normalizeCheckoutPayment({
        method: "CASH",
        amount: 100,
        reference: "CASH\nREF",
      }),
    /Payment reference cannot contain control characters/,
  );

  // HTML tags
  assert.throws(
    () =>
      normalizeCheckoutPayment({
        method: "FONEPAY",
        amount: 100,
        reference: "<b>FP-REF</b>",
        receivingAccountId: VALID_ACCOUNT_ID,
        receivingAccountVersion: 1,
        manualReceiptConfirmed: true,
      }),
    /Payment reference cannot contain HTML tags/,
  );
});

test("projectPublicPayment strictly validates snapshot and never fabricates defaults or current clock", () => {
  const baseValidPayment = {
    id: "pay-100",
    invoiceId: "inv-100",
    method: "FONEPAY",
    amount: 500,
    status: "SUCCESS",
    createdById: "cashier-1",
    createdAt: "2026-10-07T10:00:00.000Z",
  };

  // Missing createdAt throws instead of fabricating current timestamp
  assert.throws(
    () =>
      projectPublicPayment({
        ...baseValidPayment,
        createdAt: undefined,
      }),
    /Payment missing required createdAt/,
  );

  // Corrupt snapshot missing version -> remains null, does not infer version 1
  const missingVersion = projectPublicPayment({
    ...baseValidPayment,
    receivingAccountId: VALID_ACCOUNT_ID,
    receivingDestinationSnapshot: {
      schemaVersion: 1,
      accountId: VALID_ACCOUNT_ID,
      providerLabel: "Fonepay",
      accountHolder: "Store",
      settlementMethod: "FONEPAY",
      confirmationMode: "MANUAL_RECEIPT",
      qrAssetId: VALID_ASSET_ID,
      qrChecksum: VALID_ASSET_CHECKSUM,
      confirmedById: "cashier-1",
      confirmedAt: "2026-10-07T10:00:00.000Z",
    },
  });
  assert.equal(missingVersion.receivingDestinationSnapshot, null);

  // Corrupt snapshot missing confirmedAt -> remains null, does not fabricate Date
  const missingConfirmedAt = projectPublicPayment({
    ...baseValidPayment,
    receivingAccountId: VALID_ACCOUNT_ID,
    receivingDestinationSnapshot: {
      schemaVersion: 1,
      accountId: VALID_ACCOUNT_ID,
      accountVersion: 1,
      providerLabel: "Fonepay",
      accountHolder: "Store",
      settlementMethod: "FONEPAY",
      confirmationMode: "MANUAL_RECEIPT",
      qrAssetId: VALID_ASSET_ID,
      qrChecksum: VALID_ASSET_CHECKSUM,
      confirmedById: "cashier-1",
    },
  });
  assert.equal(missingConfirmedAt.receivingDestinationSnapshot, null);

  // Schema version 2 (unknown) -> remains null
  const unknownSchema = projectPublicPayment({
    ...baseValidPayment,
    receivingAccountId: VALID_ACCOUNT_ID,
    receivingDestinationSnapshot: {
      schemaVersion: 2,
      accountId: VALID_ACCOUNT_ID,
      accountVersion: 1,
      providerLabel: "Fonepay",
      accountHolder: "Store",
      settlementMethod: "FONEPAY",
      confirmationMode: "MANUAL_RECEIPT",
      qrAssetId: VALID_ASSET_ID,
      qrChecksum: VALID_ASSET_CHECKSUM,
      confirmedById: "cashier-1",
      confirmedAt: "2026-10-07T10:00:00.000Z",
    },
  });
  assert.equal(unknownSchema.receivingDestinationSnapshot, null);
});
