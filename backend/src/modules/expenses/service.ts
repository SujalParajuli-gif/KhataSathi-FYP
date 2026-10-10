import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../../db/prisma";
import { validatePurchaseActorRole, validateScalarId } from "../inventory/purchaseValidation";
import { createExpenseSchema, correctExpenseSchema, voidExpenseSchema, expenseListSchema, type CreateExpense, type CorrectExpense, type VoidExpense } from "./validation";

export class ExpenseConflictError extends Error {
  readonly code = "EXPENSE_CONFLICT";
}

function replay(row: any, hash: string) {
  if (row.payloadHash !== hash) throw new ExpenseConflictError("Expense operation conflict");
  return { expenseId: row.expenseId, revision: row.revision, action: row.action };
}

async function mutate(action: "CREATE" | "CORRECT" | "VOID", targetId: string | null, input: any, actorId: string, role: string) {
  validatePurchaseActorRole(role);
  const actor = validateScalarId(actorId, "Actor ID");
  const id = targetId === null ? null : validateScalarId(targetId, "Expense ID");
  const normalized = (action === "CREATE" ? createExpenseSchema : action === "CORRECT" ? correctExpenseSchema : voidExpenseSchema).parse(input);
  const { operationKey, ...content } = normalized;
  const hash = createHash("sha256").update(JSON.stringify({ action, actorId: actor, expenseId: id, content })).digest("hex");
  const prior = await prisma.expenseRevision.findUnique({ where: { operationKey } });
  if (prior) return replay(prior, hash);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        if (id) await tx.$queryRaw`SELECT id FROM Expense WHERE id = ${id} FOR UPDATE`;
        const existing = await tx.expenseRevision.findUnique({ where: { operationKey } });
        if (existing) return replay(existing, hash);
        let expense;
        const data = normalized as any;
        if (action === "CREATE") {
          expense = await tx.expense.create({ data: {
            amount: data.amount, occurredOn: new Date(data.occurredOn + "T00:00:00Z"), category: data.category,
            description: data.description, createdById: actor,
          } });
        } else {
          const current = await tx.expense.findUnique({ where: { id: id! } });
          if (!current) throw new Error("Expense not found");
          if (current.status === "VOIDED" || current.revision !== data.expectedRevision) {
            throw new ExpenseConflictError("Expense changed; reload the current entry before correcting it");
          }
          expense = await tx.expense.update({ where: { id: id! }, data: {
            revision: current.revision + 1,
            ...(action === "VOID" ? { status: "VOIDED" as const } : {
              amount: data.amount, occurredOn: new Date(data.occurredOn + "T00:00:00Z"), category: data.category, description: data.description,
            }),
          } });
        }
        const revision = await tx.expenseRevision.create({ data: {
          expenseId: expense.id, revision: expense.revision, action, amount: expense.amount, occurredOn: expense.occurredOn,
          category: expense.category, description: expense.description, status: expense.status,
          reason: action === "CREATE" ? null : data.reason, actorId: actor, operationKey, payloadHash: hash,
        } });
        await tx.auditLog.create({ data: { actorId: actor, action: action === "CREATE" ? "EXPENSE_CREATED" : action === "CORRECT" ? "EXPENSE_CORRECTED" : "EXPENSE_VOIDED", entityType: "Expense", entityId: expense.id,
          meta: { revision: expense.revision, amount: expense.amount.toFixed(2), occurredOn: expense.occurredOn.toISOString().slice(0, 10), reason: revision.reason } } });
        return replay(revision, hash);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    } catch (error) {
      const code = String((error as { code?: unknown })?.code ?? "");
      if (code === "P2002") {
        const winner = await prisma.expenseRevision.findUnique({ where: { operationKey } });
        if (winner) return replay(winner, hash);
      }
      const databaseCode = String((error as { meta?: { code?: unknown } })?.meta?.code ?? "");
      if (attempt === 0 && (["P2034", "1213", "1205"].includes(code) || ["1213", "1205"].includes(databaseCode))) continue;
      throw error;
    }
  }
  throw new ExpenseConflictError("Expense transaction conflict");
}

export const createExpense = (input: CreateExpense, actorId: string, role: string) => mutate("CREATE", null, input, actorId, role);
export const correctExpense = (id: string, input: CorrectExpense, actorId: string, role: string) => mutate("CORRECT", id, input, actorId, role);
export const voidExpense = (id: string, input: VoidExpense, actorId: string, role: string) => mutate("VOID", id, input, actorId, role);

function view(row: any) {
  return { id: row.id, revision: row.revision, amount: row.amount.toFixed(2), occurredOn: row.occurredOn.toISOString().slice(0, 10),
    category: row.category, description: row.description, status: row.status, createdAt: row.createdAt.toISOString() };
}
export async function getExpense(id: string, role: string) {
  validatePurchaseActorRole(role); const expenseId = validateScalarId(id, "Expense ID");
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const row = await tx.expense.findUnique({ where: { id: expenseId }, include: { revisions: { orderBy: { revision: "asc" }, include: { actor: { select: { id: true, name: true } } } } } });
    if (!row) throw new Error("Expense not found");
    return { ...view(row), revisions: row.revisions.map(rev => ({ ...view(rev), action: rev.action, reason: rev.reason, actor: rev.actor })) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
export async function listExpenses(query: unknown, role: string) {
  validatePurchaseActorRole(role); const { q, status, page, pageSize } = expenseListSchema.parse(query);
  const where: Prisma.ExpenseWhereInput = {
    ...(status === "ALL" ? {} : { status }),
    ...(q ? { OR: [{ category: { contains: q } }, { description: { contains: q } }] } : {}),
  };
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const rows = await tx.expense.findMany({ where, orderBy: [{ occurredOn: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize });
    const total = await tx.expense.count({ where });
    return { items: rows.map(view), total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}
