import { Request, Response } from "express";
import { markAsRead, markAllAsRead, getReadAlerts, markAsUnread } from "./service";

export async function getRead(req: Request, res: Response) {
  try {
    const keys = await getReadAlerts(req.user!.id);
    res.json({ readKeys: keys });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function markRead(req: Request, res: Response) {
  try {
    const { alertKey } = req.body;
    if (!alertKey) return res.status(400).json({ error: "alertKey is required" });
    await markAsRead(req.user!.id, alertKey);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function markAllRead(req: Request, res: Response) {
  try {
    const { alertKeys } = req.body;
    if (!Array.isArray(alertKeys)) return res.status(400).json({ error: "alertKeys array required" });
    await markAllAsRead(req.user!.id, alertKeys);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function markUnread(req: Request, res: Response) {
  try {
    const { alertKey } = req.body;
    if (!alertKey) return res.status(400).json({ error: "alertKey is required" });
    await markAsUnread(req.user!.id, alertKey);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
