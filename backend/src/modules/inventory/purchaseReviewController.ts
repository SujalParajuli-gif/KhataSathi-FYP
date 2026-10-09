import { confirmationRequest, PurchaseConfirmationError } from "./purchaseReviewClaim";
import { FinancialPurchaseConflictError } from "./purchases";
import { Request, Response } from "express";
import { z } from "zod/v4";
import { extractionRequest, saveRequest, confirmPurchaseReview, getPurchaseReview, extractPurchaseReview, savePurchaseReview, purchaseReviewCandidates, purchaseReviewDuplicates, PurchaseReviewError } from "./purchaseReview";
const idSchema = z.string().trim().min(1).max(120);
const querySchema = z.object({ q: z.string().trim().max(160).default(""), kind: z.enum(["supplier", "product"]) }).strict();
export function purchaseReviewHandler(action: "get" | "extract" | "save" | "candidates" | "duplicates" | "confirm") {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      if (!req.user || !["ADMIN", "MANAGER"].includes(req.user.role)) { res.status(403).json({ error: "Purchase review requires administrator or manager access." }); return; }
      const id = idSchema.parse(req.params.id);
      const result = action === "get" ? await getPurchaseReview(id, req.user.role)
        : action === "extract" ? await extractPurchaseReview(id, req.user.role, req.user.id, extractionRequest.parse(req.body))
        : action === "save" ? await savePurchaseReview(id, req.user.role, req.user.id, saveRequest.parse(req.body))
        : action === "confirm" ? await confirmPurchaseReview(id, req.user.role, req.user.id, confirmationRequest.parse(req.body))
        : action === "duplicates" ? await purchaseReviewDuplicates(id, req.user.role)
        : await (() => { const q = querySchema.parse(req.query); return purchaseReviewCandidates(id, req.user!.role, q.q, q.kind); })();
      res.json(result);
    } catch (e) {
      if (e instanceof z.ZodError) { res.status(400).json({ error: "Invalid purchase review fields." }); return; }
      if (e instanceof PurchaseConfirmationError) { res.status(e.status).json({ error: e.message }); return; }
      if (e instanceof FinancialPurchaseConflictError) { res.status(409).json({ error: "Purchase confirmation conflicts with a previous operation. Reload the source outcome." }); return; }
      if (e instanceof PurchaseReviewError) { res.status(e.status).json({ error: e.message }); return; }
      if (action === "confirm" && e instanceof Error && /^(Resolve |Supplier not found|Cannot |Product not found|Unit conversion|Unsupported input unit|Input unit|Line |Reconciliation error|Reviewed payable|Stock |Resulting stock|Purchase receipt not found|Document .*already linked|Document .*deleted)/.test(e.message)) { res.status(400).json({ error: e.message }); return; }
      res.status(503).json({ error: "Purchase review is unavailable. Your source and saved review are retained." });
    }
  };
}
