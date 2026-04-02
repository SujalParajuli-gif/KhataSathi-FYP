import crypto from "crypto";
import prisma from "../../db/prisma";
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

export const SUPPORTED_PAYMENT_METHODS = ["CASH", "ESEWA"] as const;
export type SupportedPaymentMethod = (typeof SUPPORTED_PAYMENT_METHODS)[number];

function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}

function buildEsewaTransactionUuid() {
  return `esw-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

async function recomputePaymentStatusTx(tx: any, invoiceId: string) {
  const invoice = await tx.invoice.findUnique({
    where: { id: invoiceId },
    include: { payments: true },
  });
  if (!invoice) {
    throw new Error("Invoice not found");
  }

  const paidTotal = roundCurrency(
    invoice.payments
      .filter((payment: any) => payment.status === "SUCCESS")
      .reduce((sum: number, payment: any) => sum + payment.amount, 0),
  );

  let paymentStatus: "UNPAID" | "PARTIALLY_PAID" | "PAID" | "CANCELLED" =
    "UNPAID";
  if (invoice.paymentStatus === "CANCELLED") {
    paymentStatus = "CANCELLED";
  } else if (invoice.netTotal <= 0) {
    paymentStatus = "PAID";
  } else if (paidTotal >= invoice.netTotal) {
    paymentStatus = "PAID";
  } else if (paidTotal > 0) {
    paymentStatus = "PARTIALLY_PAID";
  }

  await tx.invoice.update({
    where: { id: invoiceId },
    data: { paidTotal, paymentStatus },
  });

  return { paidTotal, paymentStatus, netTotal: invoice.netTotal };
}

function getSuccessfulPaidTotal(payments: Array<{ id: string; amount: number; status: string }>, excludePaymentId?: string) {
  return roundCurrency(
    payments
      .filter(
        (payment) =>
          payment.status === "SUCCESS" &&
          (!excludePaymentId || payment.id !== excludePaymentId),
      )
      .reduce((sum, payment) => sum + payment.amount, 0),
  );
}

function ensureInvoiceCanAcceptPayment(invoice: {
  status: string;
  paymentStatus: string;
  payments: Array<{ id: string; amount: number; status: string }>;
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

async function getActorSummaryTx(tx: any, userId: string) {
  return tx.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, role: true },
  });
}

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

      return data;
    } catch (err) {
      lastError =
        err instanceof Error
          ? err
          : new Error("Could not verify transaction with eSewa.");
    }
  }

  throw lastError || new Error("Could not verify transaction with eSewa.");
}

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

  if (status === "SUCCESS") {
    const currentPaid = getSuccessfulPaidTotal(invoice.payments);

    if (currentPaid + normalizedAmount > invoice.netTotal) {
      throw new Error(
        `Overpayment! Current paid: Rs ${currentPaid}, new: Rs ${normalizedAmount}, net total: Rs ${invoice.netTotal}. Max allowed: Rs ${invoice.netTotal - currentPaid}`,
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    const actor = await getActorSummaryTx(tx, createdById);
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

    const next = await recomputePaymentStatusTx(tx, invoiceId);

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

export async function initiateEsewaPayment(
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

  const currentPaid = getSuccessfulPaidTotal(invoice.payments);
  const remainingDue = roundCurrency(Math.max(0, invoice.netTotal - currentPaid));
  if (normalizedAmount > remainingDue) {
    throw new Error("Payment amount cannot exceed the remaining due.");
  }

  const transactionUuid = buildEsewaTransactionUuid();
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

    if (payment.status === "SUCCESS") {
      return payment;
    }

    const actor = await getActorSummaryTx(tx, payment.createdById);

    const currentPaid = getSuccessfulPaidTotal(payment.invoice.payments, payment.id);
    if (currentPaid + payment.amount > payment.invoice.netTotal) {
      throw new Error("Verified eSewa payment would overpay the invoice.");
    }

    const updatedPayment = await tx.payment.update({
      where: { id: paymentId },
      data: {
        status: "SUCCESS",
        reference: reference || payment.reference || null,
      },
    });

    const next = await recomputePaymentStatusTx(tx, payment.invoiceId);

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

    if (payment.status !== "SUCCESS" && payment.status !== "FAILED") {
      await tx.payment.update({
        where: { id: paymentId },
        data: { status: "FAILED" },
      });
    }

    await recomputePaymentStatusTx(tx, payment.invoiceId);

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

  const payloadStatus = String(payload.status || "").toUpperCase();
  const payloadAmount = roundCurrency(Number(payload.total_amount || 0));
  if (
    !verifyEsewaSignature(payload, config.secretKey) ||
    payloadStatus !== "COMPLETE" ||
    payload.transaction_uuid !== payment.transactionUuid ||
    payload.product_code !== config.productCode ||
    Math.abs(payloadAmount - payment.amount) > 0.01
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

export async function listPayments(invoiceId: string) {
  return prisma.payment.findMany({
    where: { invoiceId },
    include: { createdBy: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });
}
