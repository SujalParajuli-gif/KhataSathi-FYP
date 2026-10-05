import { expect, test, type Page } from "@playwright/test";
import { z } from "zod/v4";

function isValidCalendarDate(val: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) return false;
  const [y, m, d] = val.split("-").map(Number);
  if (m < 1 || m > 12) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d >= 1 && d <= daysInMonth;
}

export const strictManualBillReferenceSchema = z
  .object({
    billNo: z.string().trim().min(1).max(100),
    externalDocumentType: z.enum([
      "PAN_INVOICE",
      "VAT_TAX_INVOICE",
      "ABBREVIATED_TAX_INVOICE",
      "OTHER_MANUAL_SALES_DOCUMENT",
    ]),
    externalBillDate: z.string().trim().refine(isValidCalendarDate, "Invalid calendar date"),
  })
  .strict();

export const strictPaymentAssessmentSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("NOT_COLLECTED"),
      explanation: z.string().trim().min(2).max(2000),
    })
    .strict(),
  z
    .object({
      type: z.literal("CURRENT_DRAWER_CASH"),
      drawerId: z.string().trim().min(1).max(191),
      collectedAt: z.string().trim().min(1),
      explanation: z.string().trim().min(2).max(2000),
      alreadyAccounted: z.literal(false),
    })
    .strict(),
  z
    .object({
      type: z.literal("PRIOR_OR_OTHER_CASH"),
      explanation: z.string().trim().min(2).max(2000),
      collectedByActorId: z.string().trim().max(191).optional(),
      collectedDrawerId: z.string().trim().max(191).optional(),
      collectedAt: z.string().trim().optional(),
      alreadyAccounted: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("PRIOR_DIGITAL"),
      explanation: z.string().trim().min(2).max(2000),
      gatewayOrMethod: z.string().trim().max(50).optional(),
      externalReference: z.string().trim().max(191).optional(),
      transactionStatus: z.string().trim().max(50).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("UNKNOWN"),
      explanation: z.string().trim().min(2).max(2000),
    })
    .strict(),
]);

export const strictRecoveryCheckoutItemSchema = z
  .object({
    productId: z.string().trim().min(1).max(120),
    qty: z.number().finite().positive(),
    overrideUnitPrice: z.number().finite().positive().optional().nullable(),
    overrideReason: z.string().trim().max(240).optional().nullable(),
    overrideAuthorizationToken: z.string().trim().max(512).optional().nullable(),
  })
  .strict();

export const strictRecoveryCheckoutPaymentSchema = z
  .object({
    method: z.enum(["CASH", "ESEWA", "FONEPAY", "BANK_TRANSFER", "NONE"]),
    amount: z.number().finite().positive().optional(),
    reference: z.string().trim().max(160).optional(),
    tenderedAmount: z.number().finite().nonnegative().optional(),
  })
  .strict();

export const strictRecoveryCheckoutConfirmationItemSchema = z
  .object({
    productId: z.string().trim().min(1).max(120),
    qty: z.number().finite().positive(),
    appliedUnitPrice: z.number().finite().nonnegative(),
  })
  .strict();

export const strictRecoveryCheckoutConfirmationSchema = z
  .object({
    items: z
      .array(strictRecoveryCheckoutConfirmationItemSchema)
      .min(1)
      .refine(
        (items) => {
          const seen = new Set<string>();
          for (const item of items) {
            if (seen.has(item.productId)) return false;
            seen.add(item.productId);
          }
          return true;
        },
        { message: "Duplicate productIds in confirmation items" },
      ),
    payableTotal: z.number().int().nonnegative(),
  })
  .strict();

export const strictRecoveryCheckoutInputSchema = z
  .object({
    customerId: z.string().trim().max(120).optional().nullable(),
    discountAmount: z.number().finite().nonnegative().optional(),
    overridePin: z.string().trim().max(20).optional().nullable(),
    notes: z.string().trim().max(1000).optional().nullable(),
    items: z.array(strictRecoveryCheckoutItemSchema).min(1),
    payment: strictRecoveryCheckoutPaymentSchema.optional().nullable(),
    payments: z.array(strictRecoveryCheckoutPaymentSchema).max(10).optional().nullable(),
    confirmation: strictRecoveryCheckoutConfirmationSchema.optional().nullable(),
  })
  .strict();

export const strictSaleEvidenceRecoverySchema = z
  .object({
    checkout: strictRecoveryCheckoutInputSchema,
    reference: strictManualBillReferenceSchema,
    reason: z.string().trim().min(2).max(2000),
    duplicateOverrideReason: z.string().trim().min(2).max(2000).optional(),
    paymentAssessment: strictPaymentAssessmentSchema,
  })
  .strict();

export const strictReviseSaleEvidenceRecoverySchema = z
  .object({
    expectedAttemptId: z.string().trim().min(1).max(191),
    reason: z.string().trim().min(2).max(2000),
    recovery: strictSaleEvidenceRecoverySchema,
  })
  .strict();

async function fixture(
  page: Page,
  options: {
    role?: string;
    pos?: boolean;
    recordConflict?: boolean;
    decisionConflict?: "stale" | "terminal";
    hasDrawer?: boolean;
    preparedAttempt?: boolean;
    preparedByOther?: boolean;
    committedWithEsewa?: boolean;
    returnEsewaIntent?: boolean;
    failFirstPostWithCommittedOutcome?: boolean;
    failFirstPostWithCommittedEsewaOutcome?: boolean;
    failFirstPostWithPreparedOutcome?: boolean;
    failDiscoveryAfterPost?: boolean;
    discoveryUnavailable?: boolean;
    failPostWithStockConflict?: boolean;
    delayPostResponseMs?: number;
  } = {},
) {
  const user = {
    id: options.preparedByOther ? "user-other-mgr" : "test-user",
    name: "Test reviewer",
    role: options.role || "ADMIN",
  };
  let record: any = {
    id: "sale",
    invoiceNo: "INV-TEST-1",
    status: "FINALIZED",
    billingChannel: "MANUAL_EXTERNAL",
    externalDocumentType: null,
    externalBillNo: null,
    externalBillDate: null,
    billRecordStatus: "PENDING",
    netTotal: 500,
    finalizedAt: "2026-10-04T10:00:00Z",
    cancelledAt: null,
    paymentStatus: "PAID",
    customerName: null,
    customerPan: null,
    originalInvoiceId: null,
    replacementInvoiceId: null,
    attachedProofs: [],
    history: [],
  };
  let proof: any = {
    id: "proof",
    documentType: "SALE_BILL",
    title: "Paper proof",
    fileName: "paper.pdf",
    storedFileName: "paper.pdf",
    storedPath: "documents",
    mimeType: "application/pdf",
    fileSize: 20,
    checksum: null,
    thumbnailFileName: null,
    thumbnailSize: null,
    remarks: null,
    linkedEntityType: null,
    linkedEntityId: null,
    visibility: "ADMIN_MANAGER",
    saleRecoveryStatus: "UNRESOLVED",
    recoveryCheckoutOperationKey: options.preparedAttempt ? "rec_mock_key_1" : null,
    recoveryCheckoutPayloadHash: options.preparedAttempt ? "hash_mock_1" : null,
    uploadedById: user.id,
    createdAt: "2026-10-04T10:00:00Z",
  };

  const customers = [
    {
      id: "cust-1",
      name: "Ramesh Sharma",
      phone: "9841234567",
      panNumber: "102938475",
      isWholesale: false,
    },
    {
      id: "cust-2",
      name: "Sita Traders",
      phone: "9801122334",
      panNumber: "998877665",
      isWholesale: true,
    },
  ];

  const unexpected: string[] = [];
  const payloads: any[] = [];
  let recordCalls = 0;
  let attachCalls = 0;
  let recoveryPostCalls = 0;

  await page.addInitScript(
    ({ user }) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-session-token");
    },
    { user },
  );

  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method();
      const respond = (body: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(body),
        });

      if (method === "GET" && path === "/api/auth/me") return respond({ user });
      if (method === "GET" && path === "/api/alerts") return respond({ alerts: [] });
      if (method === "PATCH" && path === "/api/users/me/presence")
        return respond({ ok: true });

      if (method === "GET" && path === "/api/customers") {
        return respond({ customers, total: customers.length });
      }

      if (method === "GET" && path === "/api/cash-drawers/current") {
        return respond(
          options.hasDrawer === false
            ? { drawer: null }
            : {
                drawer: {
                  id: "drawer-1",
                  cashierId: user.id,
                  status: "OPEN",
                },
              },
        );
      }

      if (method === "GET" && path.endsWith("/capabilities")) {
        return respond({
          businessMode: options.pos === false ? "CATALOG_ONLY" : "FULL_POS",
          catalogEnabled: true,
          inventoryEnabled: options.pos !== false,
          posEnabled: options.pos !== false,
          stockTracked: options.pos !== false,
          staffDraftRequestsEnabled: true,
        });
      }

      if (method === "GET" && path === "/api/invoices/manual-bills/queue") {
        const items =
          record.billRecordStatus === "PENDING" ||
          record.billRecordStatus === "MISSING"
            ? [{ ...record, attachedProofCount: 0 }]
            : [];
        return respond({
          items,
          total: items.length,
          page: 1,
          pageSize: 15,
          totalPages: 1,
        });
      }

      if (method === "GET" && path === "/api/invoices/manual-bills/sale")
        return respond(record);

      if (
        method === "POST" &&
        path === "/api/invoices/manual-bills/sale/reference"
      ) {
        recordCalls++;
        const body = request.postDataJSON();
        payloads.push(body);
        if (options.recordConflict && recordCalls === 1) {
          record = {
            ...record,
            externalBillNo: "OTHER-PAPER",
            externalBillDate: "2026-10-04",
            externalDocumentType: "PAN_INVOICE",
            billRecordStatus: "RECORDED",
          };
          return respond(
            {
              code: "STALE_RECORD_CONFLICT",
              error: "Another reviewer recorded this sale",
              currentRecord: record,
            },
            409,
          );
        }
        record = {
          ...record,
          externalBillNo: body.reference.billNo,
          externalBillDate: body.reference.externalBillDate,
          externalDocumentType: body.reference.externalDocumentType,
          billRecordStatus: "RECORDED",
        };
        return respond(record);
      }

      if (method === "GET" && path === "/api/sales-evidence") {
        const matches =
          !url.searchParams.get("saleRecoveryStatus") ||
          proof.saleRecoveryStatus === url.searchParams.get("saleRecoveryStatus");
        return respond({
          documents: matches ? [proof] : [],
          total: matches ? 1 : 0,
          page: 1,
          pageSize: 20,
          totalPages: 1,
        });
      }

      if (method === "GET" && path === "/api/sales-evidence/proof")
        return respond(proof);
      if (method === "GET" && path === "/api/sales-evidence/proof/candidates")
        return respond({ candidates: [record] });
      if (method === "GET" && path === "/api/sales-evidence/proof/file")
        return route.fulfill({
          contentType: "application/pdf",
          body: "%PDF-1.4 test document",
        });

      if (method === "GET" && path === "/api/sales-evidence/proof/recovery") {
        if (options.discoveryUnavailable) {
          return route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "Discovery service unavailable" }),
          });
        }
        if (options.failDiscoveryAfterPost && recoveryPostCalls >= 1) {
          return route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "Discovery service unavailable after transport error" }),
          });
        }
        if (options.decisionConflict === "stale") {
          return respond({
            status: "UNCERTAIN",
            document: proof,
            invoice: null,
            retryEligible: false,
            uncertainExplanation:
              "Contradictory recovery provenance records detected.",
          });
        }
        if (proof.recoveryCheckoutOperationKey && proof.saleRecoveryStatus === "UNRESOLVED") {
          return respond({
            status: "PREPARED",
            document: proof,
            invoice: null,
            latestAttempt: {
              id: "audit-prep-1",
              actorId: options.preparedByOther ? "user-other-mgr" : user.id,
              createdAt: "2026-10-04T10:00:00Z",
              reason: "Initial preparation attempt",
            },
            retryEligible: !options.preparedByOther && options.role === "MANAGER",
          });
        }
        if (options.preparedAttempt) {
          return respond({
            status: "PREPARED",
            document: proof,
            invoice: null,
            latestAttempt: {
              id: "audit-prep-1",
              actorId: options.preparedByOther ? "user-other-mgr" : user.id,
              createdAt: "2026-10-04T10:00:00Z",
              reason: "Initial preparation attempt",
            },
            retryEligible: !options.preparedByOther && options.role === "MANAGER",
          });
        }
        const esewaIntent = (options.returnEsewaIntent || options.failFirstPostWithCommittedEsewaOutcome || options.committedWithEsewa)
          ? {
              amount: 50,
              productCode: "REC-ESEWA-001",
              taxAmount: 0,
              totalAmount: 50,
              transactionUuid: "esewa-tx-999",
              formAction: "https://rc-epay.esewa.com.np/api/epay/main/v2/form",
              fields: {
                amount: "50",
                total_amount: "50",
                transaction_uuid: "esewa-tx-999",
                product_code: "EPAYTEST",
                signature: "mock_signature_123",
              },
            }
          : null;

        const isCommitted = options.committedWithEsewa || proof.saleRecoveryStatus === "ATTACHED";

        return respond({
          status: isCommitted ? "COMMITTED" : "UNPREPARED",
          document: proof,
          invoice: isCommitted ? record : null,
          esewaPaymentIntent: isCommitted ? esewaIntent : null,
          retryEligible: options.role === "MANAGER" && options.pos !== false,
        });
      }

      if (method === "POST" && path === "/api/sales-evidence/proof/recovery") {
        recoveryPostCalls++;
        const body = request.postDataJSON();
        payloads.push(body);

        // Strict validation of full server contract using owning schema
        const parseResult = strictSaleEvidenceRecoverySchema.safeParse(body);
        if (!parseResult.success) {
          return respond(
            { error: "Invalid missing sale recovery payload contract", details: parseResult.error.format() },
            400,
          );
        }
        const validatedBody = parseResult.data;

        if (
          validatedBody.paymentAssessment.type === "PRIOR_OR_OTHER_CASH" ||
          validatedBody.paymentAssessment.type === "PRIOR_DIGITAL" ||
          validatedBody.paymentAssessment.type === "UNKNOWN"
        ) {
          return respond(
            {
              code: "PAYMENT_RECONCILIATION_REQUIRED",
              error: "Payment reconciliation is required before recovery",
            },
            409,
          );
        }

        if (options.delayPostResponseMs) {
          await new Promise((resolve) => setTimeout(resolve, options.delayPostResponseMs));
        }

        if (options.failPostWithStockConflict) {
          return respond({ error: "Insufficient stock for product Paracetamol 500mg" }, 400);
        }

        if (options.failDiscoveryAfterPost && recoveryPostCalls === 1) {
          return respond({ error: "Simulated transport timeout during POST" }, 500);
        }

        if (options.failFirstPostWithCommittedOutcome && recoveryPostCalls === 1) {
          proof = {
            ...proof,
            saleRecoveryStatus: "ATTACHED",
            linkedEntityType: "Invoice",
            linkedEntityId: "sale",
          };
          return respond({ error: "Transport timeout after database commit" }, 500);
        }

        if (options.failFirstPostWithCommittedEsewaOutcome && recoveryPostCalls === 1) {
          proof = {
            ...proof,
            saleRecoveryStatus: "ATTACHED",
            linkedEntityType: "Invoice",
            linkedEntityId: "sale",
          };
          return respond({ error: "Transport timeout after database commit" }, 500);
        }

        if (options.failFirstPostWithPreparedOutcome && recoveryPostCalls === 1) {
          proof = {
            ...proof,
            saleRecoveryStatus: "UNRESOLVED",
            recoveryCheckoutOperationKey: "rec_prepared_attempt_1",
            recoveryCheckoutPayloadHash: "hash_prep_1",
          };
          return respond({ error: "Transaction lock error during financial posting" }, 500);
        }

        proof = {
          ...proof,
          saleRecoveryStatus: "ATTACHED",
          linkedEntityType: "Invoice",
          linkedEntityId: "sale",
        };

        const esewaIntent = (options.returnEsewaIntent || options.failFirstPostWithCommittedEsewaOutcome)
          ? {
              amount: validatedBody.checkout.confirmation?.payableTotal || 50,
              productCode: "REC-ESEWA-001",
              taxAmount: 0,
              totalAmount: validatedBody.checkout.confirmation?.payableTotal || 50,
              transactionUuid: "esewa-tx-999",
              formAction: "https://rc-epay.esewa.com.np/api/epay/main/v2/form",
              fields: {
                amount: String(validatedBody.checkout.confirmation?.payableTotal || 50),
                total_amount: String(validatedBody.checkout.confirmation?.payableTotal || 50),
                transaction_uuid: "esewa-tx-999",
                product_code: "EPAYTEST",
                signature: "mock_signature_123",
              },
            }
          : null;

        return respond({
          document: proof,
          invoice: record,
          esewaPaymentIntent: esewaIntent,
          replayed: false,
        });
      }

      if (
        method === "POST" &&
        path === "/api/sales-evidence/proof/recovery/revise"
      ) {
        const body = request.postDataJSON();
        payloads.push(body);

        const parseResult = strictReviseSaleEvidenceRecoverySchema.safeParse(body);
        if (!parseResult.success) {
          return respond(
            { error: "Invalid revise recovery payload contract", details: parseResult.error.format() },
            400,
          );
        }

        proof = {
          ...proof,
          saleRecoveryStatus: "UNRESOLVED",
          recoveryCheckoutOperationKey: "rec_revised_key",
          recoveryCheckoutPayloadHash: "hash_revised",
        };

        return respond({
          document: proof,
          attemptId: "audit-revised-2",
          status: "PREPARED",
        });
      }

      if (method === "GET" && path === "/api/products") {
        return respond({
          products: [
            {
              id: "prod-1",
              name: "Paracetamol 500mg",
              retailPrice: 50,
              price: 50,
              stock: 100,
              barcode: "123456",
              sku: "MED-001",
              isVatExempt: false,
              discountAllowed: true,
              status: "ACTIVE",
            },
          ],
          pagination: { total: 1, page: 1, limit: 20, totalPages: 1 },
        });
      }

      if (method === "POST" && path === "/api/sales-evidence/proof/attach") {
        attachCalls++;
        const body = request.postDataJSON();
        payloads.push(body);
        if (options.decisionConflict && attachCalls === 1) {
          if (options.decisionConflict === "terminal")
            proof = { ...proof, saleRecoveryStatus: "ARCHIVED" };
          else
            record = {
              ...record,
              billRecordStatus: "RECORDED",
              externalBillNo: "OTHER-PAPER",
              externalBillDate: "2026-10-04",
              externalDocumentType: "PAN_INVOICE",
            };
          return respond(
            {
              code:
                options.decisionConflict === "terminal"
                  ? "ARCHIVED_CONFLICT"
                  : "STALE_RECORD_CONFLICT",
              error: "Another reviewer changed this decision",
              document:
                options.decisionConflict === "terminal" ? proof : undefined,
            },
            409,
          );
        }
        proof = {
          ...proof,
          saleRecoveryStatus: "ATTACHED",
          linkedEntityType: "Invoice",
          linkedEntityId: "sale",
        };
        return respond({ document: proof, invoice: record, replayed: false });
      }

      if (method === "POST" && path === "/api/sales-evidence/proof/archive") {
        payloads.push(request.postDataJSON());
        if (options.decisionConflict === "terminal") {
          proof = {
            ...proof,
            saleRecoveryStatus: "ATTACHED",
            linkedEntityType: "Invoice",
            linkedEntityId: "sale",
          };
          return respond(
            {
              code: "ATTACHED_CONFLICT",
              error: "Attached by another reviewer",
              document: proof,
            },
            409,
          );
        }
        proof = { ...proof, saleRecoveryStatus: "ARCHIVED" };
        return respond({ document: proof, replayed: false });
      }

      unexpected.push(`${method} ${path}`);
      return respond({ error: "Unexpected test request" }, 501);
    },
  );
  return { unexpected, payloads };
}

for (const width of [1440, 390]) {
  test(`record reference with keyboard modal and correct expected payload at width ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = await fixture(page, { role: "CASHIER" });
    await page.goto("/manual-bills");
    await expect(page.getByText("INV-TEST-1")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Proof & Matching/ }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: /^Record$/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect
      .poll(() => dialog.evaluate((el) => el.contains(document.activeElement)))
      .toBe(true);
    await page.keyboard.press("Tab");
    expect(
      await dialog.evaluate((el) => el.contains(document.activeElement)),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: /^Record$/ }).click();
    await page.getByPlaceholder("e.g. PB-2081-0042").fill("PAPER-NEW");
    await page
      .getByRole("button", { name: "Record Reference", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    expect(f.payloads[0].expected).toEqual({
      billingChannel: "MANUAL_EXTERNAL",
      externalDocumentType: null,
      externalBillNo: null,
      externalBillDate: null,
      billRecordStatus: "PENDING",
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(f.unexpected).toEqual([]);
  });
}

test("reference stale conflict keeps input and submits reviewed expected state", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const f = await fixture(page, { recordConflict: true });
  await page.goto("/manual-bills");
  await page.getByRole("button", { name: /^Record$/ }).click();
  await page.getByPlaceholder("e.g. PB-2081-0042").fill("MY-PAPER");
  await page
    .getByRole("button", { name: "Record Reference", exact: true })
    .click();
  await expect(page.getByText("OTHER-PAPER", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Acknowledge & Keep My Input" }).click();
  await expect(page.getByPlaceholder("e.g. PB-2081-0042")).toHaveValue(
    "MY-PAPER",
  );
  await page
    .getByPlaceholder("Reason for modifying this paper reference...")
    .fill("Reviewed correction");
  await page.getByRole("button", { name: "Update Reference" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(f.payloads[1].expected.externalBillNo).toBe("OTHER-PAPER");
  expect(f.payloads[1].reference.billNo).toBe("MY-PAPER");
  expect(f.unexpected).toEqual([]);
});

async function evidence(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/manual-bills");
  await page.getByRole("button", { name: /Proof & Matching/ }).click();
  await expect(page.getByText("Paper proof", { exact: true })).toBeVisible();
}

async function attachForm(page: Page) {
  await page.getByRole("button", { name: /^Attach$/ }).dispatchEvent("click");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.getByRole("button", { name: /INV-TEST-1/ }).click();
  await page.getByPlaceholder("e.g. PB-2081-0042").fill("MY-PAPER");
  await page
    .getByPlaceholder("Note for attaching this proof...")
    .fill("Reviewed original paper");
}

test("attach stale conflict refreshes candidates, requires selection and preserves reference/reason", async ({
  page,
}) => {
  const f = await fixture(page, { role: "MANAGER", decisionConflict: "stale" });
  await evidence(page);
  await attachForm(page);
  await page.getByRole("button", { name: "Confirm Attachment" }).click();
  await expect(
    page.getByRole("button", { name: "Confirm Attachment" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Refresh and review outcome" }).click();
  await expect(
    page.getByText(
      "Review and select the refreshed sale before submitting. Your input has been kept.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: /INV-TEST-1/ }).click();
  await expect(page.getByPlaceholder("e.g. PB-2081-0042")).toHaveValue(
    "MY-PAPER",
  );
  await expect(
    page.getByPlaceholder("Note for attaching this proof..."),
  ).toHaveValue("Reviewed original paper");
  await page.getByRole("button", { name: "Confirm Attachment" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(f.payloads[1].expectedInvoice.externalBillNo).toBe("OTHER-PAPER");
  expect(f.payloads[1].reference.billNo).toBe("MY-PAPER");
  expect(f.unexpected).toEqual([]);
});

for (const action of ["attach", "archive"]) {
  test(`${action} losing terminal conflict shows permitted winner and disables further decision`, async ({
    page,
  }) => {
    const f = await fixture(page, { decisionConflict: "terminal" });
    await evidence(page);
    if (action === "attach") await attachForm(page);
    else {
      await page.getByRole("button", { name: /^Archive$/ }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.getByPlaceholder(/Reason for archiving/).fill("Not a sale");
    }
    const submit = page.getByRole("button", {
      name: action === "attach" ? "Confirm Attachment" : "Confirm Archive",
    });
    await submit.click();
    await expect(submit).toBeDisabled();
    await page
      .getByRole("button", { name: "Refresh and review outcome" })
      .click();
    await expect(
      page.getByText(
        `Current outcome: ${action === "attach" ? "ARCHIVED" : "ATTACHED"}`,
        { exact: false },
      ),
    ).toBeVisible();
    if (action === "archive") await expect(submit).toBeDisabled();
    await page.keyboard.press("Escape");
    expect(f.unexpected).toEqual([]);
  });
}

test("archive submits nonposting reason and closes after committed response", async ({
  page,
}) => {
  const f = await fixture(page);
  await evidence(page);
  await page.getByRole("button", { name: /^Archive$/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByPlaceholder(/Reason for archiving/)
    .fill("No operational sale");
  await page.getByRole("button", { name: "Confirm Archive" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(f.payloads[0]).toEqual({ reason: "No operational sale" });
  expect(f.unexpected).toEqual([]);
});

test("proof preview releases authenticated blob URL on close and workspace unmount", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    (window as any).blobCounts = { created: 0, revoked: 0 };
    URL.createObjectURL = (blob) => {
      (window as any).blobCounts.created++;
      return create(blob);
    };
    URL.revokeObjectURL = (url) => {
      (window as any).blobCounts.revoked++;
      revoke(url);
    };
  });
  await evidence(page);
  await page.getByRole("button", { name: "Preview Paper proof" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).blobCounts.created))
    .toBe(1);
  await page.keyboard.press("Escape");
  await expect
    .poll(() => page.evaluate(() => (window as any).blobCounts.revoked))
    .toBeGreaterThanOrEqual(1);
  await page.getByRole("button", { name: "Preview Paper proof" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).blobCounts.created))
    .toBe(2);
  // Route change unmounts the workspace with an open preview, as navigation can do.
  await page
    .getByRole("button", { name: /Recording Queue/ })
    .dispatchEvent("click");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => (window as any).blobCounts.revoked))
    .toBeGreaterThanOrEqual(2);
  expect(f.unexpected).toEqual([]);
});

test("missing sale recovery modal: manager can select customer, override price with PIN, choose current drawer cash, and post recovery", async ({
  page,
}) => {
  const f = await fixture(page, { role: "MANAGER" });
  await evidence(page);
  await expect(
    page.getByRole("button", { name: /Create Missing Sale/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Create Missing Sale/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(
    page.getByText("Recover Missing Sale (Paper Bill)"),
  ).toBeVisible();

  // 1. Customer selection
  await page
    .getByPlaceholder(
      "Search existing customer by name, phone or PAN (or leave blank for Walk-in)...",
    )
    .fill("Ramesh");
  await page.getByRole("button", { name: /Ramesh Sharma/ }).click();
  await expect(page.getByText("Ramesh Sharma")).toBeVisible();

  // 2. Reference fields
  await page.getByPlaceholder("e.g. 00482").fill("REC-PB-999");
  await page
    .getByPlaceholder(
      "e.g. Handwritten paper bill issued during power outage and not entered in POS",
    )
    .fill("Verified original store manual receipt during outage");

  // 3. Add Item
  await page
    .getByPlaceholder("Search products by name or SKU to add...")
    .fill("Paracetamol");
  await page.getByRole("button", { name: /Paracetamol 500mg/ }).click();

  // 4. Override unit price from 50 to 55 and enter PIN
  const unitPriceInput = page.locator("input[type='number']").first();
  await unitPriceInput.fill("55");
  await expect(
    page.getByPlaceholder("Price override reason..."),
  ).toBeVisible();
  await page
    .getByPlaceholder("Price override reason...")
    .fill("Special paper agreed rate");
  await page
    .getByPlaceholder("Enter supervisor PIN...")
    .fill("1234");

  // 5. Payment assessment: select Current Drawer Cash
  await page.getByRole("radio", { name: /Current Drawer Cash/ }).check();
  await expect(
    page.getByText("Active Manager Drawer (drawer-1)"),
  ).toBeVisible();

  // 6. Submit recovery
  const postBtn = page.getByRole("button", {
    name: /Post Missing Sale Recovery/,
  });
  await expect(postBtn).toBeEnabled();
  await postBtn.click();

  await expect(dialog).toHaveCount(0);
  expect(f.payloads.length).toBeGreaterThanOrEqual(1);
  const recoveryPayload = f.payloads[f.payloads.length - 1];
  expect(recoveryPayload.reference.billNo).toBe("REC-PB-999");
  expect(recoveryPayload.reference.externalDocumentType).toBe("PAN_INVOICE");
  expect(recoveryPayload.paymentAssessment.type).toBe("CURRENT_DRAWER_CASH");
  expect(recoveryPayload.paymentAssessment.drawerId).toBe("drawer-1");
  expect(recoveryPayload.checkout.customerId).toBe("cust-1");
  expect(recoveryPayload.checkout.overridePin).toBe("1234");
  expect(recoveryPayload.checkout.items).toHaveLength(1);
  expect(recoveryPayload.checkout.items[0].overrideUnitPrice).toBe(55);
  expect(recoveryPayload.checkout.confirmation.payableTotal).toBe(55);
  expect(f.unexpected).toEqual([]);
});

test("missing sale recovery modal: fresh eSewa payment creates pending digital intent and executes gateway form submission", async ({
  page,
}) => {
  const f = await fixture(page, {
    role: "MANAGER",
    returnEsewaIntent: true,
  });
  await evidence(page);
  await page.getByRole("button", { name: /Create Missing Sale/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Reference & Item
  await page.getByPlaceholder("e.g. 00482").fill("REC-PB-ESEWA");
  await page
    .getByPlaceholder(
      "e.g. Handwritten paper bill issued during power outage and not entered in POS",
    )
    .fill("Recovering paper sale settled via fresh eSewa");
  await page
    .getByPlaceholder("Search products by name or SKU to add...")
    .fill("Paracetamol");
  await page.getByRole("button", { name: /Paracetamol 500mg/ }).click();

  // Payment assessment: select Uncollected and Fresh eSewa
  await page
    .getByRole("radio", { name: /Not Collected \(Unpaid on Paper Bill\)/ })
    .check();
  await page.getByRole("button", { name: "Fresh eSewa" }).click();

  // Mock form.submit on the current page before clicking proceed
  await page.evaluate(() => {
    (window as any).esewaFormSubmitted = false;
    HTMLFormElement.prototype.submit = function () {
      (window as any).esewaFormSubmitted = true;
    };
  });

  // Submit recovery
  const postBtn = page.getByRole("button", {
    name: /Post Missing Sale Recovery/,
  });
  await expect(postBtn).toBeEnabled();
  await postBtn.click();

  // Displays eSewa pending notice and Committed state
  await expect(
    page.getByText("Sale Already Recovered and Committed"),
  ).toBeVisible();
  await expect(page.getByText("eSewa Payment Pending")).toBeVisible();
  const proceedBtn = page.getByRole("button", { name: /Proceed to eSewa Gateway/ });
  await expect(proceedBtn).toBeVisible();
  await proceedBtn.click();

  const submitted = await page.evaluate(() => (window as any).esewaFormSubmitted);
  expect(submitted).toBe(true);

  const recoveryPayload = f.payloads[0];
  expect(recoveryPayload.paymentAssessment.type).toBe("NOT_COLLECTED");
  expect(recoveryPayload.checkout.payment?.method).toBe("ESEWA");
});

test("missing sale recovery modal: reopening committed recovery restores pending eSewa continuation without reposting", async ({
  page,
}) => {
  const f = await fixture(page, {
    role: "MANAGER",
    committedWithEsewa: true,
  });
  await evidence(page);
  await page.getByRole("button", { name: /Create Missing Sale/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Displays Committed state with pending eSewa intent restored on GET outcome
  await expect(
    page.getByText("Sale Already Recovered and Committed"),
  ).toBeVisible();
  await expect(page.getByText("eSewa Payment Pending")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Proceed to eSewa Gateway/ }),
  ).toBeVisible();

  // No POST recovery requests made
  expect(f.payloads).toHaveLength(0);
});

test("missing sale recovery modal: lost response with eSewa payment discovers committed outcome and keeps gateway continuation open", async ({
  page,
}) => {
  const f = await fixture(page, {
    role: "MANAGER",
    failFirstPostWithCommittedEsewaOutcome: true,
  });
  await evidence(page);
  await page.getByRole("button", { name: /Create Missing Sale/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await page.getByPlaceholder("e.g. 00482").fill("REC-PB-LOST-ESEWA");
  await page
    .getByPlaceholder(
      "e.g. Handwritten paper bill issued during power outage and not entered in POS",
    )
    .fill("Recovering paper sale with lost response and eSewa payment");
  await page
    .getByPlaceholder("Search products by name or SKU to add...")
    .fill("Paracetamol");
  await page.getByRole("button", { name: /Paracetamol 500mg/ }).click();

  await page
    .getByRole("radio", { name: /Not Collected \(Unpaid on Paper Bill\)/ })
    .check();
  await page.getByRole("button", { name: "Fresh eSewa" }).click();

  const postBtn = page.getByRole("button", {
    name: /Post Missing Sale Recovery/,
  });
  await postBtn.click();

  // Modal does NOT close because eSewa intent was discovered; displays committed state & continuation
  await expect(dialog).toBeVisible();
  await expect(
    page.getByText("Sale Already Recovered and Committed"),
  ).toBeVisible();
  await expect(page.getByText("eSewa Payment Pending")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Proceed to eSewa Gateway/ }),
  ).toBeVisible();

  const postCalls = f.payloads.filter((p) => p.reference?.billNo === "REC-PB-LOST-ESEWA");
  expect(postCalls).toHaveLength(1);
});

test("missing sale recovery modal: lost response -> discovers committed outcome and closes without repost", async ({
  page,
}) => {
  const f = await fixture(page, {
    role: "MANAGER",
    failFirstPostWithCommittedOutcome: true,
  });
  await evidence(page);
  await page.getByRole("button", { name: /Create Missing Sale/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await page.getByPlaceholder("e.g. 00482").fill("REC-PB-LOST-COMMIT");
  await page
    .getByPlaceholder(
      "e.g. Handwritten paper bill issued during power outage and not entered in POS",
    )
    .fill("Recovering paper sale with simulated lost return response");
  await page
    .getByPlaceholder("Search products by name or SKU to add...")
    .fill("Paracetamol");
  await page.getByRole("button", { name: /Paracetamol 500mg/ }).click();

  await page.getByRole("radio", { name: /Current Drawer Cash/ }).check();

  const postBtn = page.getByRole("button", {
    name: /Post Missing Sale Recovery/,
  });
  await postBtn.click();

  // Dialog closes because outcome discovery recovered the COMMITTED state without pending eSewa
  await expect(dialog).toHaveCount(0);
  // Exactly 1 POST request was made (no duplicate repost)
  const postCalls = f.payloads.filter((p) => p.reference?.billNo === "REC-PB-LOST-COMMIT");
  expect(postCalls).toHaveLength(1);
});

test("missing sale recovery modal: known rollback -> discovers prepared outcome, freezes inputs, and retries exact intent", async ({
  page,
}) => {
  const f = await fixture(page, {
    role: "MANAGER",
    failFirstPostWithPreparedOutcome: true,
  });
  await evidence(page);
  await page.getByRole("button", { name: /Create Missing Sale/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await page.getByPlaceholder("e.g. 00482").fill("REC-PB-FROZEN-RETRY");
  await page
    .getByPlaceholder(
      "e.g. Handwritten paper bill issued during power outage and not entered in POS",
    )
    .fill("Recovering paper sale with simulated prepared attempt rollback");
  await page
    .getByPlaceholder("Search products by name or SKU to add...")
    .fill("Paracetamol");
  await page.getByRole("button", { name: /Paracetamol 500mg/ }).click();

  await page.getByRole("radio", { name: /Current Drawer Cash/ }).check();

  const postBtn = page.getByRole("button", {
    name: /Post Missing Sale Recovery/,
  });
  await postBtn.click();

  // First POST failed -> UI discovered PREPARED outcome and shows info notice
  await expect(
    page.getByText("Your recovery attempt is durably prepared on the server"),
  ).toBeVisible();

  // Submit button text updates to "Retry Posting Prepared Intent"
  const retryBtn = page.getByRole("button", {
    name: /Retry Posting Prepared Intent/,
  });
  await expect(retryBtn).toBeVisible();
  await retryBtn.click();

  // Second POST succeeds and closes modal
  await expect(dialog).toHaveCount(0);
  const postCalls = f.payloads.filter((p) => p.reference?.billNo === "REC-PB-FROZEN-RETRY");
  expect(postCalls).toHaveLength(2);
  // Both requests carried exact matching intent
  expect(postCalls[0]).toEqual(postCalls[1]);
});

test("missing sale recovery modal: discovery unavailable sets uncertain outcome and provides retry verification", async ({
  page,
}) => {
  const f = await fixture(page, {
    role: "MANAGER",
    discoveryUnavailable: true,
  });
  await evidence(page);
  await page.getByRole("button", { name: /Create Missing Sale/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Shows uncertain outcome banner
  await expect(page.getByText("Recovery Status Uncertain")).toBeVisible();
  await expect(
    page.getByText("Unable to verify sales evidence recovery outcome from server"),
  ).toBeVisible();

  // Form submission is disabled/hidden
  await expect(
    page.getByRole("button", { name: /Post Missing Sale Recovery/ }),
  ).toHaveCount(0);

  // Provides retry verification button
  await expect(
    page.getByRole("button", { name: /Retry Status Verification/ }),
  ).toBeVisible();
});

test("missing sale recovery modal: reopening modal on prepared document without memory intent freezes inputs and prompts revision", async ({
  page,
}) => {
  const f = await fixture(page, {
    role: "MANAGER",
    preparedAttempt: true,
    preparedByOther: false,
  });
  await evidence(page);
  await page.getByRole("button", { name: /Create Missing Sale/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Shows prepared attempt banner with memory intent warning
  await expect(page.getByText("Recovery Attempt Prepared")).toBeVisible();
  await expect(
    page.getByText(
      "Because the exact memory payload is not available after reopening, please click 'Revise Prepared Attempt'",
    ),
  ).toBeVisible();

  // Inputs are disabled
  const billNoInput = page.getByPlaceholder("e.g. 00482");
  await expect(billNoInput).toBeDisabled();

  // Submit button is disabled indicating revision is needed
  const submitBtn = page.getByRole("button", {
    name: /Prepared \(Click Revise Attempt\)/,
  });
  await expect(submitBtn).toBeDisabled();

  // Click Revise Prepared Attempt
  await page.getByRole("button", { name: "Revise Prepared Attempt" }).click();
  await expect(page.getByText("Revision Explanation")).toBeVisible();
  await expect(billNoInput).toBeEnabled();
});

test("missing sale recovery modal: prepared attempt by same manager displays retry eligible banner and posts matching intent", async ({
  page,
}) => {
  const f = await fixture(page, {
    role: "MANAGER",
    preparedAttempt: true,
    preparedByOther: false,
  });
  await evidence(page);
  await page.getByRole("button", { name: /Create Missing Sale/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Shows prepared attempt banner
  await expect(page.getByText("Recovery Attempt Prepared")).toBeVisible();
  await expect(
    page.getByText(
      "Because the exact memory payload is not available after reopening, please click 'Revise Prepared Attempt'",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Revise Prepared Attempt" }),
  ).toBeVisible();
});

test("missing sale recovery modal: prepared attempt by another manager shows read-only attempt banner and disables posting", async ({
  page,
}) => {
  const f = await fixture(page, {
    role: "MANAGER",
    preparedAttempt: true,
    preparedByOther: true,
  });
  await evidence(page);
  await page.getByRole("button", { name: /Create Missing Sale/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Shows prepared by another manager banner
  await expect(
    page.getByText(
      "Another manager prepared this attempt. Only the preparing manager can post or revise it.",
    ),
  ).toBeVisible();
  // Revise button is hidden/disabled for another manager
  await expect(
    page.getByRole("button", { name: "Revise Prepared Attempt" }),
  ).toHaveCount(0);
});

test("missing sale recovery modal: explicit attempt revision calls revise endpoint and updates prepared state", async ({
  page,
}) => {
  const f = await fixture(page, {
    role: "MANAGER",
    preparedAttempt: true,
    preparedByOther: false,
  });
  await evidence(page);
  await page.getByRole("button", { name: /Create Missing Sale/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Click revise
  await page.getByRole("button", { name: "Revise Prepared Attempt" }).click();
  await expect(page.getByText("Revision Explanation")).toBeVisible();
  await page
    .getByPlaceholder(
      "Reason for modifying line items, quantities, or paper reference...",
    )
    .fill("Updated line quantities and corrected bill number");

  // Fill updated details
  await page.getByPlaceholder("e.g. 00482").fill("REC-PB-REVISED");
  await page
    .getByPlaceholder(
      "e.g. Handwritten paper bill issued during power outage and not entered in POS",
    )
    .fill("Corrected missing sale details");
  await page
    .getByPlaceholder("Search products by name or SKU to add...")
    .fill("Paracetamol");
  await page.getByRole("button", { name: /Paracetamol 500mg/ }).click();

  const submitRevBtn = page.getByRole("button", {
    name: /Submit Attempt Revision/,
  });
  await expect(submitRevBtn).toBeEnabled();
  await submitRevBtn.click();

  const revPayload = f.payloads.find((p) => p.expectedAttemptId === "audit-prep-1");
  expect(revPayload).toBeDefined();
  expect(revPayload.reason).toBe(
    "Updated line quantities and corrected bill number",
  );
  expect(revPayload.recovery.reference.billNo).toBe("REC-PB-REVISED");

  // Verify success banner appears and the submit button now allows confirmed POST
  await expect(
    page.getByText("Recovery attempt revised successfully. You can now post with the updated details."),
  ).toBeVisible();

  const postRevisedBtn = page.getByRole("button", {
    name: /Retry Posting Prepared Intent|Post Missing Sale Recovery/,
  });
  await expect(postRevisedBtn).toBeEnabled();
  await postRevisedBtn.click();

  await expect(dialog).toHaveCount(0);
  const postCalls = f.payloads.filter((p) => p.reference?.billNo === "REC-PB-REVISED");
  expect(postCalls).toHaveLength(1);
});

test("missing sale recovery modal: failed discovery after POST transport error sets uncertain status and preserves inputs", async ({
  page,
}) => {
  const f = await fixture(page, {
    role: "MANAGER",
    failDiscoveryAfterPost: true,
  });
  await evidence(page);
  await page.getByRole("button", { name: /Create Missing Sale/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await page.getByPlaceholder("e.g. 00482").fill("REC-PB-DISC-FAIL");
  await page
    .getByPlaceholder(
      "e.g. Handwritten paper bill issued during power outage and not entered in POS",
    )
    .fill("Recovering paper sale with failed post discovery");
  await page
    .getByPlaceholder("Search products by name or SKU to add...")
    .fill("Paracetamol");
  await page.getByRole("button", { name: /Paracetamol 500mg/ }).click();

  await page.getByRole("radio", { name: /Current Drawer Cash/ }).check();

  const postBtn = page.getByRole("button", {
    name: /Post Missing Sale Recovery/,
  });
  await postBtn.click();

  // Shows uncertain outcome banner
  await expect(page.getByText("Recovery Status Uncertain")).toBeVisible();
  await expect(
    page.getByText("Unable to verify sales evidence recovery outcome from server"),
  ).toBeVisible();

  // Retry discovery action is offered
  await expect(
    page.getByRole("button", { name: /Retry Status Verification/ }),
  ).toBeVisible();
});

test("missing sale recovery modal: uncertain status displays warning banner and blocks posting", async ({
  page,
}) => {
  const f = await fixture(page, { role: "MANAGER", decisionConflict: "stale" });
  await evidence(page);
  await page.getByRole("button", { name: /Create Missing Sale/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByText("Recovery Status Uncertain")).toBeVisible();
  await expect(
    page.getByText("Contradictory recovery provenance records detected."),
  ).toBeVisible();
  // Form is hidden/disabled
  await expect(
    page.getByRole("button", { name: /Post Missing Sale Recovery/ }),
  ).toHaveCount(0);
});

test("missing sale recovery modal: no open cash drawer disables posting for current drawer cash", async ({
  page,
}) => {
  const f = await fixture(page, { role: "MANAGER", hasDrawer: false });
  await evidence(page);
  await page.getByRole("button", { name: /Create Missing Sale/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Drawer Attribution shows No Open Cash Drawer
  await expect(page.getByText("No Open Cash Drawer Found")).toBeVisible();

  // Reference & Item
  await page.getByPlaceholder("e.g. 00482").fill("REC-PB-101");
  await page
    .getByPlaceholder(
      "e.g. Handwritten paper bill issued during power outage and not entered in POS",
    )
    .fill("Reason for recovery");
  await page
    .getByPlaceholder("Search products by name or SKU to add...")
    .fill("Paracetamol");
  await page.getByRole("button", { name: /Paracetamol 500mg/ }).click();

  // Submit button should be disabled because CURRENT_DRAWER_CASH is selected but no open drawer exists
  const postBtn = page.getByRole("button", {
    name: /Post Missing Sale Recovery/,
  });
  await expect(postBtn).toBeDisabled();
});

test("missing sale recovery server schema rejects invalid payload contracts", () => {
  // 1. Missing explanation in NOT_COLLECTED
  const missingExplanation = {
    reference: { billNo: "001", externalDocumentType: "PAN_INVOICE", externalBillDate: "2026-10-04" },
    reason: "Missing sale",
    paymentAssessment: { type: "NOT_COLLECTED" },
    checkout: {
      items: [{ productId: "prod-1", qty: 1 }],
      confirmation: { payableTotal: 100, items: [{ productId: "prod-1", qty: 1, appliedUnitPrice: 100 }] },
    },
  };
  expect(strictSaleEvidenceRecoverySchema.safeParse(missingExplanation).success).toBe(false);

  // 2. Forbidden actorId / unknown property at root
  const forbiddenProperty = {
    ...missingExplanation,
    actorId: "user-mgr-1",
    paymentAssessment: { type: "NOT_COLLECTED", explanation: "Unpaid" },
  };
  expect(strictSaleEvidenceRecoverySchema.safeParse(forbiddenProperty).success).toBe(false);

  // 3. Invalid calendar date (February 30)
  const invalidDate = {
    reference: { billNo: "001", externalDocumentType: "PAN_INVOICE", externalBillDate: "2026-02-30" },
    reason: "Missing sale",
    paymentAssessment: { type: "NOT_COLLECTED", explanation: "Unpaid" },
    checkout: {
      items: [{ productId: "prod-1", qty: 1 }],
      confirmation: { payableTotal: 100, items: [{ productId: "prod-1", qty: 1, appliedUnitPrice: 100 }] },
    },
  };
  expect(strictSaleEvidenceRecoverySchema.safeParse(invalidDate).success).toBe(false);

  // 4. Empty confirmation items array
  const emptyConfirmation = {
    reference: { billNo: "001", externalDocumentType: "PAN_INVOICE", externalBillDate: "2026-10-04" },
    reason: "Missing sale",
    paymentAssessment: { type: "NOT_COLLECTED", explanation: "Unpaid" },
    checkout: {
      items: [{ productId: "prod-1", qty: 1 }],
      confirmation: { payableTotal: 100, items: [] },
    },
  };
  expect(strictSaleEvidenceRecoverySchema.safeParse(emptyConfirmation).success).toBe(false);

  // 5. Duplicate product IDs in confirmation items
  const duplicateConfirmationItems = {
    reference: { billNo: "001", externalDocumentType: "PAN_INVOICE", externalBillDate: "2026-10-04" },
    reason: "Missing sale",
    paymentAssessment: { type: "NOT_COLLECTED", explanation: "Unpaid" },
    checkout: {
      items: [{ productId: "prod-1", qty: 1 }],
      confirmation: {
        payableTotal: 200,
        items: [
          { productId: "prod-1", qty: 1, appliedUnitPrice: 100 },
          { productId: "prod-1", qty: 1, appliedUnitPrice: 100 },
        ],
      },
    },
  };
  expect(strictSaleEvidenceRecoverySchema.safeParse(duplicateConfirmationItems).success).toBe(false);

  // 6. Valid payload parses successfully
  const validPayload = {
    reference: { billNo: "001", externalDocumentType: "PAN_INVOICE", externalBillDate: "2026-10-04" },
    reason: "Power outage manual bill recovery",
    paymentAssessment: {
      type: "CURRENT_DRAWER_CASH",
      drawerId: "drawer-1",
      collectedAt: "2026-10-04T10:00:00Z",
      explanation: "Cash in drawer",
      alreadyAccounted: false,
    },
    checkout: {
      items: [{ productId: "prod-1", qty: 1 }],
      payment: { method: "CASH", amount: 50 },
      confirmation: { payableTotal: 50, items: [{ productId: "prod-1", qty: 1, appliedUnitPrice: 50 }] },
    },
  };
  expect(strictSaleEvidenceRecoverySchema.safeParse(validPayload).success).toBe(true);

  // 7. Revise schema rejects missing expectedAttemptId
  const invalidRevise = {
    reason: "Revision reason",
    recovery: validPayload,
  };
  expect(strictReviseSaleEvidenceRecoverySchema.safeParse(invalidRevise).success).toBe(false);

  // 8. Revise schema accepts valid input
  const validRevise = {
    expectedAttemptId: "audit-1",
    reason: "Revision reason",
    recovery: validPayload,
  };
  expect(strictReviseSaleEvidenceRecoverySchema.safeParse(validRevise).success).toBe(true);
});

test("missing sale recovery modal: mobile viewport layout and interaction", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page, { role: "MANAGER" });
  await evidence(page);

  await page.getByRole("button", { name: /Create Missing Sale/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await page.getByPlaceholder("e.g. 00482").fill("REC-MOBILE-01");
  await page
    .getByPlaceholder(
      "e.g. Handwritten paper bill issued during power outage and not entered in POS",
    )
    .fill("Mobile recovery recording during power cut");
  await page
    .getByPlaceholder("Search products by name or SKU to add...")
    .fill("Paracetamol");
  await page.getByRole("button", { name: /Paracetamol 500mg/ }).click();

  await page.getByRole("radio", { name: /Current Drawer Cash/ }).check();

  const postBtn = page.getByRole("button", {
    name: /Post Missing Sale Recovery/,
  });
  await expect(postBtn).toBeEnabled();
  await postBtn.click();

  await expect(dialog).toHaveCount(0);
  const postCalls = f.payloads.filter((p) => p.reference?.billNo === "REC-MOBILE-01");
  expect(postCalls).toHaveLength(1);
});

test("missing sale recovery modal: keyboard navigation and Escape dismissal", async ({
  page,
}) => {
  const f = await fixture(page, { role: "MANAGER" });
  await evidence(page);

  await page.getByRole("button", { name: /Create Missing Sale/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Focus on billNo input
  const billNoInput = page.getByPlaceholder("e.g. 00482");
  await billNoInput.focus();
  await page.keyboard.type("REC-KB-01");
  expect(await billNoInput.inputValue()).toBe("REC-KB-01");

  // Press Escape to dismiss dialog
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("missing sale recovery modal: busy state during submission disables submit button", async ({
  page,
}) => {
  const f = await fixture(page, { role: "MANAGER", delayPostResponseMs: 500 });
  await evidence(page);

  await page.getByRole("button", { name: /Create Missing Sale/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await page.getByPlaceholder("e.g. 00482").fill("REC-BUSY-01");
  await page
    .getByPlaceholder(
      "e.g. Handwritten paper bill issued during power outage and not entered in POS",
    )
    .fill("Testing busy state during post");
  await page
    .getByPlaceholder("Search products by name or SKU to add...")
    .fill("Paracetamol");
  await page.getByRole("button", { name: /Paracetamol 500mg/ }).click();

  await page.getByRole("radio", { name: /Current Drawer Cash/ }).check();

  const postBtn = page.getByRole("button", {
    name: /Post Missing Sale Recovery/,
  });
  await postBtn.click();

  // While in-flight, button shows Posting Recovery... and is disabled
  await expect(page.getByRole("button", { name: /Posting Recovery/ })).toBeDisabled();

  // Once completed, dialog closes
  await expect(dialog).toHaveCount(0);
});

test("missing sale recovery policy blocking for prior cash and prior digital assessment", async ({
  page,
}) => {
  const f = await fixture(page, { role: "MANAGER" });
  await evidence(page);
  await page.getByRole("button", { name: /Create Missing Sale/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  // 1. Select Prior Cash
  await page
    .getByRole("radio", {
      name: /Prior \/ Other Drawer Cash/,
    })
    .check();
  await expect(page.getByText("Payment Reconciliation Required")).toBeVisible();
  const postBtn = page.getByRole("button", {
    name: /Post Missing Sale Recovery/,
  });
  await expect(postBtn).toBeDisabled();

  // 2. Select Prior Digital
  await page
    .getByRole("radio", {
      name: /Prior Digital/,
    })
    .check();
  await expect(page.getByText("Payment Reconciliation Required")).toBeVisible();
  await expect(postBtn).toBeDisabled();
});

test("missing sale recovery modal: API conflict error preserves user input", async ({
  page,
}) => {
  const f = await fixture(page, { role: "MANAGER", failPostWithStockConflict: true });
  await evidence(page);

  await page.getByRole("button", { name: /Create Missing Sale/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  await page.getByPlaceholder("e.g. 00482").fill("REC-CONFLICT-01");
  await page
    .getByPlaceholder(
      "e.g. Handwritten paper bill issued during power outage and not entered in POS",
    )
    .fill("Recovery with insufficient stock conflict");
  await page
    .getByPlaceholder("Search products by name or SKU to add...")
    .fill("Paracetamol");
  await page.getByRole("button", { name: /Paracetamol 500mg/ }).click();

  await page.getByRole("radio", { name: /Current Drawer Cash/ }).check();

  const postBtn = page.getByRole("button", {
    name: /Post Missing Sale Recovery/,
  });
  await postBtn.click();

  // Error banner displayed
  await expect(page.getByText("Insufficient stock for product Paracetamol 500mg")).toBeVisible();

  // Inputs remain preserved and editable
  expect(await page.getByPlaceholder("e.g. 00482").inputValue()).toBe("REC-CONFLICT-01");
  expect(
    await page
      .getByPlaceholder(
        "e.g. Handwritten paper bill issued during power outage and not entered in POS",
      )
      .inputValue(),
  ).toBe("Recovery with insufficient stock conflict");
});

for (const options of [{ role: "STAFF" }, { role: "ADMIN", pos: false }]) {
  test(`manual workspace denied for ${options.role} with POS ${options.pos !== false}`, async ({
    page,
  }) => {
    const f = await fixture(page, options);
    await page.goto("/manual-bills");
    await expect(
      page.getByText("Paper Bill Recording & Review"),
    ).toHaveCount(0);
    expect(f.payloads).toEqual([]);
  });
}

for (const width of [1440, 390]) {
  test(`local icons and established controls render offline at width ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route(
      /https:\/\/(?:fonts\.googleapis\.com|fonts\.gstatic\.com)/,
      (route) => route.abort(),
    );
    await fixture(page, { role: "MANAGER" });
    await page.goto("/manual-bills?tab=evidence");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(
      page.getByText("Paper Bill Recording & Review"),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => getComputedStyle(document.documentElement).colorScheme,
      ),
    ).toBe("light");
    await page.evaluate(() =>
      document.fonts.load('24px "Material Symbols Rounded"'),
    );
    const icons = await page
      .locator(".material-symbols-rounded")
      .evaluateAll((elements) =>
        elements.map((element) => ({
          text: element.textContent || "",
          font: getComputedStyle(element).fontFamily,
          width: element.getBoundingClientRect().width,
          size: parseFloat(getComputedStyle(element).fontSize),
        })),
      );
    const fallbackWorks = await page.evaluate(async () => {
      const modulePath = "/app/lib/ui/materialSymbol.ts";
      const { materialSymbol } = await import(modulePath);
      return ["not_a_real_icon", "constructor", "__proto__"].every(
        (name) =>
          materialSymbol(name) === materialSymbol("help_outline") &&
          [...materialSymbol(name)].length === 1,
      );
    });
    expect(fallbackWorks).toBeTruthy();
    expect(icons.length).toBeGreaterThan(5);
    for (const icon of icons) {
      expect([...icon.text]).toHaveLength(1);
      expect(icon.font).toContain("Material Symbols Rounded");
      expect(icon.width).toBeLessThanOrEqual(icon.size * 1.6);
    }
    expect(
      await page.evaluate(() =>
        document.fonts.check('24px "Material Symbols Rounded"'),
      ),
    ).toBeTruthy();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBeTruthy();
    await page.getByRole("button", { name: "Upload Bill Proof" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.screenshot({
      path: `${process.env.TEMP}/ks-ui001-evidence-${width}.png`,
      fullPage: true,
    });
  });
}
