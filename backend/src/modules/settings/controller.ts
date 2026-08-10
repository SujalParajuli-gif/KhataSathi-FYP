import { Request, Response } from "express";
import {
  getCashierPrivilege,
  getBusinessSettings,
  getOverridePolicy,
  listCashierPrivileges,
  updateCashierPrivilege,
  updateBusinessSettings,
  updateOverridePin,
  BusinessSettingsValidationError,
} from "./service";
import {
  getBusinessCapabilities,
  getBusinessModePreflight,
  isBusinessMode,
  updateBusinessMode,
} from "./capabilities";

export async function getCapabilities(_req: Request, res: Response) {
  try {
    res.json(await getBusinessCapabilities());
  } catch (err) {
    console.error("Get business capabilities error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function getModePreflight(req: Request, res: Response) {
  const targetMode = req.query.targetMode;
  if (!isBusinessMode(targetMode)) {
    res.status(400).json({ error: "A valid targetMode is required" });
    return;
  }

  try {
    res.json(
      await getBusinessModePreflight(targetMode, {
        staffDraftRequestsEnabled:
          req.query.staffDraftRequestsEnabled === "false"
            ? false
            : req.query.staffDraftRequestsEnabled === "true"
              ? true
              : undefined,
      }),
    );
  } catch (err) {
    console.error("Business mode preflight error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function changeBusinessMode(req: Request, res: Response) {
  const targetMode = req.body?.businessMode;
  if (!isBusinessMode(targetMode)) {
    res.status(400).json({ error: "A valid businessMode is required" });
    return;
  }

  try {
    res.json(
      await updateBusinessMode({
        targetMode,
        reason: req.body?.reason,
        actorId: req.user!.id,
        staffDraftRequestsEnabled: req.body?.staffDraftRequestsEnabled,
      }),
    );
  } catch (err: any) {
    const statusCode = Number(err?.statusCode);
    if (statusCode === 400 || statusCode === 409) {
      res.status(statusCode).json({
        error: err.message,
        ...(err.preflight ? { preflight: err.preflight } : {}),
      });
      return;
    }
    console.error("Change business mode error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// safely converting an input value to a number, returning undefined if not provided
// we use this so that empty or missing fields do not overwrite existing settings values
function parseOptionalNumber(value: unknown, _label: string) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  return Number(value);
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
      defaultInitialStock: parseOptionalNumber(
        req.body?.defaultInitialStock,
        "defaultInitialStock",
      ),
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
      returnWindowDays: parseOptionalNumber(
        req.body?.returnWindowDays,
        "returnWindowDays",
      ),
      parkedBillExpiryHours: parseOptionalNumber(
        req.body?.parkedBillExpiryHours,
        "parkedBillExpiryHours",
      ),
      draftRequestExpiryMinutes: parseOptionalNumber(
        req.body?.draftRequestExpiryMinutes,
        "draftRequestExpiryMinutes",
      ),
    }, req.user!.id);

    res.json(settings);
  } catch (err: any) {
    // checking if the error is a validation error from our parse function
    if (err instanceof BusinessSettingsValidationError) {
      res.status(400).json({ error: err.message, field: err.field });
      return;
    }

    console.error("Update business settings error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function getOverridePinPolicy(_req: Request, res: Response) {
  try {
    const policy = await getOverridePolicy();
    res.json(policy);
  } catch (err) {
    console.error("Get override PIN policy error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function updateOverridePinPolicy(req: Request, res: Response) {
  try {
    const policy = await updateOverridePin(req.body?.pin, req.user!.id);
    res.json(policy);
  } catch (err: any) {
    if (String(err?.message || "").includes("PIN")) {
      res.status(400).json({ error: err.message });
      return;
    }

    console.error("Update override PIN policy error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function getMyCashierPrivileges(req: Request, res: Response) {
  try {
    const privilege = await getCashierPrivilege(req.user!.id);
    res.json({ privilege });
  } catch (err) {
    console.error("Get cashier privilege error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function listCashierPrivilegeSettings(_req: Request, res: Response) {
  try {
    const cashiers = await listCashierPrivileges();
    res.json({ cashiers });
  } catch (err) {
    console.error("List cashier privileges error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function updateCashierPrivilegeSettings(req: Request, res: Response) {
  try {
    const result = await updateCashierPrivilege(
      String(req.params.userId),
      {
        canCreateDiscountedCustomer: req.body?.canCreateDiscountedCustomer,
        maxCustomerLoyaltyPercent: parseOptionalNumber(
          req.body?.maxCustomerLoyaltyPercent,
          "maxCustomerLoyaltyPercent",
        ),
        maxCustomerWholesalePercent: parseOptionalNumber(
          req.body?.maxCustomerWholesalePercent,
          "maxCustomerWholesalePercent",
        ),
        canRequestCustomerDiscount: req.body?.canRequestCustomerDiscount,
        canOverrideBillingPrice: req.body?.canOverrideBillingPrice,
        canApplyManualDiscount: req.body?.canApplyManualDiscount,
        canVoidPayment: req.body?.canVoidPayment,
        canViewWholesalePrice: req.body?.canViewWholesalePrice,
      },
      req.user!.id,
    );
    res.json(result);
  } catch (err: any) {
    if (String(err?.message || "").includes("must be")) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (String(err?.message || "").includes("not found")) {
      res.status(404).json({ error: err.message });
      return;
    }

    console.error("Update cashier privileges error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
