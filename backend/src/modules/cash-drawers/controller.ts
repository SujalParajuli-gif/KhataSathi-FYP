import { Request, Response } from "express";
import {
  addCashDrawerEvent,
  closeCashDrawer,
  getCurrentCashDrawer,
  listCashDrawers,
  openCashDrawer,
} from "./service";

function sendCashDrawerError(res: Response, err: any) {
  const message = String(err?.message || "Cash drawer operation failed");
  if (
    message.includes("must be") ||
    message.includes("not found") ||
    message.includes("already") ||
    message.includes("only")
  ) {
    res.status(400).json({ error: message });
    return;
  }
  console.error("Cash drawer error:", err);
  res.status(500).json({ error: "Internal server error" });
}

export async function getCurrent(req: Request, res: Response) {
  try {
    const drawer = await getCurrentCashDrawer(req.user!.id);
    res.json({ drawer });
  } catch (err) {
    sendCashDrawerError(res, err);
  }
}

export async function list(req: Request, res: Response) {
  try {
    const drawers = await listCashDrawers(req.user!.id, req.user!.role);
    res.json({ drawers });
  } catch (err) {
    sendCashDrawerError(res, err);
  }
}

export async function open(req: Request, res: Response) {
  try {
    const drawer = await openCashDrawer(
      req.user!.id,
      req.body?.openingFloat,
      req.body?.note,
    );
    res.status(201).json({ drawer });
  } catch (err) {
    sendCashDrawerError(res, err);
  }
}

export async function addEvent(req: Request, res: Response) {
  try {
    const type = req.body?.type === "CASH_OUT" ? "CASH_OUT" : "CASH_IN";
    const drawer = await addCashDrawerEvent(
      String(req.params.id),
      req.user!.id,
      req.user!.role,
      type,
      req.body?.amount,
      req.body?.note,
    );
    res.json({ drawer });
  } catch (err) {
    sendCashDrawerError(res, err);
  }
}

export async function close(req: Request, res: Response) {
  try {
    const drawer = await closeCashDrawer(
      String(req.params.id),
      req.user!.id,
      req.user!.role,
      req.body?.actualTotal,
      req.body?.note,
    );
    res.json({ drawer });
  } catch (err) {
    sendCashDrawerError(res, err);
  }
}
