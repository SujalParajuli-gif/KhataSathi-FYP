import { Request, Response } from "express";
import {
  getBusinessSettings,
  updateBusinessSettings,
} from "./service";

// safely converting an input value to a number, returning undefined if not provided
// we use this so that empty or missing fields do not overwrite existing settings values
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

// returning the current business settings (thresholds and discount defaults)
export async function getBusinessDefaults(_req: Request, res: Response) {
  try {
    const settings = await getBusinessSettings();
    res.json(settings);
  } catch (err) {
    console.error("Get business settings error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// updating the business-wide default settings
// each field is parsed through parseOptionalNumber so invalid input is caught early
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
    // checking if the error is a validation error from our parse function
    if (String(err?.message || "").includes("must be")) {
      res.status(400).json({ error: err.message });
      return;
    }

    console.error("Update business settings error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
