import test from "node:test";
import assert from "node:assert/strict";
import prisma from "../db/prisma";
import { listAuditLogs, listCategorizedHistory } from "../modules/audit/service";
import { list } from "../modules/audit/controller";
import { denyStaff } from "../middleware/rbac";
import { getSaleEvidenceHistory, projectProofHistory } from "../modules/salesEvidence/corrections";
import { getSaleEvidenceHistoryHandler } from "../modules/salesEvidence/controller";

const actor = { id: "reviewer", name: "Reviewer", role: "MANAGER" as const };
const caps = async () => ({ businessMode: "FULL_POS" as const, catalogEnabled: true as const,
  inventoryEnabled: true, posEnabled: true, staffDraftRequestsEnabled: true, stockTracked: true });

// Evaluate the actual composed predicates, including nested search and exclusions.
function matches(row: any, where: any): boolean {
  return !!row && Object.entries(where ?? {}).every(([key, value]: any) => {
    if (key === "AND") return value.every((w: any) => matches(row, w));
    if (key === "OR") return value.some((w: any) => matches(row, w));
    if (value && typeof value === "object") {
      return Object.entries(value).every(([op, arg]: any) => {
        if (op === "not") return !matches(row, { [key]: arg });
        if (op === "startsWith") return String(row[key]).startsWith(arg);
        if (op === "contains") return String(row[key]).includes(arg);
        if (op === "equals") return row[key] === arg;
        if (op === "in") return arg.includes(row[key]);
        return matches(row[key], { [op]: arg });
      });
    }
    return row[key] === value;
  });
}

const event = (id: string, action: string, entityId = "private-proof") => ({
  id, action, entityId, entityType: "Document", actorId: actor.id, actor,
  createdAt: new Date("2026-10-12T00:00:00Z"),
  meta: { priorRevision: "before", revision: "after", corrected: { customerName: "Private customer" },
    sourceSha256: "private-source", operationKey: "private-operation", decisionHash: "private-decision" },
});

test("CASHIER generic audit hides all sales OCR rows, counts, searches and filtered pages", async () => {
  const rows = [event("1", "SALES_OCR_EXTRACTED"), event("2", "SALES_OCR_REVIEW_SAVED"),
    event("3", "SALES_OCR_FUTURE_EVENT"), event("4", "SALE_EVIDENCE_VOIDED"),
    event("5", "INVOICE_FINALIZED", "public-1"), event("6", "INVOICE_FINALIZED", "public-2")];
  const original = { findMany: prisma.auditLog.findMany, count: prisma.auditLog.count };
  const queries: any[] = [];
  (prisma.auditLog as any).findMany = async ({ where, skip = 0, take }: any) => {
    queries.push(where); return rows.filter(row => matches(row, where)).slice(skip, skip + take);
  };
  (prisma.auditLog as any).count = async ({ where }: any) => {
    queries.push(where); return rows.filter(row => matches(row, where)).length;
  };
  try {
    let admitted = false;
    denyStaff({ user: { role: "CASHIER" } } as any, {} as any, () => { admitted = true; });
    assert.equal(admitted, true);
    let payload: any;
    await list({ user: { role: "CASHIER" }, query: { page: "2", pageSize: "1" } } as any,
      { json(value: any) { payload = value; }, status() { throw Error("Unexpected controller failure"); } } as any);
    assert.equal(payload.total, 2);
    assert.deepEqual(payload.logs.map((r: any) => r.id), ["6"]);
    const page = await listCategorizedHistory({ page: 2, pageSize: 1 });
    assert.equal(page.total, 2);
    assert.deepEqual(page.events.map(r => r.id), ["6"]);
    for (const action of ["SALES_OCR_", "SALES_OCR_REVIEW_SAVED", "SALES_OCR_FUTURE_EVENT"]) {
      const generic = await listAuditLogs({ action, entityType: "Document", actorId: actor.id });
      assert.equal(generic.total, 0); assert.deepEqual(generic.logs, []);
      const categorized = await listCategorizedHistory({ category: "document", action });
      assert.equal(categorized.total, 0); assert.deepEqual(categorized.events, []);
    }
    for (const q of ["private-proof", "SALES_OCR_"]) {
      const result = await listCategorizedHistory({ q });
      assert.equal(result.total, 0); assert.deepEqual(result.events, []);
    }
    for (let i = 0; i < queries.length; i += 2) assert.deepEqual(queries[i], queries[i + 1]);
  } finally { Object.assign(prisma.auditLog, original); }
});

test("authorized retained proof history selects OCR events and safely projects revision provenance", async () => {
  const document: any = { id: "private-proof", documentType: "SALE_BILL", visibility: "ADMIN_MANAGER",
    saleRecoveryStatus: "ARCHIVED", linkedEntityId: null, deletedAt: new Date("2026-10-12") };
  const rows = [event("1", "SALES_OCR_EXTRACTED"), event("2", "SALES_OCR_REVIEW_SAVED"),
    event("3", "SALE_EVIDENCE_ARCHIVED"), event("4", "SALES_OCR_REVIEW_SAVED", "other-proof"),
    event("5", "PUBLIC_OTHER_ACTION")];
  const original = { document: prisma.document.findFirst, audit: prisma.auditLog.findMany };
  let auditReads = 0, documentReads = 0;
  (prisma.document as any).findFirst = async ({ where }: any) => {
    documentReads++; return matches(document, where) ? document : null;
  };
  (prisma.auditLog as any).findMany = async ({ where, orderBy, take }: any) => {
    auditReads++;
    assert.deepEqual(orderBy, [{ createdAt: "desc" }, { id: "desc" }]); assert.equal(take, 100);
    return rows.filter(row => matches(row, where)).sort((a, b) => b.id.localeCompare(a.id)).slice(0, take);
  };
  try {
    const result = await getSaleEvidenceHistory(document.id, actor, caps);
    assert.equal(auditReads, 1); assert.equal(documentReads, 1);
    assert.equal(result.document.retained, true); assert.deepEqual(result.document.voidedAt, document.deletedAt);
    assert.deepEqual(result.history.map(r => r.id), ["3", "2", "1"]);
    for (const entry of result.history.filter(r => r.action.startsWith("SALES_OCR_"))) {
      assert.deepEqual((entry.meta as any).review, { priorRevision: "before", revision: "after" });
      assert.equal(entry.actorName, actor.name); assert.equal(entry.actorRole, actor.role);
      assert.deepEqual(entry.createdAt, rows[0].createdAt);
      for (const key of ["corrected", "sourceSha256", "operationKey", "decisionHash"]) assert.ok(!(key in entry.meta));
      assert.ok(!JSON.stringify(entry).includes("Private customer"));
    }
    assert.ok(!("review" in result.history[0].meta)); // Existing non-OCR projection unchanged.
    const beforeDenials = auditReads;
    for (const role of ["CASHIER", "STAFF"] as const) {
      await assert.rejects(getSaleEvidenceHistory(document.id, { ...actor, role }, caps), (e: any) => e.statusCode === 403);
    }
    await assert.rejects(getSaleEvidenceHistory(document.id, actor, async () => ({ ...await caps(), posEnabled: false })),
      (e: any) => e.statusCode === 403);
    document.visibility = "ADMIN_ONLY"; // Re-evaluate current visibility on every request.
    await assert.rejects(getSaleEvidenceHistory(document.id, actor, caps), (e: any) => e.code === "NOT_FOUND");
    await assert.rejects(getSaleEvidenceHistory("missing", actor, caps), (e: any) => e.code === "NOT_FOUND");
    assert.equal(auditReads, beforeDenials);
    const admin = await getSaleEvidenceHistory(document.id, { ...actor, role: "ADMIN" }, caps);
    assert.equal(admin.history.length, 3);
    let status = 200;
    await getSaleEvidenceHistoryHandler({ params: { id: document.id }, user: actor } as any,
      { locals: { businessCapabilities: await caps() }, status(value: number) { status = value; return this; }, json() { return this; } } as any);
    assert.equal(status, 404); assert.equal(auditReads, beforeDenials + 1);
  } finally { prisma.document.findFirst = original.document; prisma.auditLog.findMany = original.audit; }
});

test("review provenance rejects malformed values and never spreads raw metadata", () => {
  const row = event("1", "SALES_OCR_REVIEW_SAVED");
  const projected = projectProofHistory({ ...row, meta: { ...row.meta, priorRevision: { corrected: "secret" }, revision: 42 } });
  assert.deepEqual((projected.meta as any).review, { priorRevision: null, revision: null });
  assert.ok(!JSON.stringify(projected).includes("secret"));
});
