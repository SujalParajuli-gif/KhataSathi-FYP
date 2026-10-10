import { Router, type Request, type Response } from "express";
import { ZodError, z } from "zod/v4";
import { authGuard } from "../../middleware/auth";
import { requireRole } from "../../middleware/rbac";
import { createExpense, correctExpense, voidExpense, listExpenses, getExpense, ExpenseConflictError } from "./service";
import { expenseIdSchema } from "./validation";

const router: ReturnType<typeof Router> = Router();
router.use(authGuard, requireRole("ADMIN", "MANAGER"));
export function expenseError(error: unknown, res: Response) {
  if (error instanceof ZodError || /Expense amount/.test(String((error as Error)?.message))) {
    res.status(400).json({ error: "Enter a positive NPR amount, real date, category and description; corrections require a reason and current revision." });
  } else if (error instanceof ExpenseConflictError) {
    res.status(409).json({ code: "EXPENSE_CONFLICT", error: error.message });
  } else if ((error as Error)?.message === "Expense not found") {
    res.status(404).json({ error: "Expense not found" });
  } else if (["P2021", "P2022"].includes(String((error as any)?.code))) {
    res.status(503).json({ code: "EXPENSE_SCHEMA_UNAVAILABLE", error: "Expense records are unavailable until the feature migration is applied." });
  } else res.status(500).json({ error: "Unable to complete the expense request" });
}
function handler(work: (req: Request) => Promise<unknown>, status = 200) {
  return async (req: Request, res: Response) => {
    try { res.status(status).json(await work(req)); } catch (error) { expenseError(error, res); }
  };
}
const id = (req: Request) => expenseIdSchema.parse(req.params.id);
const noQuery = (req: Request) => z.object({}).strict().parse(req.query);
router.get("/", handler(req => listExpenses(req.query, req.user!.role)));
router.get("/:id", handler(async req => { noQuery(req); return { expense: await getExpense(id(req), req.user!.role) }; }));
router.post("/", handler(async req => { noQuery(req); return { result: await createExpense(req.body, req.user!.id, req.user!.role) }; }, 201));
router.post("/:id/corrections", handler(async req => { noQuery(req); return { result: await correctExpense(id(req), req.body, req.user!.id, req.user!.role) }; }));
router.post("/:id/void", handler(async req => { noQuery(req); return { result: await voidExpense(id(req), req.body, req.user!.id, req.user!.role) }; }));
export default router;
