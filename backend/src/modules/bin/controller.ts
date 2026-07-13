import { Request, Response } from "express";
import * as binService from "./service";

export async function list(req: Request, res: Response) {
  try {
    const result = await binService.listBin({
      entityType: req.query.entityType as string | undefined,
      page: req.query.page ? Number(req.query.page) : 1,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : 30,
    });
    res.json(result);
  } catch (err) {
    console.error("Bin list error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function restore(req: Request, res: Response) {
  try {
    const result = await binService.restoreBinRecord(String(req.params.id), req.user!.id);
    res.json(result);
  } catch (err: any) {
    if (err.message?.includes("not found") || err.message?.includes("not supported")) {
      res.status(404).json({ error: err.message });
      return;
    }
    console.error("Bin restore error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function purge(req: Request, res: Response) {
  try {
    const result = await binService.permanentlyDeleteBinRecord(String(req.params.id), req.user!.id);
    res.json(result);
  } catch (err: any) {
    if (err.message?.includes("not found") || err.message?.includes("not supported")) {
      res.status(404).json({ error: err.message });
      return;
    }
    console.error("Bin purge error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
