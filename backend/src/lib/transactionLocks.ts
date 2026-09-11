import type { Prisma, PrismaClient } from "@prisma/client";

type LockingTransaction = {
  $queryRaw<T = unknown>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
};

export class FinancialTransactionConflictError extends Error {
  readonly code = "FINANCIAL_TRANSACTION_CONFLICT";

  constructor() {
    super("The record changed during this operation. Please retry.");
    this.name = "FinancialTransactionConflictError";
  }
}

export function isRecognizedTransactionConflict(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    meta?: { code?: unknown };
    message?: unknown;
  };
  const code = String(candidate.code || candidate.meta?.code || "").toUpperCase();
  if (["P2034", "1213", "1205", "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"].includes(code)) {
    return true;
  }
  const message = String(candidate.message || "");
  return /deadlock found|lock wait timeout|transaction conflict/i.test(message);
}

export async function runFinancialTransaction<T>(
  client: Pick<PrismaClient, "$transaction">,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  maxAttempts = 2,
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await client.$transaction(work);
    } catch (error) {
      if (!isRecognizedTransactionConflict(error)) throw error;
      if (attempt === maxAttempts) throw new FinancialTransactionConflictError();
    }
  }
  throw new FinancialTransactionConflictError();
}

export async function lockInvoiceForUpdate(
  tx: LockingTransaction,
  invoiceId: string,
) {
  await tx.$queryRaw`SELECT id FROM Invoice WHERE id = ${invoiceId} FOR UPDATE`;
}

export async function lockProductsForUpdate(
  tx: LockingTransaction,
  productIds: Iterable<string>,
) {
  const orderedIds = [...new Set(productIds)].sort((left, right) =>
    left.localeCompare(right),
  );
  for (const productId of orderedIds) {
    await tx.$queryRaw`SELECT id FROM Product WHERE id = ${productId} FOR UPDATE`;
  }
}

export async function lockInvoiceItemsForUpdate(
  tx: LockingTransaction,
  invoiceId: string,
) {
  const rows = await tx.$queryRaw<Array<{ productId: string }>>`
    SELECT productId
    FROM InvoiceItem
    WHERE invoiceId = ${invoiceId}
    ORDER BY productId
    FOR UPDATE
  `;
  return rows.map((row) => row.productId);
}

export async function lockInvoiceItemForUpdate(
  tx: LockingTransaction,
  invoiceId: string,
  itemId: string,
) {
  const rows = await tx.$queryRaw<Array<{ productId: string }>>`
    SELECT productId
    FROM InvoiceItem
    WHERE id = ${itemId} AND invoiceId = ${invoiceId}
    FOR UPDATE
  `;
  return rows[0]?.productId || null;
}

export async function lockCashierForUpdate(
  tx: LockingTransaction,
  cashierId: string,
) {
  await tx.$queryRaw`SELECT id FROM User WHERE id = ${cashierId} FOR UPDATE`;
}

export async function lockCashDrawerForUpdate(
  tx: LockingTransaction,
  drawerId: string,
) {
  await tx.$queryRaw`SELECT id FROM CashDrawer WHERE id = ${drawerId} FOR UPDATE`;
}

export async function lockReturnRequestForUpdate(
  tx: LockingTransaction,
  requestId: string,
) {
  await tx.$queryRaw`SELECT id FROM ReturnRequest WHERE id = ${requestId} FOR UPDATE`;
}


export async function lockReturnItemsForUpdate(
  tx: LockingTransaction,
  requestId: string,
) {
  const rows = await tx.$queryRaw<Array<{ productId: string }>>`
    SELECT productId
    FROM ReturnItem
    WHERE returnRequestId = ${requestId}
    ORDER BY productId
    FOR UPDATE
  `;
  return rows.map((row) => row.productId);
}
