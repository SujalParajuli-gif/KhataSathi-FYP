import crypto from "crypto";
import prisma from "../../db/prisma";
import { assertCashierOverrideAllowed } from "../settings/service";
import {
  buildEsewaResultUrl,
  buildEsewaSignature,
  decodeEsewaPayload,
  ESEWA_SIGNED_FIELD_NAMES,
  formatEsewaAmount,
  getEsewaConfig,
  getEsewaStatusCheckUrlCandidates,
  verifyEsewaSignature,
  type EsewaFormFields,
  type EsewaStatusResponse,
} from "./esewa";

// the payment methods our system currently supports — CASH is manual, ESEWA is online
export const SUPPORTED_PAYMENT_METHODS = ["CASH", "ESEWA"] as const;
export type SupportedPaymentMethod = (typeof SUPPORTED_PAYMENT_METHODS)[number];

// rounding to 2 decimal places to avoid JavaScript floating point issues
function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}

// generating a unique transaction UUID for eSewa payments
// combining the current timestamp with random bytes to make sure each one is unique
function buildEsewaTransactionUuid() {
  return `esw-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

type PaymentLedgerEntry = {
  id: string;
  amount: number;
  status: string;
  kind?: string | null;
};

function isChargePayment(payment: { kind?: string | null }) {
  return String(payment.kind || "CHARGE").toUpperCase() !== "REFUND";
}

export function getSuccessfulChargePaidTotal(
  payments: PaymentLedgerEntry[],
  excludePaymentId?: string,
) {
  return roundCurrency(
    payments
      .filter(
        (payment) =>
          payment.status === "SUCCESS" &&
          isChargePayment(payment) &&
          (!excludePaymentId || payment.id !== excludePaymentId),
      )
      .reduce((sum, payment) => sum + payment.amount, 0),
  );
}

// recalculating the paidTotal and paymentStatus for an invoice based on its successful payments
// we call this inside a transaction after every payment add, success, or failure
// so the invoice record always reflects the actual payment state
async function recomputePaymentStatusTx(tx: any, invoiceId: string) {
  const invoice = await tx.invoice.findUnique({
    where: { id: invoiceId },
    include: { payments: true },
  });
  if (!invoice) {
    throw new Error("Invoice not found");
  }

  // summing only the successful payments — pending and failed ones do not count toward the total
  const paidTotal = getSuccessfulChargePaidTotal(invoice.payments);

  // determining the payment status based on how much has been paid vs the net total
  let paymentStatus: "UNPAID" | "PARTIALLY_PAID" | "PAID" | "CANCELLED" =
    "UNPAID";
  if (invoice.paymentStatus === "CANCELLED") {
    paymentStatus = "CANCELLED"; // a cancelled invoice stays cancelled regardless of payments
  } else if (invoice.netTotal <= 0) {
    paymentStatus = "PAID"; // if the net total is 0 or less (full discount), it is auto-paid
  } else if (paidTotal >= invoice.netTotal) {
    paymentStatus = "PAID";
  } else if (paidTotal > 0) {
    paymentStatus = "PARTIALLY_PAID"; // some money received but not the full amount yet
  }

  await tx.invoice.update({
    where: { id: invoiceId },
    data: { paidTotal, paymentStatus },
  });

  return { paidTotal, paymentStatus, netTotal: invoice.netTotal };
}

// calculating the total already paid by summing only successful payments
// optionally excluding a specific payment ID — we use this when checking if an eSewa payment
// would cause overpayment, because the payment itself is already in the database as PENDING
// validating that an invoice is in a valid state to accept a new payment
// we cannot add payments to drafts, cancelled invoices, fully paid invoices, or zero-total ones
function ensureInvoiceCanAcceptPayment(invoice: {
  status: string;
  paymentStatus: string;
  payments: PaymentLedgerEntry[];
  netTotal: number;
}) {
  if (invoice.status !== "FINALIZED") {
    throw new Error("Cannot add payment to a draft invoice");
  }
  if (invoice.paymentStatus === "CANCELLED") {
    throw new Error("Cannot add payment to a cancelled invoice");
  }
  if (invoice.paymentStatus === "PAID") {
    throw new Error("Invoice is already fully paid");
  }
  if (invoice.netTotal <= 0) {
    throw new Error("Zero-total invoice does not need a payment");
  }
}

// fetching the actor (user) info for audit log entries
async function getActorSummaryTx(tx: any, userId: string) {
  return tx.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, role: true },
  });
}

// building a redirect URL that sends the user to the frontend success page after eSewa completes
function buildEsewaSuccessRedirect(params: {
  invoiceId: string;
  invoiceNo: string;
  paymentId: string;
  amount: number;
  reference?: string | null;
  message?: string;
}) {
  const config = getEsewaConfig();
  return buildEsewaResultUrl(config.frontendBaseUrl, {
    status: "success",
    invoiceId: params.invoiceId,
    invoiceNo: params.invoiceNo,
    paymentId: params.paymentId,
    amount: formatEsewaAmount(params.amount),
    reference: params.reference || undefined,
    message: params.message || "eSewa payment verified successfully.",
  });
}

// building a redirect URL that sends the user to the frontend failure page after eSewa fails
function buildEsewaFailureRedirect(params: {
  invoiceId?: string;
  invoiceNo?: string;
  paymentId?: string;
  amount?: number;
  message: string;
}) {
  const config = getEsewaConfig();
  return buildEsewaResultUrl(config.frontendBaseUrl, {
    status: "failed",
    invoiceId: params.invoiceId,
    invoiceNo: params.invoiceNo,
    paymentId: params.paymentId,
    amount:
      typeof params.amount === "number"
        ? formatEsewaAmount(params.amount)
        : undefined,
    message: params.message,
  });
}

// calling eSewa's status check API to verify whether a transaction actually completed on their side
// we try multiple URL candidates because eSewa has different endpoints for test and sandbox
async function fetchEsewaStatus(
  transactionUuid: string,
  totalAmount: string,
) {
  const config = getEsewaConfig();
  const statusCheckUrls = getEsewaStatusCheckUrlCandidates(config.statusCheckUrl);
  let lastError: Error | null = null;

  for (const statusCheckUrl of statusCheckUrls) {
    try {
      const url = new URL(statusCheckUrl);
      url.searchParams.set("product_code", config.productCode);
      url.searchParams.set("total_amount", totalAmount);
      url.searchParams.set("transaction_uuid", transactionUuid);

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
      });

      const rawText = await response.text();
      const data = rawText
        ? (JSON.parse(rawText) as EsewaStatusResponse)
        : null;

      if (!response.ok || !data) {
        throw new Error(
          `Status API returned ${response.status || 0} from ${url.origin}.`,
        );
      }

      return data; // if we got a valid response, return it immediately
    } catch (err) {
      lastError =
        err instanceof Error
          ? err
          : new Error("Could not verify transaction with eSewa.");
    }
  }

  throw lastError || new Error("Could not verify transaction with eSewa.");
}

// --

// recording a manual payment (cash, card, etc.) against a finalized invoice
// we validate overpayment only for successful payments — pending/failed payments do not affect the balance
export async function addPayment(
  invoiceId: string,
  method: SupportedPaymentMethod,
  amount: number,
  status: "PENDING" | "SUCCESS" | "FAILED",
  createdById: string,
  reference?: string,
) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { payments: true },
  });

  if (!invoice) throw new Error("Invoice not found");
  ensureInvoiceCanAcceptPayment(invoice);

  const normalizedAmount = roundCurrency(amount);
  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
    throw new Error("Payment amount must be greater than zero");
  }

  // checking for overpayment — the new payment plus what is already paid cannot exceed the net total
  if (status === "SUCCESS") {
    const currentPaid = getSuccessfulChargePaidTotal(invoice.payments);

    if (currentPaid + normalizedAmount > invoice.netTotal) {
      throw new Error(
        `Overpayment! Current paid: Rs ${currentPaid}, new: Rs ${normalizedAmount}, net total: Rs ${invoice.netTotal}. Max allowed: Rs ${invoice.netTotal - currentPaid}`,
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    const actor = await getActorSummaryTx(tx, createdById);
    // creating the payment record in the database
    const payment = await tx.payment.create({
      data: {
        invoiceId,
        method,
        amount: normalizedAmount,
        status,
        reference: reference || null,
        createdById,
      },
    });

    // recalculating the invoice payment status after adding this payment
    const next = await recomputePaymentStatusTx(tx, invoiceId);

    // only logging successful payments in the audit — pending and failed ones are just records
    if (status === "SUCCESS") {
      await tx.auditLog.create({
        data: {
          actorId: createdById,
          action: "INVOICE_PAYMENT_UPDATED",
          entityType: "Invoice",
          entityId: invoiceId,
        meta: {
          invoiceNo: invoice.invoiceNo,
          actorName: actor?.name || null,
          actorRole: actor?.role || null,
          method,
          reference: reference || null,
          amountAdded: normalizedAmount,
            previousStatus: invoice.paymentStatus,
            nextStatus: next.paymentStatus,
            paidTotal: next.paidTotal,
            netTotal: next.netTotal,
            remainingDue: roundCurrency(Math.max(0, next.netTotal - next.paidTotal)),
          },
        },
      });
    }

    return payment;
  });
}

// --

// initiating an eSewa online payment — creates a PENDING payment record and returns the
// form fields the frontend needs to redirect the user to eSewa's payment page
type InvoiceForPayment = {
  id: string;
  invoiceNo: string;
  status: string;
  paymentStatus: string;
  netTotal: number;
  payments: PaymentLedgerEntry[];
};

// creates a pending eSewa payment and returns the signed gateway form payload
// using the caller's transaction client lets checkout commit the invoice and payment intent together
export async function createEsewaPaymentIntentTx(
  tx: any,
  invoice: InvoiceForPayment,
  amount: number,
  createdById: string,
) {
  const config = getEsewaConfig();
  ensureInvoiceCanAcceptPayment(invoice);

  const normalizedAmount = roundCurrency(amount);
  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
    throw new Error("Payment amount must be greater than zero");
  }

  const currentPaid = getSuccessfulChargePaidTotal(invoice.payments);
  const remainingDue = roundCurrency(Math.max(0, invoice.netTotal - currentPaid));
  if (normalizedAmount > remainingDue) {
    throw new Error("Payment amount cannot exceed the remaining due.");
  }

  const transactionUuid = buildEsewaTransactionUuid();
  const payment = await tx.payment.create({
    data: {
      invoiceId: invoice.id,
      method: "ESEWA",
      amount: normalizedAmount,
      status: "PENDING",
      transactionUuid,
      createdById,
    },
  });

  const amountText = formatEsewaAmount(normalizedAmount);
  const signedFieldNames = ESEWA_SIGNED_FIELD_NAMES.join(",");
  const fields: EsewaFormFields = {
    amount: amountText,
    tax_amount: "0",
    total_amount: amountText,
    transaction_uuid: transactionUuid,
    product_code: config.productCode,
    product_service_charge: "0",
    product_delivery_charge: "0",
    success_url: `${config.backendBaseUrl}/api/payments/esewa/verify/${payment.id}`,
    failure_url: `${config.backendBaseUrl}/api/payments/esewa/failure/${payment.id}`,
    signed_field_names: signedFieldNames,
    signature: "",
  };

  fields.signature = buildEsewaSignature(
    fields,
    ESEWA_SIGNED_FIELD_NAMES,
    config.secretKey,
  );

  return {
    paymentId: payment.id,
    invoiceId: invoice.id,
    invoiceNo: invoice.invoiceNo,
    amount: normalizedAmount,
    formAction: config.formUrl,
    fields,
  };
}

export async function initiateEsewaPayment(
  invoiceId: string,
  amount: number,
  createdById: string,
) {
  return prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: { payments: true },
    });

    if (!invoice) throw new Error("Invoice not found");

    return createEsewaPaymentIntentTx(tx, invoice, amount, createdById);
  });
}

async function legacyInitiateEsewaPayment(
  invoiceId: string,
  amount: number,
  createdById: string,
) {
  const config = getEsewaConfig();
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { payments: true },
  });

  if (!invoice) throw new Error("Invoice not found");
  ensureInvoiceCanAcceptPayment(invoice);

  const normalizedAmount = roundCurrency(amount);
  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
    throw new Error("Payment amount must be greater than zero");
  }

  // making sure the payment amount does not exceed the remaining balance
  const currentPaid = getSuccessfulChargePaidTotal(invoice.payments);
  const remainingDue = roundCurrency(Math.max(0, invoice.netTotal - currentPaid));
  if (normalizedAmount > remainingDue) {
    throw new Error("Payment amount cannot exceed the remaining due.");
  }

  const transactionUuid = buildEsewaTransactionUuid(); // generating a unique ID for this transaction
  // creating a PENDING payment record — it will be marked as SUCCESS or FAILED after eSewa responds
  const payment = await prisma.payment.create({
    data: {
      invoiceId,
      method: "ESEWA",
      amount: normalizedAmount,
      status: "PENDING",
      transactionUuid,
      createdById,
    },
  });

  // building all the form fields that eSewa requires for payment initiation
  const amountText = formatEsewaAmount(normalizedAmount);
  const signedFieldNames = ESEWA_SIGNED_FIELD_NAMES.join(",");
  const fields: EsewaFormFields = {
    amount: amountText,
    tax_amount: "0",
    total_amount: amountText,
    transaction_uuid: transactionUuid,
    product_code: config.productCode,
    product_service_charge: "0",
    product_delivery_charge: "0",
    success_url: `${config.backendBaseUrl}/api/payments/esewa/verify/${payment.id}`, // eSewa redirects here after success
    failure_url: `${config.backendBaseUrl}/api/payments/esewa/failure/${payment.id}`, // eSewa redirects here after failure
    signed_field_names: signedFieldNames,
    signature: "", // will be filled below
  };

  // signing the fields with our secret key so eSewa can verify the request is from us
  fields.signature = buildEsewaSignature(
    fields,
    ESEWA_SIGNED_FIELD_NAMES,
    config.secretKey,
  );

  return {
    paymentId: payment.id,
    invoiceId: invoice.id,
    invoiceNo: invoice.invoiceNo,
    amount: normalizedAmount,
    formAction: config.formUrl, // the URL the frontend form should POST to
    fields, // the form fields to include in the POST
  };
}

// --

// marking an eSewa payment as successful — updates the payment record and the invoice's payment status
// we also create an audit log entry to track who and when
async function markEsewaPaymentSuccess(paymentId: string, reference?: string | null) {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { id: paymentId },
      include: {
        invoice: {
          include: { payments: true },
        },
      },
    });

    if (!payment) {
      throw new Error("Payment attempt not found");
    }

    if (payment.method !== "ESEWA") {
      throw new Error("Payment is not an eSewa payment");
    }
    if (payment.invoice.paymentStatus === "CANCELLED") {
      throw new Error("Cannot verify payment for a cancelled invoice");
    }

    // if this payment is already marked as success, we just return it without doing anything
    if (payment.status === "SUCCESS") {
      return payment;
    }

    const actor = await getActorSummaryTx(tx, payment.createdById);

    // checking that marking this payment as successful would not cause overpayment
    const currentPaid = getSuccessfulChargePaidTotal(payment.invoice.payments, payment.id);
    if (currentPaid + payment.amount > payment.invoice.netTotal) {
      throw new Error("Verified eSewa payment would overpay the invoice.");
    }

    // updating the payment status to SUCCESS and storing the eSewa reference code
    const updatedPayment = await tx.payment.update({
      where: { id: paymentId },
      data: {
        status: "SUCCESS",
        reference: reference || payment.reference || null,
      },
    });

    // recalculating the invoice payment status after this payment was confirmed
    const next = await recomputePaymentStatusTx(tx, payment.invoiceId);

    // creating an audit log entry for the successful eSewa payment
    await tx.auditLog.create({
      data: {
        actorId: payment.createdById,
        action: "INVOICE_PAYMENT_UPDATED",
        entityType: "Invoice",
        entityId: payment.invoiceId,
        meta: {
          invoiceNo: payment.invoice.invoiceNo,
          actorName: actor?.name || null,
          actorRole: actor?.role || null,
          method: "ESEWA",
          reference: updatedPayment.reference || null,
          amountAdded: payment.amount,
          previousStatus: payment.invoice.paymentStatus,
          nextStatus: next.paymentStatus,
          paidTotal: next.paidTotal,
          netTotal: next.netTotal,
          remainingDue: roundCurrency(Math.max(0, next.netTotal - next.paidTotal)),
        },
      },
    });

    return updatedPayment;
  });
}

// marking an eSewa payment as failed — updates the payment record and logs the failure reason
async function markEsewaPaymentFailed(paymentId: string, reason: string) {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { id: paymentId },
      include: {
        invoice: {
          include: { payments: true },
        },
      },
    });

    if (!payment) {
      throw new Error("Payment attempt not found");
    }

    if (payment.method !== "ESEWA") {
      throw new Error("Payment is not an eSewa payment");
    }

    const actor = await getActorSummaryTx(tx, payment.createdById);

    // only update the status if it is not already SUCCESS or FAILED (i.e., it is still PENDING)
    if (payment.status !== "SUCCESS" && payment.status !== "FAILED") {
      await tx.payment.update({
        where: { id: paymentId },
        data: { status: "FAILED" },
      });
    }

    await recomputePaymentStatusTx(tx, payment.invoiceId);

    // logging the failure in the audit so the admin can see what happened
    await tx.auditLog.create({
      data: {
        actorId: payment.createdById,
        action: "INVOICE_PAYMENT_FAILED",
        entityType: "Invoice",
        entityId: payment.invoiceId,
        meta: {
          invoiceNo: payment.invoice.invoiceNo,
          actorName: actor?.name || null,
          actorRole: actor?.role || null,
          method: "ESEWA",
          amountAttempted: payment.amount,
          transactionUuid: payment.transactionUuid,
          reason,
        },
      },
    });

    return payment;
  });
}

// --

// verifying an eSewa payment after eSewa redirects the user back to our success callback URL
// this is a multi-step process:
// 1. decode the base64 payload that eSewa sent
// 2. verify the HMAC signature to make sure it was not tampered with
// 3. call eSewa's status check API to confirm the transaction is actually COMPLETE
// 4. if everything checks out, mark the payment as SUCCESS and update the invoice
export async function verifyEsewaPayment(paymentId: string, encodedPayload?: string) {
  const config = getEsewaConfig();
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      invoice: {
        include: { payments: true },
      },
    },
  });

  // if the payment record does not exist, redirect with a failure message
  if (!payment) {
    return {
      redirectUrl: buildEsewaFailureRedirect({
        paymentId,
        message: "Payment attempt not found.",
      }),
    };
  }

  if (payment.method !== "ESEWA") {
    return {
      redirectUrl: buildEsewaFailureRedirect({
        paymentId,
        invoiceId: payment.invoiceId,
        invoiceNo: payment.invoice.invoiceNo,
        amount: payment.amount,
        message: "This payment is not an eSewa transaction.",
      }),
    };
  }

  // if the invoice was cancelled while the user was paying on eSewa, we fail the payment
  if (payment.invoice.paymentStatus === "CANCELLED") {
    await markEsewaPaymentFailed(
      paymentId,
      "Cannot verify payment for a cancelled invoice.",
    );
    return {
      redirectUrl: buildEsewaFailureRedirect({
        paymentId: payment.id,
        invoiceId: payment.invoiceId,
        invoiceNo: payment.invoice.invoiceNo,
        amount: payment.amount,
        message: "Cannot verify payment for a cancelled invoice.",
      }),
    };
  }

  // if the payment is already verified, redirect to success
  if (payment.status === "SUCCESS") {
    return {
      redirectUrl: buildEsewaSuccessRedirect({
        invoiceId: payment.invoiceId,
        invoiceNo: payment.invoice.invoiceNo,
        paymentId: payment.id,
        amount: payment.amount,
        reference: payment.reference,
        message: "This eSewa payment was already verified.",
      }),
    };
  }

  // step 1: decoding the base64-encoded payload from eSewa
  let payload;
  try {
    payload = decodeEsewaPayload(String(encodedPayload || ""));
  } catch {
    await markEsewaPaymentFailed(paymentId, "Missing or invalid eSewa callback payload.");
    return {
      redirectUrl: buildEsewaFailureRedirect({
        paymentId: payment.id,
        invoiceId: payment.invoiceId,
        invoiceNo: payment.invoice.invoiceNo,
        amount: payment.amount,
        message: "Missing or invalid eSewa callback payload.",
      }),
    };
  }

  // step 2: verifying the HMAC signature plus checking that the amount, product code,
  // and transaction UUID all match what we originally sent to eSewa
  const payloadStatus = String(payload.status || "").toUpperCase();
  const payloadAmount = roundCurrency(Number(payload.total_amount || 0));
  if (
    !verifyEsewaSignature(payload, config.secretKey) ||
    payloadStatus !== "COMPLETE" ||
    payload.transaction_uuid !== payment.transactionUuid ||
    payload.product_code !== config.productCode ||
    Math.abs(payloadAmount - payment.amount) > 0.01 // allowing a tiny tolerance for floating point
  ) {
    await markEsewaPaymentFailed(paymentId, "eSewa callback validation failed.");
    return {
      redirectUrl: buildEsewaFailureRedirect({
        paymentId: payment.id,
        invoiceId: payment.invoiceId,
        invoiceNo: payment.invoice.invoiceNo,
        amount: payment.amount,
        message: "eSewa callback validation failed.",
      }),
    };
  }

  // step 3: calling eSewa's status check API for server-to-server confirmation
  // this is an extra security step on top of the payload verification
  try {
    const statusResponse = await fetchEsewaStatus(
      String(payment.transactionUuid || ""),
      formatEsewaAmount(payment.amount),
    );

    const statusText = String(statusResponse.status || "").toUpperCase();
    if (statusText !== "COMPLETE") {
      await markEsewaPaymentFailed(
        paymentId,
        `eSewa status check returned ${statusText || "UNKNOWN"}.`,
      );
      return {
        redirectUrl: buildEsewaFailureRedirect({
          paymentId: payment.id,
          invoiceId: payment.invoiceId,
          invoiceNo: payment.invoice.invoiceNo,
          amount: payment.amount,
          message: `eSewa status check returned ${statusText || "UNKNOWN"}.`,
        }),
      };
    }

    // step 4: everything verified — extracting the reference code and marking as successful
    const reference =
      payload.transaction_code ||
      statusResponse.refId ||
      statusResponse.ref_id ||
      payment.reference;

    const updatedPayment = await markEsewaPaymentSuccess(paymentId, reference);
    return {
      redirectUrl: buildEsewaSuccessRedirect({
        invoiceId: updatedPayment.invoiceId,
        invoiceNo: payment.invoice.invoiceNo,
        paymentId: updatedPayment.id,
        amount: updatedPayment.amount,
        reference: updatedPayment.reference,
      }),
    };
  } catch {
    // if the status check fails (network error, timeout, etc.), we mark the payment as failed
    await markEsewaPaymentFailed(paymentId, "Could not verify transaction with eSewa.");
    return {
      redirectUrl: buildEsewaFailureRedirect({
        paymentId: payment.id,
        invoiceId: payment.invoiceId,
        invoiceNo: payment.invoice.invoiceNo,
        amount: payment.amount,
        message: "Could not verify transaction with eSewa.",
      }),
    };
  }
}

// handling eSewa's failure callback — the user either cancelled the payment or eSewa returned an error
export async function failEsewaPayment(paymentId: string) {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { invoice: true },
  });

  if (!payment) {
    return {
      redirectUrl: buildEsewaFailureRedirect({
        paymentId,
        message: "Payment attempt not found.",
      }),
    };
  }

  // if the payment was already verified as successful before this callback, redirect to success
  if (payment.status === "SUCCESS") {
    return {
      redirectUrl: buildEsewaSuccessRedirect({
        invoiceId: payment.invoiceId,
        invoiceNo: payment.invoice.invoiceNo,
        paymentId: payment.id,
        amount: payment.amount,
        reference: payment.reference,
        message: "This eSewa payment was already verified.",
      }),
    };
  }

  await markEsewaPaymentFailed(paymentId, "User cancelled or eSewa returned failure.");

  return {
    redirectUrl: buildEsewaFailureRedirect({
      paymentId: payment.id,
      invoiceId: payment.invoiceId,
      invoiceNo: payment.invoice.invoiceNo,
      amount: payment.amount,
      message: "eSewa payment was not completed.",
    }),
  };
}

// listing all payments for a specific invoice — includes who recorded each payment
export async function listPayments(invoiceId: string) {
  return prisma.payment.findMany({
    where: { invoiceId },
    include: { createdBy: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" }, // newest payments first
  });
}

// voiding a payment — marks a successful payment as failed with void metadata,
// recomputes the invoice payment status, and creates an audit log entry.
// this is the safe alternative to cancelling an entire invoice when a single payment was recorded incorrectly.
export async function cleanupStaleEsewaPayments(maxAgeMinutes = 30) {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
  const stalePayments = await prisma.payment.findMany({
    where: {
      method: "ESEWA",
      status: "PENDING",
      createdAt: { lt: cutoff },
    },
    include: {
      invoice: {
        select: {
          id: true,
          invoiceNo: true,
          paymentStatus: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  if (stalePayments.length === 0) {
    return { expired: 0 };
  }

  return prisma.$transaction(async (tx) => {
    let expired = 0;

    for (const payment of stalePayments) {
      const updated = await tx.payment.updateMany({
        where: {
          id: payment.id,
          status: "PENDING",
          method: "ESEWA",
        },
        data: {
          status: "FAILED",
          reference: payment.reference || "Expired pending eSewa payment",
        },
      });

      if (updated.count === 0) continue;
      expired += 1;

      const next = await recomputePaymentStatusTx(tx, payment.invoiceId);
      await tx.auditLog.create({
        data: {
          actorId: payment.createdById,
          action: "ESEWA_PAYMENT_EXPIRED",
          entityType: "Payment",
          entityId: payment.id,
          meta: {
            invoiceId: payment.invoiceId,
            invoiceNo: payment.invoice.invoiceNo,
            amount: payment.amount,
            previousInvoiceStatus: payment.invoice.paymentStatus,
            nextInvoiceStatus: next.paymentStatus,
            maxAgeMinutes,
          },
        },
      });
    }

    return { expired };
  });
}

export async function voidPayment(
  invoiceId: string,
  paymentId: string,
  voidedById: string,
  overridePin?: string | null,
) {
  return prisma.$transaction(async (tx) => {
    await assertCashierOverrideAllowed(
      voidedById,
      "PAYMENT_VOID",
      overridePin,
      tx,
    );

    const payment = await tx.payment.findUnique({
      where: { id: paymentId },
      include: {
        invoice: { select: { id: true, invoiceNo: true, paymentStatus: true, netTotal: true } },
      },
    });

    if (!payment) throw new Error("Payment not found");
    if (payment.invoiceId !== invoiceId) {
      throw new Error("Payment does not belong to this invoice");
    }
    if (payment.status !== "SUCCESS") {
      throw new Error("Only successful payments can be voided");
    }
    if (payment.voidedAt) {
      throw new Error("Payment has already been voided");
    }
    if (payment.invoice.paymentStatus === "CANCELLED") {
      throw new Error("Cannot void a payment on a cancelled invoice");
    }
    if (!isChargePayment(payment)) {
      throw new Error("Refund ledger entries cannot be voided from the payment correction flow");
    }

    const actor = await getActorSummaryTx(tx, voidedById);

    // marking the payment as voided — we change the status to FAILED and record who voided it and when
    await tx.payment.update({
      where: { id: paymentId },
      data: {
        status: "FAILED",
        voidedAt: new Date(),
        voidedById,
      },
    });

    // recomputing the invoice payment totals now that this payment is no longer counted
    const next = await recomputePaymentStatusTx(tx, invoiceId);

    await tx.auditLog.create({
      data: {
        actorId: voidedById,
        action: "PAYMENT_VOIDED",
        entityType: "Payment",
        entityId: paymentId,
        meta: {
          invoiceId,
          invoiceNo: payment.invoice.invoiceNo,
          actorName: actor?.name || null,
          actorRole: actor?.role || null,
          method: payment.method,
          voidedAmount: payment.amount,
          reference: payment.reference || null,
          previousInvoiceStatus: payment.invoice.paymentStatus,
          nextInvoiceStatus: next.paymentStatus,
          paidTotal: next.paidTotal,
          netTotal: next.netTotal,
          remainingDue: roundCurrency(Math.max(0, next.netTotal - next.paidTotal)),
        },
      },
    });

    return {
      paymentId,
      invoiceId,
      voidedAmount: payment.amount,
      newPaidTotal: next.paidTotal,
      newPaymentStatus: next.paymentStatus,
    };
  });
}
