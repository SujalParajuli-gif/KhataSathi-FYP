import { Request, Response } from "express";
import * as returnService from "./service";

function sendKnownError(res: Response, err: any) {
  if (!err?.message) return false;

  if (
    err.message.includes("Return") ||
    err.message.includes("return") ||
    err.message.includes("Invoice") ||
    err.message.includes("invoice") ||
    err.message.includes("item") ||
    err.message.includes("quantity") ||
    err.message.includes("stock") ||
    err.message.includes("unit") ||
    err.message.includes("refund") ||
    err.message.includes("finalized") ||
    err.message.includes("cancelled") ||
    err.message.includes("payment") ||
    err.message.includes("reviewed")
  ) {
    res.status(400).json({ error: err.message });
    return true;
  }

  return false;
}

export async function list(req: Request, res: Response) {
  try {
    const requests = await returnService.listReturnRequests({
      status: typeof req.query.status === "string" ? req.query.status : undefined,
      userId: req.user!.id,
      role: req.user!.role,
    });
    res.json({ requests });
  } catch (err) {
    console.error("List return requests error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function create(req: Request, res: Response) {
  try {
    const request = await returnService.createReturnRequest(req.user!.id, {
      invoiceId: req.body?.invoiceId,
      reason: req.body?.reason,
      note: req.body?.note,
      refundMethod: req.body?.refundMethod,
      items: req.body?.items,
    });
    res.status(201).json(request);
  } catch (err: any) {
    if (sendKnownError(res, err)) return;
    console.error("Create return request error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function approve(req: Request, res: Response) {
  try {
    const request = await returnService.approveReturnRequest(
      String(req.params.id),
      req.user!.id,
    );
    res.json(request);
  } catch (err: any) {
    if (sendKnownError(res, err)) return;
    console.error("Approve return request error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function reject(req: Request, res: Response) {
  try {
    const request = await returnService.rejectReturnRequest(
      String(req.params.id),
      req.user!.id,
      req.body?.note,
    );
    res.json(request);
  } catch (err: any) {
    if (sendKnownError(res, err)) return;
    console.error("Reject return request error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function reverse(req: Request, res: Response) {
  try {
    const request = await returnService.reverseApprovedReturnRequest(
      String(req.params.id),
      req.user!.id,
      req.body?.note,
    );
    res.json(request);
  } catch (err: any) {
    if (sendKnownError(res, err)) return;
    console.error("Reverse return request error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
