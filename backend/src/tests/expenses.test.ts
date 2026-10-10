import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Prisma } from "@prisma/client";
import prisma from "../db/prisma";
import { createExpense, correctExpense, voidExpense, getExpense, listExpenses } from "../modules/expenses/service";
import { createExpenseSchema, correctExpenseSchema, voidExpenseSchema, expenseListSchema } from "../modules/expenses/validation";
import routes from "../modules/expenses/routes";
import { signSessionToken, hashSessionSecret, SESSION_COOKIE_NAME, CSRF_HEADER_NAME } from "../modules/auth/session";

const input = { amount: "10.20", occurredOn: "2026-10-10", category: "Utilities", description: "Electricity", operationKey: "create-one" };
test("expense strict input preserves exact money and rejects unsafe dates, coercion and invented authority", () => {
  assert.equal(createExpenseSchema.parse({ ...input, amount: "999999999999999999.99" }).amount, "999999999999999999.99");
  assert.equal(createExpenseSchema.parse({ ...input, amount: "000.1" }).amount, "0.10");
  for (const amount of [0, "0", "-1", "1.001", "1e3", "1000000000000000000", "NaN"]) assert.throws(() => createExpenseSchema.parse({ ...input, amount }));
  for (const occurredOn of ["2026-02-30", "2025-02-29", "2026-1-1", "2026-10-10T00:00:00Z"]) assert.throws(() => createExpenseSchema.parse({ ...input, occurredOn }));
  assert.throws(() => createExpenseSchema.parse({ ...input, actorId: "admin" }));
  assert.throws(() => createExpenseSchema.parse({ ...input, description: " " }));
  assert.throws(() => correctExpenseSchema.parse({ ...input, expectedRevision: 1, reason: " " }));
  assert.throws(() => voidExpenseSchema.parse({ operationKey: "void", reason: "Correction", expectedRevision: "1" }));
  for (const query of [{ page: "0" }, { pageSize: "51" }, { q: "x".repeat(161) }, { role: "ADMIN" }]) assert.throws(() => expenseListSchema.parse(query));
});

test("expense projection, immutable revisions and audit commit together; stable replay survives correction and void", async () => {
  const originalTx = prisma.$transaction, originalFind = prisma.expenseRevision.findUnique;
  let state: { expenses: any[]; revisions: any[]; audits: any[] } = { expenses: [], revisions: [], audits: [] };
  let failAudit = false, retry: any = null, attempts = 0, stagedAudits = 0, locks = 0;
  const find = (s: typeof state, key: string) => s.revisions.find(r => r.operationKey === key) ?? null;
  try {
    prisma.expenseRevision.findUnique = (async ({ where }: any) => find(state, where.operationKey)) as any;
    prisma.$transaction = (async (work: any) => {
      attempts++; if (retry) { const error = retry; retry = null; throw error; }
      const staged = { expenses: state.expenses.map(e => ({ ...e })), revisions: state.revisions.map(r => ({ ...r })), audits: [...state.audits] };
      const tx = {
        $queryRaw: async () => { locks++; return []; },
        expense: {
          create: async ({ data }: any) => { const row = { ...data, id: `e${staged.expenses.length + 1}`, revision: 1, status: "RECORDED", amount: new Prisma.Decimal(data.amount), createdAt: new Date() }; staged.expenses.push(row); return row; },
          update: async ({ where, data }: any) => { const row = staged.expenses.find(e => e.id === where.id); Object.assign(row, data, data.amount ? { amount: new Prisma.Decimal(data.amount) } : {}); return row; },
          findUnique: async ({ where, include }: any) => { const row = staged.expenses.find(e => e.id === where.id); return row && { ...row, ...(include ? { revisions: staged.revisions.filter(r => r.expenseId === row.id).map(r => ({ ...r, actor: { id: r.actorId, name: "Manager" } })) } : {}) }; },
        },
        expenseRevision: { findUnique: async ({ where }: any) => find(staged, where.operationKey), create: async ({ data }: any) => { const row = { ...data, id: `r${staged.revisions.length + 1}`, createdAt: new Date() }; staged.revisions.push(row); return row; } },
        auditLog: { create: async ({ data }: any) => { staged.audits.push(data); stagedAudits++; if (failAudit) throw new Error("staged audit rollback"); return data; } },
      };
      const result = await work(tx); state = staged; return result;
    }) as any;
    const created = await createExpense(input, "actor", "MANAGER");
    assert.deepEqual(await createExpense({ ...input, amount: "10.2" }, "actor", "ADMIN"), created);
    assert.deepEqual([state.expenses.length, state.revisions.length, state.audits.length], [1, 1, 1]);
    await assert.rejects(createExpense(input, "other", "ADMIN"), /conflict/);
    await assert.rejects(createExpense({ ...input, amount: "11" }, "actor", "ADMIN"), /conflict/);
    const correction = { ...input, operationKey: "correct-one", amount: "20.01", expectedRevision: 1, reason: "Correct receipt amount" };
    const corrected = await correctExpense(created.expenseId, correction, "actor", "MANAGER");
    assert.equal(corrected.revision, 2); assert.equal(state.revisions[0].amount.toFixed(2), "10.20");
    await assert.rejects(correctExpense(created.expenseId, { ...correction, operationKey: "stale" }, "actor", "ADMIN"), /reload/);
    failAudit = true; const before = JSON.stringify(state), stagedBefore = stagedAudits;
    await assert.rejects(voidExpense(created.expenseId, { expectedRevision: 2, reason: "Duplicate receipt", operationKey: "void-one" }, "actor", "ADMIN"), /staged audit/);
    assert.equal(stagedAudits, stagedBefore + 1); assert.equal(JSON.stringify(state), before);
    failAudit = false;
    retry = { code: "P2010", meta: { code: "1213" } }; const attemptsBefore = attempts;
    await voidExpense(created.expenseId, { expectedRevision: 2, reason: "Duplicate receipt", operationKey: "void-one" }, "actor", "ADMIN");
    assert.equal(attempts, attemptsBefore + 2); assert.equal(state.expenses[0].status, "VOIDED");
    await assert.rejects(correctExpense(created.expenseId, { ...correction, expectedRevision: 3, operationKey: "reopen" }, "actor", "ADMIN"), /reload/);
    assert.deepEqual(await createExpense(input, "actor", "ADMIN"), created);
    assert.deepEqual(await correctExpense(created.expenseId, correction, "actor", "ADMIN"), corrected);
    const detail = await getExpense(created.expenseId, "MANAGER");
    assert.equal(detail.revisions.length, 3); assert.equal(detail.revisions[0].reason, null); assert.equal(detail.revisions[2].reason, "Duplicate receipt");
    assert.equal("operationKey" in detail.revisions[0], false); assert.equal("payloadHash" in detail.revisions[0], false);
    assert.equal(state.audits.length, 3); assert.ok(locks >= 4);
    await assert.rejects(getExpense("missing", "ADMIN"), /not found/);
    await assert.rejects(createExpense(input, "actor", "CASHIER"), /role/i);
  } finally { prisma.$transaction = originalTx; prisma.expenseRevision.findUnique = originalFind; }
});

test("expense list shares a repeatable snapshot with count and bounded current-source search", async () => {
  const original = prisma.$transaction;
  try {
    prisma.$transaction = (async (work: any, opts: any) => {
      assert.equal(opts.isolationLevel, "RepeatableRead"); let where: any;
      return work({ expense: { findMany: async (args: any) => { where = args.where; assert.equal(args.skip, 40); assert.equal(args.take, 20); assert.deepEqual(args.orderBy, [{ occurredOn: "desc" }, { id: "desc" }]); return []; }, count: async (args: any) => { assert.deepEqual(args.where, where); assert.deepEqual(where, { status: "VOIDED", OR: [{ category: { contains: "rent" } }, { description: { contains: "rent" } }] }); return 41; } } });
    }) as any;
    assert.deepEqual(await listExpenses({ q: " rent ", status: "VOIDED", page: "3" }, "MANAGER"), { items: [], total: 41, page: 3, pageSize: 20, totalPages: 3 });
  } finally { prisma.$transaction = original; }
});

test("expense HTTP rejects unauthorized roles, missing CSRF and unexpected inputs before reads; errors stay private", async () => {
  const originalSession = prisma.authSession.findUnique, originalTx = prisma.$transaction;
  const sessions = new Map<string, any>(), cookies = new Map<string, string>(); const csrf = "expense-test-csrf";
  let reads = 0, failure: any = null;
  for (const role of ["ADMIN", "MANAGER", "CASHIER", "STAFF"]) {
    const secret = `expense-test-${role}`; cookies.set(role, `${SESSION_COOKIE_NAME}=${signSessionToken(secret)}`);
    sessions.set(hashSessionSecret(secret), { id: role, expiresAt: new Date(Date.now() + 60000), revokedAt: null, csrfTokenHash: hashSessionSecret(csrf), user: { id: role, role, isActive: true, mustChangePassword: false } });
  }
  const app = express(); app.use(express.json()); app.use("/api/expenses", routes);
  const server = await new Promise<http.Server>(r => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/expenses`;
  const request = (path: string, role?: string, body?: unknown, includeCsrf = true) => fetch(base + path, { method: body ? "POST" : "GET", headers: { ...(role ? { cookie: cookies.get(role)! } : {}), ...(includeCsrf ? { [CSRF_HEADER_NAME]: csrf } : {}), "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    prisma.authSession.findUnique = (async ({ where }: any) => sessions.get(where.tokenHash) ?? null) as any;
    prisma.$transaction = (async (work: any) => { reads++; if (failure) throw failure; return work({ expense: { findMany: async () => [], count: async () => 0, findUnique: async () => null } }); }) as any;
    assert.equal((await request("/")).status, 401);
    for (const role of ["CASHIER", "STAFF"]) for (const path of ["/", "/private"]) assert.equal((await request(path, role)).status, 403);
    assert.equal((await request("/", "ADMIN", input, false)).status, 403); assert.equal(reads, 0);
    for (const role of ["ADMIN", "MANAGER"]) assert.equal((await request("/", role)).status, 200);
    const before = reads;
    for (const path of ["/?role=ADMIN", "/?pageSize=51", "/private?extra=1", `/${"x".repeat(121)}`]) assert.equal((await request(path, "ADMIN")).status, 400);
    assert.equal((await request("/", "ADMIN", { ...input, actorId: "other" })).status, 400); assert.equal(reads, before);
    assert.equal((await request("/missing", "MANAGER")).status, 404);
    failure = { code: "P2021", message: "private schema" }; const schema = await request("/", "ADMIN"); assert.equal(schema.status, 503); assert.equal((await schema.json()).code, "EXPENSE_SCHEMA_UNAVAILABLE");
    failure = new Error("private SQL"); const internal = await request("/", "ADMIN"); assert.equal(internal.status, 500); assert.deepEqual(await internal.json(), { error: "Unable to complete the expense request" });
  } finally { prisma.authSession.findUnique = originalSession; prisma.$transaction = originalTx; await new Promise<void>(r => server.close(() => r())); }
});
