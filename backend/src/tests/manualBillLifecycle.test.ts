import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  initializeManualBillMetadataTx,
  cancelManualBillObligationTx,
} from "../modules/invoices/manualBill/service";
import {
  recordReferenceSchema,
  verifyReferenceSchema,
  markMissingSchema,
  withdrawReferenceSchema,
  listManualBillQueueSchema,
} from "../modules/invoices/manualBill/validation";

const SCHEMA_PATH = path.resolve(__dirname, "../../prisma/schema.prisma");
const INDEX_MIGRATION_PATH = path.resolve(
  __dirname,
  "../../prisma/migrations/20261004180000_phase2_manual_bill_indexes/migration.sql",
);

test("TASK-2-005 Schema and additive non-unique index migration validation", () => {
  const schemaContent = fs.readFileSync(SCHEMA_PATH, "utf8");

  // Schema indexes on Invoice and Document with explicit map parity
  assert.match(
    schemaContent,
    /@@index\(\[status,\s*billingChannel,\s*billRecordStatus,\s*cancelledAt,\s*deletedAt,\s*finalizedAt,\s*id\],\s*map:\s*"Invoice_manual_bill_queue_idx"\)/,
  );
  assert.match(
    schemaContent,
    /@@index\(\[externalDocumentType,\s*externalBillNo,\s*externalBillDate\],\s*map:\s*"Invoice_external_reference_idx"\)/,
  );
  assert.match(
    schemaContent,
    /@@index\(\[documentType,\s*saleRecoveryStatus,\s*createdAt,\s*id\],\s*map:\s*"Document_sales_review_idx"\)/,
  );

  // Migration SQL
  assert.ok(
    fs.existsSync(INDEX_MIGRATION_PATH),
    "Index migration SQL file must exist",
  );
  const migrationSql = fs.readFileSync(INDEX_MIGRATION_PATH, "utf8");

  assert.match(
    migrationSql,
    /CREATE INDEX `Invoice_manual_bill_queue_idx` ON `Invoice`\(`status`, `billingChannel`, `billRecordStatus`, `cancelledAt`, `deletedAt`, `finalizedAt`, `id`\);/,
  );
  assert.match(
    migrationSql,
    /CREATE INDEX `Invoice_external_reference_idx` ON `Invoice`\(`externalDocumentType`, `externalBillNo`, `externalBillDate`\);/,
  );
  assert.match(
    migrationSql,
    /CREATE INDEX `Document_sales_review_idx` ON `Document`\(`documentType`, `saleRecoveryStatus`, `createdAt`, `id`\);/,
  );

  // Prohibit destructive statements
  assert.doesNotMatch(migrationSql, /DROP\s+TABLE/i);
  assert.doesNotMatch(migrationSql, /DROP\s+COLUMN/i);
  assert.doesNotMatch(migrationSql, /TRUNCATE/i);
  assert.doesNotMatch(migrationSql, /DELETE\s+FROM/i);
});

test("initializeManualBillMetadataTx sets PENDING status only when defaultBillingChannel is MANUAL_EXTERNAL", async () => {
  const updates: any[] = [];
  let configuredChannel: string | null = "MANUAL_EXTERNAL";

  const fakeTx: any = {
    businessSettings: {
      findUnique: async () => ({
        defaultBillingChannel: configuredChannel,
      }),
    },
    invoice: {
      update: async (args: any) => {
        updates.push(args);
        return { id: args.where.id, ...args.data };
      },
    },
  };

  // 1. Configured channel is MANUAL_EXTERNAL
  await initializeManualBillMetadataTx(fakeTx, "inv_manual_1");
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].data, {
    billingChannel: "MANUAL_EXTERNAL",
    billRecordStatus: "PENDING",
  });

  // 2. Configured channel is null / standard
  configuredChannel = null;
  await initializeManualBillMetadataTx(fakeTx, "inv_std_2");
  assert.equal(updates.length, 1); // No second update made
  configuredChannel = "IRD_ELECTRONIC";
  await initializeManualBillMetadataTx(fakeTx, "inv_reserved");
  assert.equal(updates.length, 1);
});

test("cancelManualBillObligationTx cancels manual bill obligation on replacement/cancellation", async () => {
  const updates: any[] = [];
  const auditLogs: any[] = [];

  const fakeTx: any = {
    invoice: {
      update: async (args: any) => {
        updates.push(args);
        return { id: args.where.id, ...args.data };
      },
    },
    auditLog: {
      create: async (args: any) => {
        auditLogs.push(args);
        return { id: "audit_1", ...args.data };
      },
    },
  };

  await cancelManualBillObligationTx(
    fakeTx,
    {
      id: "inv_cancel_1",
      invoiceNo: "INV-2026-001",
      billRecordStatus: "PENDING",
      billingChannel: "MANUAL_EXTERNAL",
    },
    "actor_admin_1",
    { name: "Admin", role: "ADMIN" },
  );

  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].data, {
    billRecordStatus: null,
  });
  assert.equal(auditLogs.length, 1);
  assert.equal(auditLogs[0].data.action, "MANUAL_BILL_OBLIGATION_CLEARED");
});

test("Validation schemas enforce strict types, dates, and non-empty notes", () => {
  // Record reference validation
  const validRecord = recordReferenceSchema.safeParse({
    reference: {
      billNo: "PB-2026-009",
      externalDocumentType: "PAN_INVOICE",
      externalBillDate: "2026-10-04",
    },
    expected: {
      billingChannel: "MANUAL_EXTERNAL",
      externalDocumentType: null,
      externalBillNo: null,
      externalBillDate: null,
      billRecordStatus: "PENDING",
    },
    reason: "Initial paper book reference recording",
  });
  assert.ok(validRecord.success);

  const invalidDate = recordReferenceSchema.safeParse({
    reference: {
      billNo: "PB-2026-009",
      externalDocumentType: "PAN_INVOICE",
      externalBillDate: "invalid-date",
    },
  });
  assert.ok(!invalidDate.success);

  // Verify reference validation
  const validVerify = verifyReferenceSchema.safeParse({
    reason: "Physical counter bill stamp verified",
    expected: {
      billingChannel: "MANUAL_EXTERNAL",
      externalDocumentType: "PAN_INVOICE",
      externalBillNo: "PB-2026-009",
      externalBillDate: "2026-10-04",
      billRecordStatus: "RECORDED",
    },
  });
  assert.ok(validVerify.success);

  const missingVerifyReason = verifyReferenceSchema.safeParse({
    reason: "   ",
    expected: {
      billingChannel: "MANUAL_EXTERNAL",
      externalDocumentType: "PAN_INVOICE",
      externalBillNo: "PB-2026-009",
      externalBillDate: "2026-10-04",
      billRecordStatus: "RECORDED",
    },
  });
  assert.ok(!missingVerifyReason.success);

  // Mark missing validation
  const validMissing = markMissingSchema.safeParse({
    reason: "Paper slip leaf lost at counter",
    expected: {
      billingChannel: "MANUAL_EXTERNAL",
      externalDocumentType: null,
      externalBillNo: null,
      externalBillDate: null,
      billRecordStatus: "PENDING",
    },
  });
  assert.ok(validMissing.success);

  // Withdraw validation
  const validWithdraw = withdrawReferenceSchema.safeParse({
    targetStatus: "PENDING",
    reason: "Book bill reference typo correction",
    expected: {
      billingChannel: "MANUAL_EXTERNAL",
      externalDocumentType: "PAN_INVOICE",
      externalBillNo: "PB-2026-009",
      externalBillDate: "2026-10-04",
      billRecordStatus: "VERIFIED",
    },
  });
  assert.ok(validWithdraw.success);

  const invalidWithdrawTarget = withdrawReferenceSchema.safeParse({
    targetStatus: "VERIFIED", // only PENDING or MISSING allowed
    reason: "Test",
    expected: {
      billingChannel: "MANUAL_EXTERNAL",
      externalDocumentType: "PAN_INVOICE",
      externalBillNo: "PB-2026-009",
      externalBillDate: "2026-10-04",
      billRecordStatus: "VERIFIED",
    },
  });
  assert.ok(!invalidWithdrawTarget.success);

  // List queue query validation
  const validQueue = listManualBillQueueSchema.safeParse({
    page: "2",
    pageSize: "25",
    status: "PENDING",
    search: "PB-001",
  });
  assert.ok(validQueue.success);
  if (validQueue.success) {
    assert.equal(validQueue.data.page, 2);
    assert.equal(validQueue.data.pageSize, 25);
    assert.equal(validQueue.data.status, "PENDING");
  }
});
