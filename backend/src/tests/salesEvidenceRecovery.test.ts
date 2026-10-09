import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import {
  paymentAssessmentSchema,
  recoveryCheckoutInputSchema,
  reviseSaleEvidenceRecoverySchema,
  saleEvidenceRecoverySchema,
} from "../modules/salesEvidence/validation";
import {
  assertSalesEvidenceRecoveryManager,
  getSaleEvidenceRecoveryOutcome,
  prepareAndPostSaleEvidenceRecovery,
  reviseSaleEvidenceRecoveryAttempt,
} from "../modules/salesEvidence/recovery";
import { checkoutInvoice } from "../modules/invoices/service";
import type { SalesEvidenceActor } from "../modules/salesEvidence/service";
import type { BusinessCapabilities } from "../modules/settings/capabilities";

const managerActor: SalesEvidenceActor = {
  id: "user-mgr-1",
  name: "Manager One",
  role: "MANAGER",
};

const otherManagerActor: SalesEvidenceActor = {
  id: "user-mgr-2",
  name: "Manager Two",
  role: "MANAGER",
};

const adminActor: SalesEvidenceActor = {
  id: "user-admin-1",
  name: "Admin One",
  role: "ADMIN",
};

const cashierActor: SalesEvidenceActor = {
  id: "user-cashier-1",
  name: "Cashier One",
  role: "CASHIER",
};

const posCapabilities = async (): Promise<BusinessCapabilities> => ({
  businessMode: "FULL_POS",
  catalogEnabled: true,
  inventoryEnabled: true,
  posEnabled: true,
  staffDraftRequestsEnabled: true,
  stockTracked: true,
});

const nonPosCapabilities = async (): Promise<BusinessCapabilities> => ({
  businessMode: "CATALOG_ONLY",
  catalogEnabled: true,
  inventoryEnabled: false,
  posEnabled: false,
  staffDraftRequestsEnabled: false,
  stockTracked: false,
});

test("assertSalesEvidenceRecoveryManager authorization rules", async (t) => {
  const originalUserFindUnique = prisma.user.findUnique;
  t.after(() => {
    prisma.user.findUnique = originalUserFindUnique;
  });

  prisma.user.findUnique = (async ({ where }: any) => {
    if (where.id === managerActor.id) {
      return { id: managerActor.id, role: "MANAGER", isActive: true };
    }
    if (where.id === "user-mgr-inactive") {
      return { id: "user-mgr-inactive", role: "MANAGER", isActive: false };
    }
    if (where.id === adminActor.id) {
      return { id: adminActor.id, role: "ADMIN", isActive: true };
    }
    if (where.id === cashierActor.id) {
      return { id: cashierActor.id, role: "CASHIER", isActive: true };
    }
    return null;
  }) as any;

  // Manager with POS capability passes
  await assert.doesNotReject(
    assertSalesEvidenceRecoveryManager(managerActor, posCapabilities),
  );

  // Inactive manager throws MANAGER_ROLE_REQUIRED
  await assert.rejects(
    assertSalesEvidenceRecoveryManager(
      { id: "user-mgr-inactive", role: "MANAGER", name: "Inactive Mgr" },
      posCapabilities,
    ),
    (err: any) => {
      assert.equal(err.code, "MANAGER_ROLE_REQUIRED");
      assert.equal(err.statusCode, 403);
      return true;
    },
  );

  // Admin throws MANAGER_ROLE_REQUIRED
  await assert.rejects(
    assertSalesEvidenceRecoveryManager(adminActor, posCapabilities),
    (err: any) => {
      assert.equal(err.code, "MANAGER_ROLE_REQUIRED");
      assert.equal(err.statusCode, 403);
      return true;
    },
  );

  // Cashier throws MANAGER_ROLE_REQUIRED
  await assert.rejects(
    assertSalesEvidenceRecoveryManager(cashierActor, posCapabilities),
    (err: any) => {
      assert.equal(err.code, "MANAGER_ROLE_REQUIRED");
      assert.equal(err.statusCode, 403);
      return true;
    },
  );

  // Manager with non-POS mode throws FEATURE_DISABLED
  await assert.rejects(
    assertSalesEvidenceRecoveryManager(managerActor, nonPosCapabilities),
    (err: any) => {
      assert.equal(err.code, "FEATURE_DISABLED");
      assert.equal(err.statusCode, 403);
      return true;
    },
  );
});

test("paymentAssessmentSchema validation", () => {
  // Valid current drawer cash
  const validCurrentCash = paymentAssessmentSchema.parse({
    type: "CURRENT_DRAWER_CASH",
    drawerId: "drawer-1",
    collectedAt: "2026-10-04T10:30:00Z",
    explanation: "Cash physically collected in active drawer",
    alreadyAccounted: false,
  });
  assert.equal(validCurrentCash.type, "CURRENT_DRAWER_CASH");

  // Valid not collected
  const validNotCollected = paymentAssessmentSchema.parse({
    type: "NOT_COLLECTED",
    explanation: "Unpaid customer credit bill",
  });
  assert.equal(validNotCollected.type, "NOT_COLLECTED");

  // Valid prior/other cash
  const validPriorCash = paymentAssessmentSchema.parse({
    type: "PRIOR_OR_OTHER_CASH",
    explanation: "Collected in morning shift drawer",
  });
  assert.equal(validPriorCash.type, "PRIOR_OR_OTHER_CASH");

  // Valid prior digital
  const validPriorDigital = paymentAssessmentSchema.parse({
    type: "PRIOR_DIGITAL",
    explanation: "eSewa payment confirmed earlier",
  });
  assert.equal(validPriorDigital.type, "PRIOR_DIGITAL");

  // Valid unknown
  const validUnknown = paymentAssessmentSchema.parse({
    type: "UNKNOWN",
    explanation: "Payment receipt status unknown",
  });
  assert.equal(validUnknown.type, "UNKNOWN");

  // Invalid assessment type
  assert.throws(() => {
    paymentAssessmentSchema.parse({ type: "CREDIT_CARD", explanation: "Invalid" });
  });
});

test("saleEvidenceRecoverySchema validation", () => {
  const validPayload = {
    reference: {
      billNo: "00123",
      externalDocumentType: "PAN_INVOICE",
      externalBillDate: "2026-10-04",
    },
    reason: "Power outage manual bill recovery",
    duplicateOverrideReason: undefined,
    paymentAssessment: {
      type: "CURRENT_DRAWER_CASH",
      drawerId: "drawer-1",
      collectedAt: "2026-10-04T10:30:00Z",
      explanation: "Cash received in active drawer",
      alreadyAccounted: false,
    },
    checkout: {
      items: [
        {
          productId: "prod-1",
          qty: 2,
          overrideUnitPrice: 150,
          overrideReason: "Agreed manual rate",
        },
      ],
      discountAmount: 0,
      payment: {
        method: "CASH",
        amount: 300,
      },
      confirmation: {
        payableTotal: 300,
        items: [
          {
            productId: "prod-1",
            qty: 2,
            appliedUnitPrice: 150,
          },
        ],
      },
    },
  };

  const parsed = saleEvidenceRecoverySchema.parse(validPayload);
  assert.equal(parsed.reference.billNo, "00123");
  assert.equal(parsed.checkout.items.length, 1);

  // Missing reason throws
  assert.throws(() => {
    saleEvidenceRecoverySchema.parse({
      ...validPayload,
      reason: "",
    });
  });

  // Short reason throws
  assert.throws(() => {
    saleEvidenceRecoverySchema.parse({
      ...validPayload,
      reason: "a",
    });
  });

  // Invalid date throws
  assert.throws(() => {
    saleEvidenceRecoverySchema.parse({
      ...validPayload,
      reference: {
        ...validPayload.reference,
        externalBillDate: "04-10-2026",
      },
    });
  });
});

test("ordinary checkoutInvoice rejects fresh rec_ recovery keys", async () => {
  await assert.rejects(
    checkoutInvoice("user-cashier-1", {
      operationKey: "rec_fresh_key_attempt",
      items: [{ productId: "p1", qty: 1 }],
      confirmation: {
        payableTotal: 100,
        items: [{ productId: "p1", qty: 1, appliedUnitPrice: 100 }],
      },
    }),
    (err: any) => {
      assert.match(err.message, /Recovery operation keys cannot be used/);
      return true;
    },
  );
});

test("getSaleEvidenceRecoveryOutcome status transitions", async (t) => {
  const originalFindUnique = prisma.document.findUnique;
  const originalFindFirst = prisma.document.findFirst;
  const originalFindMany = prisma.document.findMany;
  const originalAuditFindFirst = prisma.auditLog.findFirst;
  const originalAuditFindMany = prisma.auditLog.findMany;
  const originalInvoiceFindFirst = prisma.invoice.findFirst;
  const originalOpFindUnique = prisma.checkoutOperation.findUnique;

  t.after(() => {
    prisma.document.findUnique = originalFindUnique;
    prisma.document.findFirst = originalFindFirst;
    prisma.document.findMany = originalFindMany;
    prisma.auditLog.findFirst = originalAuditFindFirst;
    prisma.auditLog.findMany = originalAuditFindMany;
    prisma.invoice.findFirst = originalInvoiceFindFirst;
    prisma.checkoutOperation.findUnique = originalOpFindUnique;
  });

  prisma.document.findMany = (async () => []) as any;
  prisma.auditLog.findMany = (async () => []) as any;
  prisma.checkoutOperation.findUnique = (async () => null) as any;

  const baseDoc = {
    documentType: "SALE_BILL",
    title: "Bill Scan",
    description: null,
    notes: null,
    ocrText: null,
    ocrConfidence: null,
    processingStatus: "COMPLETED",
    documentRole: null,
    linkedEntityType: null,
    linkedEntityId: null,
    salesEvidenceInvoiceId: null,
    checkoutOperationId: null,
    recoveryArchiveReason: null,
    recoveryResolvedAt: null,
    deletedAt: null,
    visibility: "ADMIN_MANAGER",
    fileName: "doc.jpg",
    storedPath: "docs",
    storedFileName: "doc.jpg",
    mimeType: "image/jpeg",
    fileSize: 100,
    checksum: null,
    thumbnailFileName: null,
    thumbnailSize: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    uploadedById: "user-mgr-1",
    uploadedBy: { name: "Manager One" },
    salesEvidenceInvoice: null,
  };

  // 1. UNPREPARED document
  prisma.document.findFirst = (async () => ({
    ...baseDoc,
    id: "doc-unprepared",
    saleRecoveryStatus: "UNRESOLVED",
    recoveryCheckoutOperationKey: null,
    recoveryCheckoutPayloadHash: null,
  })) as any;

  const unpreparedOutcome = await getSaleEvidenceRecoveryOutcome(
    "doc-unprepared",
    managerActor,
    posCapabilities,
  );
  assert.ok(unpreparedOutcome);
  assert.equal(unpreparedOutcome.status, "UNPREPARED");
  assert.equal(unpreparedOutcome.retryEligible, true);
  assert.equal(unpreparedOutcome.invoice, null);

  // 2. PREPARED document
  prisma.document.findFirst = (async () => ({
    ...baseDoc,
    id: "doc-prepared",
    saleRecoveryStatus: "UNRESOLVED",
    recoveryCheckoutOperationKey: "rec_prepared_key",
    recoveryCheckoutPayloadHash: "hash-123",
  })) as any;

  prisma.auditLog.findFirst = (async () => ({
    id: "audit-prep-1",
    actorId: "user-mgr-1",
    action: "SALE_RECOVERY_ATTEMPT_PREPARED",
    meta: {
      operationKey: "rec_prepared_key",
      recoveryFingerprint: "hash-123",
      reason: "Initial review",
    },
    createdAt: new Date(),
  })) as any;

  const preparedOutcome = await getSaleEvidenceRecoveryOutcome(
    "doc-prepared",
    managerActor,
    posCapabilities,
  );
  assert.ok(preparedOutcome);
  assert.equal(preparedOutcome.status, "PREPARED");
  assert.equal(preparedOutcome.retryEligible, true);
  assert.equal(preparedOutcome.latestAttempt?.id, "audit-prep-1");

  // Read-only second reviewer
  const secondReviewerOutcome = await getSaleEvidenceRecoveryOutcome(
    "doc-prepared",
    otherManagerActor,
    posCapabilities,
  );
  assert.ok(secondReviewerOutcome);
  assert.equal(secondReviewerOutcome.status, "PREPARED");
  assert.equal(secondReviewerOutcome.retryEligible, false);

  // 3. COMMITTED document
  prisma.document.findFirst = (async () => ({
    ...baseDoc,
    id: "doc-committed",
    saleRecoveryStatus: "ATTACHED",
    recoveryCheckoutOperationKey: "rec_op_committed",
    recoveryCheckoutPayloadHash: "hash_rec_committed",
    salesEvidenceInvoiceId: "inv-recovered-1",
    linkedEntityType: "Invoice",
    linkedEntityId: "inv-recovered-1",
  })) as any;

  prisma.checkoutOperation.findUnique = (async () => ({
    id: "op-1",
    operationKey: "rec_op_committed",
    actorId: "user-mgr-1",
    completedAt: new Date(),
    invoiceId: "inv-recovered-1",
    payloadHash: "checkout_hash_1",
    responseJson: {},
  })) as any;

  prisma.auditLog.findFirst = (async (args: any) => {
    if (args?.where?.action?.in || args?.where?.action === "SALE_RECOVERY_ATTEMPT_PREPARED") {
      return {
        id: "audit-prep-1",
        actorId: "user-mgr-1",
        action: "SALE_RECOVERY_ATTEMPT_PREPARED",
        meta: { operationKey: "rec_op_committed", recoveryFingerprint: "hash_rec_committed" },
        createdAt: new Date(),
      };
    }
    if (args?.where?.action === "SALE_RECOVERY_POSTED") {
      return {
        id: "audit-post-1",
        actorId: "user-mgr-1",
        action: "SALE_RECOVERY_POSTED",
        meta: { operationKey: "rec_op_committed", recoveryFingerprint: "hash_rec_committed" },
        createdAt: new Date(),
      };
    }
    if (args?.where?.action === "SALE_RECOVERY_ATTACHED") {
      return {
        id: "audit-attach-1",
        actorId: "user-mgr-1",
        action: "SALE_RECOVERY_ATTACHED",
        meta: { invoiceId: "inv-recovered-1" },
        createdAt: new Date(),
      };
    }
    return null;
  }) as any;

  prisma.invoice.findFirst = (async () => ({
    id: "inv-recovered-1",
    invoiceNo: "INV-2026-REC-001",
    status: "FINALIZED",
    billingChannel: "MANUAL_EXTERNAL",
    externalDocumentType: "PAN_INVOICE",
    externalBillNo: "00123",
    externalBillDate: new Date("2026-10-04"),
    billRecordStatus: "VERIFIED",
    netTotal: 300,
    finalizedAt: new Date(),
    paymentStatus: "PAID",
    customerSnapshotCapturedAt: null,
    customerNameSnapshot: null,
    customerPanSnapshot: null,
    customer: null,
    cancelledAt: null,
    replacementInvoiceId: null,
    originalInvoiceId: null,
  })) as any;

  const committedOutcome = await getSaleEvidenceRecoveryOutcome(
    "doc-committed",
    managerActor,
    posCapabilities,
  );
  assert.ok(committedOutcome);
  assert.equal(committedOutcome.status, "COMMITTED");
  assert.equal(committedOutcome.retryEligible, false);
  assert.equal(committedOutcome.invoice?.invoiceNo, "INV-2026-REC-001");

  // 4. ARCHIVED document
  prisma.document.findFirst = (async () => ({
    ...baseDoc,
    id: "doc-archived",
    saleRecoveryStatus: "ARCHIVED",
  })) as any;

  const archivedOutcome = await getSaleEvidenceRecoveryOutcome(
    "doc-archived",
    managerActor,
    posCapabilities,
  );
  assert.ok(archivedOutcome);
  assert.equal(archivedOutcome.status, "ARCHIVED");
  assert.equal(archivedOutcome.retryEligible, false);
});

test("prepareAndPostSaleEvidenceRecovery policy guards for unsupported payment types", async (t) => {
  const originalUserFindUnique = prisma.user.findUnique;
  t.after(() => {
    prisma.user.findUnique = originalUserFindUnique;
  });

  prisma.user.findUnique = (async ({ where }: any) => {
    if (where.id === managerActor.id) {
      return { id: managerActor.id, role: "MANAGER", isActive: true };
    }
    return null;
  }) as any;

  const unsupportedTypes = ["PRIOR_OR_OTHER_CASH", "PRIOR_DIGITAL", "UNKNOWN"] as const;

  for (const pType of unsupportedTypes) {
    await assert.rejects(
      prepareAndPostSaleEvidenceRecovery(
        "doc-any",
        {
          reference: {
            billNo: "00123",
            externalDocumentType: "PAN_INVOICE",
            externalBillDate: "2026-10-04",
          },
          reason: "Testing policy block",
          paymentAssessment: {
            type: pType,
            explanation: `Testing ${pType} policy rejection`,
          },
          checkout: {
            items: [{ productId: "p1", qty: 1 }],
            confirmation: {
              payableTotal: 100,
              items: [{ productId: "p1", qty: 1, appliedUnitPrice: 100 }],
            },
          },
        },
        managerActor,
        posCapabilities,
      ),
      (err: any) => {
        assert.equal(err.code, "PAYMENT_RECONCILIATION_REQUIRED");
        assert.equal(err.statusCode, 409);
        return true;
      },
    );
  }
});
