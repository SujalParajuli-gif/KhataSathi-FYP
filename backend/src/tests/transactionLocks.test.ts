import test from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import {
  FinancialTransactionConflictError,
  isRecognizedTransactionConflict,
  lockProductsForUpdate,
  runFinancialTransaction,
} from "../lib/transactionLocks";

test("product locks use stable unique product ID order", async () => {
  const locked: string[] = [];
  const tx = {
    $queryRaw: async (_query: TemplateStringsArray, productId: unknown) => {
      locked.push(String(productId));
      return [];
    },
  };

  await lockProductsForUpdate(
    tx as unknown as Parameters<typeof lockProductsForUpdate>[0],
    ["product-z", "product-a", "product-z"],
  );

  assert.deepEqual(locked, ["product-a", "product-z"]);
});

test("financial transaction retries only a recognized rolled-back conflict", async () => {
  let attempts = 0;
  const client = {
    $transaction: async (work: (tx: never) => Promise<string>) => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("write conflict"), { code: "P2034" });
      return work({} as never);
    },
  } as unknown as Pick<PrismaClient, "$transaction">;

  const result = await runFinancialTransaction(client, async () => "saved");

  assert.equal(result, "saved");
  assert.equal(attempts, 2);
});

test("financial transaction does not retry arbitrary failures", async () => {
  let attempts = 0;
  const failure = new Error("validation failed");
  const client = {
    $transaction: async () => {
      attempts += 1;
      throw failure;
    },
  } as unknown as Pick<PrismaClient, "$transaction">;

  await assert.rejects(runFinancialTransaction(client, async () => "unused"), failure);
  assert.equal(attempts, 1);
  assert.equal(isRecognizedTransactionConflict(failure), false);
});

test("repeated transaction conflicts become a stable retryable error", async () => {
  const client = {
    $transaction: async () => {
      throw Object.assign(new Error("Deadlock found"), { code: "1213" });
    },
  } as unknown as Pick<PrismaClient, "$transaction">;

  await assert.rejects(
    runFinancialTransaction(client, async () => "unused"),
    (error: unknown) =>
      error instanceof FinancialTransactionConflictError &&
      error.code === "FINANCIAL_TRANSACTION_CONFLICT",
  );
});
