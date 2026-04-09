import { Request, Response } from "express";
import {
  getBusinessSettings,
  updateBusinessSettings,
} from "./service";

function parseOptionalNumber(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    throw new Error(`${label} must be a valid number`);
  }

  return normalized;
}

export async function getBusinessDefaults(_req: Request, res: Response) {
  try {
    const settings = await getBusinessSettings();
    res.json(settings);
  } catch (err) {
    console.error("Get business settings error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function updateBusinessDefaults(req: Request, res: Response) {
  try {
    const settings = await updateBusinessSettings({
      defaultLowStockThreshold: parseOptionalNumber(
        req.body?.defaultLowStockThreshold,
        "defaultLowStockThreshold",
      ),
      defaultWholesaleQtyThreshold: parseOptionalNumber(
        req.body?.defaultWholesaleQtyThreshold,
        "defaultWholesaleQtyThreshold",
      ),
      loyaltyDiscountPercent: parseOptionalNumber(
        req.body?.loyaltyDiscountPercent,
        "loyaltyDiscountPercent",
      ),
    });

    res.json(settings);
  } catch (err: any) {
    if (String(err?.message || "").includes("must be")) {
      res.status(400).json({ error: err.message });
      return;
    }

    console.error("Update business settings error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
