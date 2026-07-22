import { Request, Response } from "express";
import { getPaymentGateway } from "./gateways";
import {
  SUPPORTED_PAYMENT_METHODS,
  type SupportedPaymentMethod,
} from "./service";
import * as paymentService from "./service";
import { formatZodIssues } from "../../lib/requestValidation";
import { voidPaymentBodySchema } from "./validation";

// building a redirect URL for eSewa failures — this sends the user to the frontend result page with an error message
function buildGenericEsewaFailureRedirect(message: string) {
  return getPaymentGateway("ESEWA").buildResultRedirect({
    status: "failed",
    message,
  });
}

// validating that a payment amount is a positive finite number
function parsePositiveAmount(value: unknown) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error("amount must be greater than 0");
  }
  return normalized;
}

// recording a manual payment against an invoice (cash, card, etc.)
// the payment amount is added to the invoice's paidTotal and the paymentStatus is updated accordingly
export async function addPayment(req: Request, res: Response) {
  try {
    const invoiceId = String(req.params.id);
    const { method, amount, status, reference } = req.body;

    // validating that the payment method is provided
    if (!method) {
      res.status(400).json({ error: "method is required" });
      return;
    }

    // checking that the method is one of the supported types (CASH, CARD, ESEWA, BANK_TRANSFER)
    if (!SUPPORTED_PAYMENT_METHODS.includes(method as SupportedPaymentMethod)) {
      res.status(400).json({
        error: `method must be one of: ${SUPPORTED_PAYMENT_METHODS.join(", ")}`,
      });
      return;
    }

    // validating the payment status — defaults to SUCCESS for manual entries
    const validStatuses = ["PENDING", "SUCCESS", "FAILED"];
    const paymentStatus = status || "SUCCESS";
    if (!validStatuses.includes(paymentStatus)) {
      res.status(400).json({
        error: `status must be one of: ${validStatuses.join(", ")}`,
      });
      return;
    }

    const payment = await paymentService.addPayment(
      invoiceId,
      method as SupportedPaymentMethod,
      parsePositiveAmount(amount),
      paymentStatus,
      req.user!.id,
      reference,
    );

    res.status(201).json(payment);
  } catch (err: any) {
    // checking for various business rule violations
    if (
      err.message.includes("amount") ||
      err.message.includes("Overpayment") ||
      err.message.includes("not found") ||
      err.message.includes("fully paid") ||
      err.message.includes("cancelled") ||
      err.message.includes("draft") ||
      err.message.includes("greater than zero") ||
      err.message.includes("Zero-total")
    ) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Add payment error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// initiating an eSewa online payment — creates a pending payment record and returns form data for eSewa redirect
export async function initiateEsewaPayment(req: Request, res: Response) {
  try {
    const { invoiceId, amount } = req.body;
    if (!invoiceId) {
      res.status(400).json({ error: "invoiceId is required" });
      return;
    }

    const result = await paymentService.initiateEsewaPayment(
      String(invoiceId),
      parsePositiveAmount(amount),
      req.user!.id,
    );
    res.status(201).json(result); // returning the form fields the frontend needs to redirect to eSewa
  } catch (err: any) {
    if (
      err.message.includes("invoiceId") ||
      err.message.includes("amount") ||
      err.message.includes("not found") ||
      err.message.includes("draft") ||
      err.message.includes("cancelled") ||
      err.message.includes("fully paid") ||
      err.message.includes("greater than zero") ||
      err.message.includes("remaining due") ||
      err.message.includes("Zero-total")
    ) {
      res.status(400).json({ error: err.message });
      return;
    }

    console.error("Initiate eSewa payment error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// handling the eSewa success callback — eSewa redirects the user here after a successful payment
// we verify the payment signature, update the payment record, and redirect to the frontend result page
export async function verifyEsewaPayment(req: Request, res: Response) {
  try {
    // eSewa sends the encoded payload either as a query param or in the request body
    const encodedPayload =
      typeof req.query.data === "string"
        ? req.query.data
        : typeof req.body?.data === "string"
          ? req.body.data
          : undefined;

    const result = await paymentService.verifyEsewaPayment(
      String(req.params.paymentId),
      encodedPayload,
    );
    res.redirect(result.redirectUrl); // redirecting to the frontend result page
  } catch (err: any) {
    console.error("Verify eSewa payment error:", err);
    // if verification fails, we redirect to the frontend with an error message
    res.redirect(
      buildGenericEsewaFailureRedirect(
        err?.message || "Failed to verify the eSewa payment.",
      ),
    );
  }
}

// handling the eSewa failure callback — eSewa redirects here when the user cancels or the payment fails
export async function failEsewaPayment(req: Request, res: Response) {
  try {
    const result = await paymentService.failEsewaPayment(String(req.params.paymentId));
    res.redirect(result.redirectUrl);
  } catch (err: any) {
    console.error("eSewa failure callback error:", err);
    res.redirect(
      buildGenericEsewaFailureRedirect(
        err?.message || "eSewa payment was not completed.",
      ),
    );
  }
}

// listing all payments for a specific invoice — shows payment history with method, amount, status, and who recorded it
export async function listPayments(req: Request, res: Response) {
  try {
    const payments = await paymentService.listPayments(String(req.params.id));
    res.json(payments);
  } catch (err) {
    console.error("List payments error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// voiding a successful payment — marks it as failed with void metadata and recomputes the invoice payment status
// this is restricted to admin users only via the route middleware
export async function voidPayment(req: Request, res: Response) {
  try {
    const parsed = voidPaymentBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid payment void payload",
        details: formatZodIssues(parsed.error),
      });
      return;
    }

    const result = await paymentService.voidPayment(
      String(req.params.id),
      String(req.params.paymentId),
      req.user!.id,
      parsed.data.overridePin,
    );
    res.json(result);
  } catch (err: any) {
    if (
      err.message.includes("not found") ||
      err.message.includes("does not belong") ||
      err.message.includes("Only successful") ||
      err.message.includes("already been voided") ||
      err.message.includes("cancelled") ||
      err.message.includes("PIN") ||
      err.message.includes("authorized") ||
      err.message.includes("not active")
    ) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Void payment error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
