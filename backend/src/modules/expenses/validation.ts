import { z } from "zod/v4";
import { MAX_MONEY_DECIMAL, parseDecimalString, validateBillDate } from "../inventory/purchaseValidation";

export const expenseIdSchema = z.string().trim().min(1).max(120);
const amount = z.string().trim().max(30).regex(/^\d+(\.\d{1,2})?$/).transform(value =>
  parseDecimalString(value, "Expense amount", { maxDecimals: 2, max: MAX_MONEY_DECIMAL }).toFixed(2));
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  try { validateBillDate(value); return true; } catch { return false; }
}, "Enter a real date (YYYY-MM-DD).");
const fields = { amount, occurredOn: date, category: z.string().trim().min(1).max(80), description: z.string().trim().min(1).max(500) };
const reason = z.string().trim().min(3).max(500);
const expectedRevision = z.number().int().min(1).max(2147483646);
export const createExpenseSchema = z.object({ ...fields, operationKey: expenseIdSchema }).strict();
export const correctExpenseSchema = z.object({ ...fields, reason, expectedRevision, operationKey: expenseIdSchema }).strict();
export const voidExpenseSchema = z.object({ reason, expectedRevision, operationKey: expenseIdSchema }).strict();
export const expenseListSchema = z.object({
  q: z.string().trim().max(160).optional(),
  status: z.enum(["ALL", "RECORDED", "VOIDED"]).default("ALL"),
  page: z.string().regex(/^\d{1,6}$/).transform(Number).refine(n => n >= 1 && n <= 100000).default(1),
  pageSize: z.string().regex(/^\d{1,2}$/).transform(Number).refine(n => n >= 1 && n <= 50).default(20),
}).strict();
export type CreateExpense = z.input<typeof createExpenseSchema>;
export type CorrectExpense = z.input<typeof correctExpenseSchema>;
export type VoidExpense = z.input<typeof voidExpenseSchema>;
