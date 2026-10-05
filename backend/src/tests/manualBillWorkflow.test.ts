import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import {
  recordManualBillReference,
  verifyManualBillReference,
  markManualBillMissing,
  withdrawManualBillReference,
  getManualBillRecord,
} from "../modules/invoices/manualBill/service";
import {
  ManualBillAuthorizationError,
  ManualBillConflictError,
  type ManualBillActor,
} from "../modules/invoices/manualBill/types";

const mockCapabilities = async () => ({
  businessMode: "FULL_POS" as const,
  catalogEnabled: true as const,
  inventoryEnabled: true,
  posEnabled: true,
  staffDraftRequestsEnabled: true,
  stockTracked: true,
});

const cashierActor: ManualBillActor = {
  id: "user_cashier_1",
  name: "Cashier One",
  role: "CASHIER",
};

const managerActor: ManualBillActor = {
  id: "user_manager_1",
  name: "Manager One",
  role: "MANAGER",
};

const adminActor: ManualBillActor = {
  id: "user_admin_1",
  name: "Admin One",
  role: "ADMIN",
};

function buildMockInvoice(overrides: Record<string, any> = {}) {
  return {
    id: "inv_test_1001",
    invoiceNo: "INV-2026-1001",
    status: "FINALIZED",
    billingChannel: "MANUAL_EXTERNAL",
    externalDocumentType: null,
    externalBillNo: null,
    externalBillDate: null,
    billRecordStatus: "PENDING",
    subtotal: 1000,
    discountTotal: 0,
    netTotal: 1000,
    paidAmount: 1000,
    changeAmount: 0,
    paymentMethod: "CASH",
    customerId: null,
    customerNameSnapshot: null,
    customerPanSnapshot: null,
    customerPhoneSnapshot: null,
    customerSnapshotCapturedAt: null,
    notes: null,
    createdBy: "user_cashier_1",
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    deletedAt: null,
    finalizedAt: new Date("2026-10-04T10:00:00Z"),
    createdAt: new Date("2026-10-04T10:00:00Z"),
    updatedAt: new Date("2026-10-04T10:00:00Z"),
    customer: null,
    user: { name: "Cashier One" },
    creditNotesAsOriginal: [],
    creditNoteAsReplacement: null,
    proofDocuments: [],
    ...overrides,
  };
}

test("recordManualBillReference: Cashier can record initial paper bill reference (PENDING -> RECORDED)", async () => {
  const invoiceRow = buildMockInvoice({
    id: "inv_first_record",
    billRecordStatus: "PENDING",
  });

  const updates: any[] = [];
  const auditLogs: any[] = [];

  const fakePrisma: any = {
    invoice: {
      findFirst: async () => ({
        ...invoiceRow,
        ...(updates[updates.length - 1]?.data || {}),
      }),
      findUnique: async () => ({
        ...invoiceRow,
        ...(updates[updates.length - 1]?.data || {}),
      }),
      findMany: async () => [],
      update: async (args: any) => {
        updates.push(args);
        return { ...invoiceRow, ...args.data };
      },
    },
    auditLog: {
      create: async (args: any) => {
        auditLogs.push(args);
        return { id: "audit_1", ...args.data };
      },
      findFirst: async () => null,
      findMany: async () => [],
    },
    user: {
      findUnique: async () => ({ name: "Cashier One", role: "CASHIER" }),
    },
    document: {
      count: async () => 0,
      findMany: async () => [],
    },
    businessSettings: {
      findUnique: async () => ({ defaultBillingChannel: "MANUAL_EXTERNAL" }),
    },
    $queryRaw: async () => [],
  };

  const originalPrismaFind = prisma.invoice.findFirst;
  const originalPrismaTx = prisma.$transaction;

  try {
    (prisma as any).invoice.findFirst = fakePrisma.invoice.findFirst;
    (prisma as any).$transaction = async (fn: any) => fn(fakePrisma);

    const result = await recordManualBillReference(
      "inv_first_record",
      {
        reference: {
          billNo: "PB-2026-001",
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
      },
      cashierActor,
      mockCapabilities,
    );

    assert.equal(result.externalBillNo, "PB-2026-001");
    assert.equal(result.externalDocumentType, "PAN_INVOICE");
    assert.equal(result.externalBillDate, "2026-10-04");
    assert.equal(result.billRecordStatus, "RECORDED");
    assert.equal(updates.length, 1);
    assert.equal(auditLogs.length, 1);
    assert.equal(auditLogs[0].data.action, "MANUAL_BILL_REFERENCE_RECORDED");
  } finally {
    (prisma as any).invoice.findFirst = originalPrismaFind;
    (prisma as any).$transaction = originalPrismaTx;
  }
});

test("recordManualBillReference: Cashier is rejected when attempting material modification of already RECORDED bill", async () => {
  const invoiceRow = buildMockInvoice({
    id: "inv_already_recorded",
    billRecordStatus: "RECORDED",
    externalBillNo: "PB-2026-001",
    externalDocumentType: "PAN_INVOICE",
    externalBillDate: new Date("2026-10-04T00:00:00.000Z"),
  });

  const fakePrisma: any = {
    invoice: {
      findFirst: async () => invoiceRow,
      findUnique: async () => invoiceRow,
      findMany: async () => [],
    },
    auditLog: {
      findFirst: async () => null,
      findMany: async () => [],
    },
    user: {
      findUnique: async () => ({ name: "Cashier One", role: "CASHIER" }),
    },
    document: {
      findMany: async () => [],
    },
    $queryRaw: async () => [],
  };

  const originalPrismaFind = prisma.invoice.findFirst;
  const originalPrismaTx = prisma.$transaction;

  try {
    (prisma as any).invoice.findFirst = fakePrisma.invoice.findFirst;
    (prisma as any).$transaction = async (fn: any) => fn(fakePrisma);

    await assert.rejects(
      async () => {
        await recordManualBillReference(
          "inv_already_recorded",
          {
            reference: {
              billNo: "PB-2026-002",
              externalDocumentType: "PAN_INVOICE",
              externalBillDate: "2026-10-04",
            },
            expected: {
              billingChannel: "MANUAL_EXTERNAL",
              externalDocumentType: "PAN_INVOICE",
              externalBillNo: "PB-2026-001",
              externalBillDate: "2026-10-04",
              billRecordStatus: "RECORDED",
            },
            reason: "Attempted cashier edit",
          },
          cashierActor,
          mockCapabilities,
        );
      },
      (err: any) => {
        return (
          err instanceof ManualBillAuthorizationError &&
          err.statusCode === 403
        );
      },
    );
  } finally {
    (prisma as any).invoice.findFirst = originalPrismaFind;
    (prisma as any).$transaction = originalPrismaTx;
  }
});

test("recordManualBillReference: Reviewer can modify RECORDED reference with required reason", async () => {
  const invoiceRow = buildMockInvoice({
    id: "inv_reviewer_edit",
    billRecordStatus: "RECORDED",
    externalBillNo: "PB-2026-001",
    externalDocumentType: "PAN_INVOICE",
    externalBillDate: new Date("2026-10-04T00:00:00.000Z"),
  });

  const updates: any[] = [];
  const auditLogs: any[] = [];

  const fakePrisma: any = {
    invoice: {
      findFirst: async () => ({
        ...invoiceRow,
        ...(updates[updates.length - 1]?.data || {}),
      }),
      findUnique: async () => ({
        ...invoiceRow,
        ...(updates[updates.length - 1]?.data || {}),
      }),
      findMany: async () => [],
      update: async (args: any) => {
        updates.push(args);
        return { ...invoiceRow, ...args.data };
      },
    },
    auditLog: {
      create: async (args: any) => {
        auditLogs.push(args);
        return { id: "audit_2", ...args.data };
      },
      findFirst: async () => null,
      findMany: async () => [],
    },
    user: {
      findUnique: async () => ({ name: "Manager One", role: "MANAGER" }),
    },
    document: {
      count: async () => 0,
      findMany: async () => [],
    },
    $queryRaw: async () => [],
  };

  const originalPrismaFind = prisma.invoice.findFirst;
  const originalPrismaTx = prisma.$transaction;

  try {
    (prisma as any).invoice.findFirst = fakePrisma.invoice.findFirst;
    (prisma as any).$transaction = async (fn: any) => fn(fakePrisma);

    const result = await recordManualBillReference(
      "inv_reviewer_edit",
      {
        reference: {
          billNo: "PB-2026-002-CORRECTED",
          externalDocumentType: "PAN_INVOICE",
          externalBillDate: "2026-10-04",
        },
        expected: {
          billingChannel: "MANUAL_EXTERNAL",
          externalDocumentType: "PAN_INVOICE",
          externalBillNo: "PB-2026-001",
          externalBillDate: "2026-10-04",
          billRecordStatus: "RECORDED",
        },
        reason: "Fixed digit typo in paper book serial number",
      },
      managerActor,
      mockCapabilities,
    );

    assert.equal(result.externalBillNo, "PB-2026-002-CORRECTED");
    assert.equal(updates.length, 1);
    assert.equal(auditLogs[0].data.action, "MANUAL_BILL_REFERENCE_RECORDED");
    assert.equal(auditLogs[0].data.meta.isFirstRecord, false);
    assert.equal(auditLogs[0].data.meta.reason, "Fixed digit typo in paper book serial number");
  } finally {
    (prisma as any).invoice.findFirst = originalPrismaFind;
    (prisma as any).$transaction = originalPrismaTx;
  }
});

test("recordManualBillReference: Duplicate detection throws DUPLICATE_REVIEW_REQUIRED and requires Reviewer override", async () => {
  const invoiceRow = buildMockInvoice({
    id: "inv_dup_test",
    billRecordStatus: "PENDING",
  });

  const existingDuplicate = buildMockInvoice({
    id: "inv_other_dup",
    invoiceNo: "INV-2026-8888",
    externalBillNo: "PB-DUPLICATE-99",
    externalDocumentType: "PAN_INVOICE",
    externalBillDate: new Date("2026-10-04T00:00:00.000Z"),
  });

  const updates: any[] = [];

  const fakePrisma: any = {
    invoice: {
      findFirst: async () => ({
        ...invoiceRow,
        ...(updates[updates.length - 1]?.data || {}),
      }),
      findMany: async (args: any) => {
        if (args.where?.externalBillNo === "PB-DUPLICATE-99") {
          return [existingDuplicate];
        }
        return [];
      },
      findUnique: async () => ({
        ...invoiceRow,
        ...(updates[updates.length - 1]?.data || {}),
      }),
      update: async (args: any) => {
        updates.push(args);
        return { ...invoiceRow, ...args.data };
      },
    },
    auditLog: {
      create: async () => ({ id: "audit_dup" }),
      findFirst: async () => null,
      findMany: async () => [],
    },
    user: {
      findUnique: async () => ({ name: "Manager One", role: "MANAGER" }),
    },
    document: {
      count: async () => 0,
      findMany: async () => [],
    },
    $queryRaw: async () => [],
  };

  const originalPrismaFind = prisma.invoice.findFirst;
  const originalPrismaTx = prisma.$transaction;

  try {
    (prisma as any).invoice.findFirst = fakePrisma.invoice.findFirst;
    (prisma as any).$transaction = async (fn: any) => fn(fakePrisma);

    // 1. Fails without override
    await assert.rejects(
      async () => {
        await recordManualBillReference(
          "inv_dup_test",
          {
            reference: {
              billNo: "PB-DUPLICATE-99",
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
          },
          cashierActor,
          mockCapabilities,
        );
      },
      (err: any) => {
        return (
          err instanceof ManualBillConflictError &&
          err.code === "DUPLICATE_REVIEW_REQUIRED" &&
          err.statusCode === 409
        );
      },
    );

    // 2. Cashier cannot override even with reason
    await assert.rejects(
      async () => {
        await recordManualBillReference(
          "inv_dup_test",
          {
            reference: {
              billNo: "PB-DUPLICATE-99",
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
            duplicateOverrideReason: "Authorized paper reuse",
          },
          cashierActor,
          mockCapabilities,
        );
      },
      (err: any) => {
        return (
          err instanceof ManualBillAuthorizationError &&
          err.statusCode === 403
        );
      },
    );

    // 3. Manager with duplicateOverrideReason succeeds
    let updatedData: any = null;
    fakePrisma.invoice.update = async (args: any) => {
      updatedData = args.data;
      updates.push(args);
      return { ...invoiceRow, ...args.data };
    };

    const successResult = await recordManualBillReference(
      "inv_dup_test",
      {
        reference: {
          billNo: "PB-DUPLICATE-99",
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
        duplicateOverrideReason: "Multi-counter continuous book series authorized by store manager",
      },
      managerActor,
      mockCapabilities,
    );

    assert.equal(successResult.externalBillNo, "PB-DUPLICATE-99");
    assert.equal(updatedData.externalBillNo, "PB-DUPLICATE-99");
  } finally {
    (prisma as any).invoice.findFirst = originalPrismaFind;
    (prisma as any).$transaction = originalPrismaTx;
  }
});

test("verifyManualBillReference: Reviewer verifies RECORDED reference -> VERIFIED", async () => {
  const invoiceRow = buildMockInvoice({
    id: "inv_to_verify",
    billRecordStatus: "RECORDED",
    externalBillNo: "PB-2026-001",
    externalDocumentType: "PAN_INVOICE",
    externalBillDate: new Date("2026-10-04T00:00:00.000Z"),
  });

  const updates: any[] = [];
  const auditLogs: any[] = [];

  const fakePrisma: any = {
    invoice: {
      findFirst: async () => ({
        ...invoiceRow,
        ...(updates[updates.length - 1]?.data || {}),
      }),
      findUnique: async () => ({
        ...invoiceRow,
        ...(updates[updates.length - 1]?.data || {}),
      }),
      findMany: async () => [],
      update: async (args: any) => {
        updates.push(args);
        return { ...invoiceRow, ...args.data };
      },
    },
    auditLog: {
      create: async (args: any) => {
        auditLogs.push(args);
        return { id: "audit_v", ...args.data };
      },
      findFirst: async () => null,
      findMany: async () => [],
    },
    user: {
      findUnique: async () => ({ name: "Manager One", role: "MANAGER" }),
    },
    document: {
      count: async () => 0,
      findMany: async () => [],
    },
    $queryRaw: async () => [],
  };

  const originalPrismaFind = prisma.invoice.findFirst;
  const originalPrismaTx = prisma.$transaction;

  try {
    (prisma as any).invoice.findFirst = fakePrisma.invoice.findFirst;
    (prisma as any).$transaction = async (fn: any) => fn(fakePrisma);

    const result = await verifyManualBillReference(
      "inv_to_verify",
      {
        expected: {
          billingChannel: "MANUAL_EXTERNAL",
          externalDocumentType: "PAN_INVOICE",
          externalBillNo: "PB-2026-001",
          externalBillDate: "2026-10-04",
          billRecordStatus: "RECORDED",
        },
        reason: "Physical counter bill stamp verified",
      },
      managerActor,
      mockCapabilities,
    );

    assert.equal(result.billRecordStatus, "VERIFIED");
    assert.equal(updates.length, 1);
    assert.equal(updates[0].data.billRecordStatus, "VERIFIED");
    assert.equal(auditLogs[0].data.action, "MANUAL_BILL_REFERENCE_VERIFIED");
  } finally {
    (prisma as any).invoice.findFirst = originalPrismaFind;
    (prisma as any).$transaction = originalPrismaTx;
  }
});

test("withdrawManualBillReference: Reviewer can withdraw VERIFIED reference to PENDING or MISSING", async () => {
  const invoiceRow = buildMockInvoice({
    id: "inv_to_withdraw",
    billRecordStatus: "VERIFIED",
    externalBillNo: "PB-2026-001",
    externalDocumentType: "PAN_INVOICE",
    externalBillDate: new Date("2026-10-04T00:00:00.000Z"),
  });

  const updates: any[] = [];
  const auditLogs: any[] = [];

  const fakePrisma: any = {
    invoice: {
      findFirst: async () => ({
        ...invoiceRow,
        ...(updates[updates.length - 1]?.data || {}),
      }),
      findUnique: async () => ({
        ...invoiceRow,
        ...(updates[updates.length - 1]?.data || {}),
      }),
      findMany: async () => [],
      update: async (args: any) => {
        updates.push(args);
        return { ...invoiceRow, ...args.data };
      },
    },
    auditLog: {
      create: async (args: any) => {
        auditLogs.push(args);
        return { id: "audit_w", ...args.data };
      },
      findFirst: async () => null,
      findMany: async () => [],
    },
    user: {
      findUnique: async () => ({ name: "Manager One", role: "MANAGER" }),
    },
    document: {
      count: async () => 0,
      findMany: async () => [],
    },
    $queryRaw: async () => [],
  };

  const originalPrismaFind = prisma.invoice.findFirst;
  const originalPrismaTx = prisma.$transaction;

  try {
    (prisma as any).invoice.findFirst = fakePrisma.invoice.findFirst;
    (prisma as any).$transaction = async (fn: any) => fn(fakePrisma);

    const result = await withdrawManualBillReference(
      "inv_to_withdraw",
      {
        targetStatus: "PENDING",
        expected: {
          billingChannel: "MANUAL_EXTERNAL",
          externalDocumentType: "PAN_INVOICE",
          externalBillDate: "2026-10-04",
          externalBillNo: "PB-2026-001",
          billRecordStatus: "VERIFIED",
        },
        reason: "Reference entered on wrong customer invoice, reset for re-entry",
      },
      managerActor,
      mockCapabilities,
    );

    assert.equal(result.billRecordStatus, "PENDING");
    assert.equal(result.externalBillNo, null);
    assert.equal(result.externalDocumentType, null);
    assert.equal(updates[0].data.externalBillNo, null);
    assert.equal(updates[0].data.billRecordStatus, "PENDING");
    assert.equal(auditLogs[0].data.action, "MANUAL_BILL_REFERENCE_WITHDRAWN");
  } finally {
    (prisma as any).invoice.findFirst = originalPrismaFind;
    (prisma as any).$transaction = originalPrismaTx;
  }
});

test("Replay idempotency: Same-intent replay with matching prior audit returns existing record", async () => {
  const invoiceRow = buildMockInvoice({
    id: "inv_replay",
    billRecordStatus: "RECORDED",
    externalBillNo: "PB-2026-001",
    externalDocumentType: "PAN_INVOICE",
    externalBillDate: new Date("2026-10-04T00:00:00.000Z"),
  });

  const matchingAudit = {
    id: "audit_prior_1",
    action: "MANUAL_BILL_REFERENCE_RECORDED",
    meta: {
      current: {
        externalBillNo: "PB-2026-001",
        externalDocumentType: "PAN_INVOICE",
        externalBillDate: "2026-10-04",
      },
      previous: {
        billingChannel: "MANUAL_EXTERNAL",
        externalDocumentType: null,
        externalBillNo: null,
        externalBillDate: null,
        billRecordStatus: "PENDING",
      },
      reason: null,
      duplicateOverrideReason: null,
    },
  };

  const fakePrisma: any = {
    invoice: {
      findFirst: async () => invoiceRow,
      findUnique: async () => invoiceRow,
      findMany: async () => [],
      update: async () => {
        throw new Error("Update should not be called on same-intent replay");
      },
    },
    auditLog: {
      create: async () => {
        throw new Error("Audit log should not be created on same-intent replay");
      },
      findFirst: async () => matchingAudit,
      findMany: async () => [],
    },
    user: {
      findUnique: async () => ({ name: "Cashier One", role: "CASHIER" }),
    },
    document: {
      count: async () => 0,
      findMany: async () => [],
    },
    $queryRaw: async () => [],
  };

  const originalPrismaFind = prisma.invoice.findFirst;
  const originalPrismaTx = prisma.$transaction;

  try {
    (prisma as any).invoice.findFirst = fakePrisma.invoice.findFirst;
    (prisma as any).$transaction = async (fn: any) => fn(fakePrisma);

    const result = await recordManualBillReference(
      "inv_replay",
      {
        reference: {
          billNo: "PB-2026-001",
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
      },
      cashierActor,
      mockCapabilities,
    );

    assert.equal(result.externalBillNo, "PB-2026-001");
    assert.equal(result.billRecordStatus, "RECORDED");
  } finally {
    (prisma as any).invoice.findFirst = originalPrismaFind;
    (prisma as any).$transaction = originalPrismaTx;
  }
});

test("Stale-write conflict: Returns 409 STALE_RECORD_CONFLICT when expected differs from current DB state", async () => {
  const invoiceRow = buildMockInvoice({
    id: "inv_stale",
    billRecordStatus: "RECORDED",
    externalBillNo: "PB-2026-001",
    externalDocumentType: "PAN_INVOICE",
    externalBillDate: new Date("2026-10-04T00:00:00.000Z"),
  });

  const fakePrisma: any = {
    invoice: {
      findFirst: async () => invoiceRow,
      findUnique: async () => invoiceRow,
      findMany: async () => [],
    },
    auditLog: {
      findFirst: async () => null,
      findMany: async () => [],
    },
    user: {
      findUnique: async () => ({ name: "Manager One", role: "MANAGER" }),
    },
    document: {
      count: async () => 0,
      findMany: async () => [],
    },
    $queryRaw: async () => [],
  };

  const originalPrismaFind = prisma.invoice.findFirst;
  const originalPrismaTx = prisma.$transaction;

  try {
    (prisma as any).invoice.findFirst = fakePrisma.invoice.findFirst;
    (prisma as any).$transaction = async (fn: any) => fn(fakePrisma);

    await assert.rejects(
      async () => {
        await recordManualBillReference(
          "inv_stale",
          {
            reference: {
              billNo: "PB-2026-NEW",
              externalDocumentType: "PAN_INVOICE",
              externalBillDate: "2026-10-04",
            },
            expected: {
              billingChannel: "MANUAL_EXTERNAL",
              externalDocumentType: null,
              externalBillNo: null,
              externalBillDate: null,
              billRecordStatus: "PENDING", // Mismatch: DB has RECORDED
            },
            reason: "Attempting edit on stale record",
          },
          managerActor,
          mockCapabilities,
        );
      },
      (err: any) => {
        return (
          err instanceof ManualBillConflictError &&
          err.code === "STALE_RECORD_CONFLICT" &&
          err.statusCode === 409
        );
      },
    );
  } finally {
    (prisma as any).invoice.findFirst = originalPrismaFind;
    (prisma as any).$transaction = originalPrismaTx;
  }
});

test("IRD_ELECTRONIC billing channel rejection", async () => {
  const invoiceRow = buildMockInvoice({
    id: "inv_ird",
    billingChannel: "IRD_ELECTRONIC",
    billRecordStatus: null,
  });

  const fakePrisma: any = {
    invoice: {
      findFirst: async () => invoiceRow,
      findUnique: async () => invoiceRow,
      findMany: async () => [],
    },
    auditLog: {
      findFirst: async () => null,
      findMany: async () => [],
    },
    user: {
      findUnique: async () => ({ name: "Manager One", role: "MANAGER" }),
    },
    document: {
      findMany: async () => [],
    },
    $queryRaw: async () => [],
  };

  const originalPrismaFind = prisma.invoice.findFirst;
  const originalPrismaTx = prisma.$transaction;

  try {
    (prisma as any).invoice.findFirst = fakePrisma.invoice.findFirst;
    (prisma as any).$transaction = async (fn: any) => fn(fakePrisma);

    await assert.rejects(
      async () => {
        await recordManualBillReference(
          "inv_ird",
          {
            reference: {
              billNo: "PB-2026-001",
              externalDocumentType: "PAN_INVOICE",
              externalBillDate: "2026-10-04",
            },
            expected: {
              billingChannel: "IRD_ELECTRONIC",
              externalDocumentType: null,
              externalBillNo: null,
              externalBillDate: null,
              billRecordStatus: null,
            },
          },
          managerActor,
          mockCapabilities,
        );
      },
      (err: any) => {
        return (
          err instanceof ManualBillConflictError &&
          err.code === "UNSUPPORTED_BILLING_CHANNEL"
        );
      },
    );
  } finally {
    (prisma as any).invoice.findFirst = originalPrismaFind;
    (prisma as any).$transaction = originalPrismaTx;
  }
});

test("B-6 Audit history privacy: Manager and Cashier querying invoice with ADMIN_ONLY proof do not receive restricted proof or audit events", async () => {
  const invoiceRow = buildMockInvoice({
    id: "inv_privacy_check",
    billRecordStatus: "RECORDED",
  });

  const adminProofDoc = {
    id: "doc_admin_secret",
    title: "Confidential Tax Certificate",
    fileName: "secret.pdf",
    mimeType: "application/pdf",
    fileSize: 4096,
    thumbnailFileName: null,
    visibility: "ADMIN_ONLY",
    saleRecoveryStatus: "ATTACHED",
    createdAt: new Date("2026-10-04T10:00:00Z"),
  };

  const auditEvents = [
    {
      id: "audit_rec_1",
      action: "MANUAL_BILL_REFERENCE_RECORDED",
      actorId: "user_manager_1",
      actor: { id: "user_manager_1", name: "Manager One", role: "MANAGER" },
      meta: {
        invoiceNo: "INV-2026-1001",
        reason: "Initial record",
      },
      createdAt: new Date("2026-10-04T10:00:00Z"),
    },
    {
      id: "audit_attach_secret",
      action: "SALES_EVIDENCE_ATTACHED",
      actorId: "user_admin_1",
      actor: { id: "user_admin_1", name: "Admin One", role: "ADMIN" },
      meta: {
        invoiceNo: "INV-2026-1001",
        documentId: "doc_admin_secret",
        documentTitle: "Confidential Tax Certificate",
        reason: "Confidential audit attachment",
      },
      createdAt: new Date("2026-10-04T10:05:00Z"),
    },
  ];

  const fakePrisma: any = {
    invoice: {
      findFirst: async () => invoiceRow,
    },
    document: {
      findMany: async () => [adminProofDoc],
    },
    auditLog: {
      findMany: async () => auditEvents,
    },
  };

  // 1. Manager querying: ADMIN_ONLY is not visible to MANAGER
  const managerView = await getManualBillRecord(
    "inv_privacy_check",
    managerActor,
    fakePrisma,
    mockCapabilities,
  );
  assert.equal(managerView.attachedProofs.length, 0); // No restricted proof
  assert.equal(managerView.history.length, 1); // SALES_EVIDENCE_ATTACHED completely hidden
  assert.equal(managerView.history[0].action, "MANUAL_BILL_REFERENCE_RECORDED");

  // 2. Admin querying: ADMIN_ONLY is visible to ADMIN
  const adminView = await getManualBillRecord(
    "inv_privacy_check",
    adminActor,
    fakePrisma,
    mockCapabilities,
  );
  assert.equal(adminView.attachedProofs.length, 1);
  assert.equal(adminView.attachedProofs[0].id, "doc_admin_secret");
  assert.equal(adminView.history.length, 2);
  assert.equal(adminView.history[1].meta?.documentId, "doc_admin_secret");
});

test("Historical customer snapshot resolution: Walk-in null snapshot is preserved", async () => {
  const walkInInvoice = buildMockInvoice({
    id: "inv_walkin",
    customerId: "cust_current_id",
    customerSnapshotCapturedAt: new Date("2026-10-04T10:00:00Z"),
    customerNameSnapshot: null, // Walk-in snapshot captured as null
    customer: { name: "Live Renamed Customer" },
  });

  const legacyInvoice = buildMockInvoice({
    id: "inv_legacy",
    customerId: "cust_current_id",
    customerSnapshotCapturedAt: null, // Legacy invoice before snapshot capture
    customerNameSnapshot: null,
    customer: { name: "Live Customer Name" },
  });

  const fakePrisma: any = {
    invoice: {
      findFirst: async (args: any) => {
        if (args.where.id === "inv_walkin") return walkInInvoice;
        return legacyInvoice;
      },
      findUnique: async (args: any) => {
        if (args.where.id === "inv_walkin") return walkInInvoice;
        return legacyInvoice;
      },
    },
    document: {
      count: async () => 0,
      findMany: async () => [],
    },
    auditLog: {
      findMany: async () => [],
    },
  };

  const recordWalkIn = await getManualBillRecord("inv_walkin", managerActor, fakePrisma, mockCapabilities);
  assert.equal(recordWalkIn.customerName, null); // Preserved walk-in null

  const recordLegacy = await getManualBillRecord("inv_legacy", managerActor, fakePrisma, mockCapabilities);
  assert.equal(recordLegacy.customerName, "Live Customer Name"); // Fallback to live customer
});
