import type { Request, Response } from "express";
import { ZodError, z } from "zod/v4";
import { getSalesReview, extractSalesReview, saveSalesReview, salesReviewMatches, SalesReviewError } from "./review";
import { SalesEvidenceAuthorizationError } from "./service";

const matchesQuery = z.object({ q: z.string().trim().max(160).optional() }).strict();
function handler(action: "get" | "extract" | "save" | "matches") {
  return async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id), actor = req.user!;
      if (action !== "matches") z.object({}).strict().parse(req.query);
      const result = action === "get" ? await getSalesReview(id, actor)
        : action === "extract" ? await extractSalesReview(id, actor, req.body)
        : action === "save" ? await saveSalesReview(id, actor, req.body)
        : await salesReviewMatches(id, actor, matchesQuery.parse(req.query).q);
      res.json(result);
    } catch (error) {
      if (error instanceof ZodError) { res.status(400).json({ error: "Review fields are invalid. Use explicit printed facts or leave unknown fields blank." }); return; }
      if (error instanceof SalesReviewError || error instanceof SalesEvidenceAuthorizationError) {
        res.status(error instanceof SalesReviewError ? error.status : error.statusCode).json({ error: error.message }); return;
      }
      res.status(503).json({ error: "Sales review is unavailable. Your source and entered corrections are retained; refresh its current outcome before retrying." });
    }
  };
}
export const getSalesReviewHandler = handler("get"), extractSalesReviewHandler = handler("extract"), saveSalesReviewHandler = handler("save"), salesReviewMatchesHandler = handler("matches");
