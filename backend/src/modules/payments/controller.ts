import { Request, Response } from "express";
import { buildEsewaResultUrl, getEsewaConfig } from "./esewa";
import * as paymentService from "./service";

function buildGenericEsewaFailureRedirect(message: string) {
  const config = getEsewaConfig();
  return buildEsewaResultUrl(config.frontendBaseUrl, {
    status: "failed",
    message,
  });
}

export async function addPayment(req: Request, res: Response) {
  try {
    const invoiceId = String(req.params.id);
    const { method, amount, status, reference } = req.body;

    if (!method || !amount || amount <= 0) {
      res.status(400).json({ error: "method and amount (> 0) are required" });
      return;
    }

    const validMethods = ["CASH", "ESEWA", "KHALTI"];
    if (!validMethods.includes(method)) {
      res.status(400).json({ error: `method must be one of: ${validMethods.join(", ")}` });
      return;
    }

    const validStatuses = ["PENDING", "SUCCESS", "FAILED"];
    const paymentStatus = status || "SUCCESS";
    if (!validStatuses.includes(paymentStatus)) {
      res.status(400).json({ error: `status must be one of: ${validStatuses.join(", ")}` });
      return;
    }

    const payment = await paymentService.addPayment(
      invoiceId,
      method,
      Number(amount),
      paymentStatus,
      req.user!.id,
      reference,
    );

    res.status(201).json(payment);
  } catch (err: any) {
    if (
      err.message.includes("Overpayment") ||
      err.message.includes("not found") ||
      err.message.includes("fully paid") ||
      err.message.includes("cancelled") ||
      err.message.includes("draft") ||
      err.message.includes("greater than zero")
    ) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Add payment error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function initiateEsewaPayment(req: Request, res: Response) {
  try {
    const { invoiceId, amount } = req.body;
    if (!invoiceId || !amount || Number(amount) <= 0) {
      res.status(400).json({ error: "invoiceId and amount (> 0) are required" });
      return;
    }

    const result = await paymentService.initiateEsewaPayment(
      String(invoiceId),
      Number(amount),
      req.user!.id,
    );
    res.status(201).json(result);
  } catch (err: any) {
    if (
      err.message.includes("not found") ||
      err.message.includes("draft") ||
      err.message.includes("cancelled") ||
      err.message.includes("fully paid") ||
      err.message.includes("greater than zero") ||
      err.message.includes("remaining due")
    ) {
      res.status(400).json({ error: err.message });
      return;
    }

    console.error("Initiate eSewa payment error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function verifyEsewaPayment(req: Request, res: Response) {
  try {
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
    res.redirect(result.redirectUrl);
  } catch (err: any) {
    console.error("Verify eSewa payment error:", err);
    res.redirect(
      buildGenericEsewaFailureRedirect(
        err?.message || "Failed to verify the eSewa payment.",
      ),
    );
  }
}

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

export async function listPayments(req: Request, res: Response) {
  try {
    const payments = await paymentService.listPayments(String(req.params.id));
    res.json(payments);
  } catch (err) {
    console.error("List payments error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
