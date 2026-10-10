import api from "./client";

export type Expense = { id: string; amount: string; occurredOn: string; category: string; description: string; status: "RECORDED" | "VOIDED"; revision: number; createdAt: string };
export type ExpenseRevision = Expense & { action: "CREATE" | "CORRECT" | "VOID"; reason: string | null; actor: { id: string; name: string } };
export type ExpenseDetail = Expense & { revisions: ExpenseRevision[] };
export type ExpenseFields = Pick<Expense, "amount" | "occurredOn" | "category" | "description">;
export type ExpenseOperation = { operationKey: string; expectedRevision?: number; reason?: string } & Partial<ExpenseFields>;
export async function expenses(params: { q: string; status: string; page: number }, signal?: AbortSignal) {
  return (await api.get<{ items: Expense[]; total: number; totalPages: number }>("/api/expenses", { params: { ...params, pageSize: 20 }, signal })).data;
}
export async function expense(id: string, signal?: AbortSignal) {
  return (await api.get<{ expense: ExpenseDetail }>(`/api/expenses/${encodeURIComponent(id)}`, { signal })).data.expense;
}
export async function recordExpense(action: "CREATE" | "CORRECT" | "VOID", id: string | null, input: ExpenseOperation) {
  const path = action === "CREATE" ? "/api/expenses" : `/api/expenses/${encodeURIComponent(id!)}/${action === "CORRECT" ? "corrections" : "void"}`;
  return (await api.post<{ result: { expenseId: string; revision: number; action: string } }>(path, input)).data.result;
}
export function expenseError(error: unknown) {
  const e = error as { response?: { data?: { error?: string; code?: string } }; message?: string };
  return e.response?.data?.error || e.message || "Unable to complete this expense request. Your input is preserved.";
}
