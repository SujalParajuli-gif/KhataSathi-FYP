import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID, randomInt } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import prisma from "../db/prisma";
import { documentStorageRoot } from "../lib/storageReadiness";
import { archiveSaleEvidence } from "../modules/salesEvidence/service";
import { getSalesReview, saveSalesReview, extractSalesReview, salesReviewMatches } from "../modules/salesEvidence/review";

test("MySQL sales review races, audit rollback and archive overlap preserve operational rows", {
  skip: process.env.KHATASATHI_SALES_REVIEW_MYSQL_TEST !== "1", timeout: 90000,
}, async () => {
  const target = new URL(process.env.DATABASE_URL || "");
  assert.ok(["localhost", "127.0.0.1"].includes(target.hostname)); assert.equal(target.port || "3306", "3306"); assert.equal(target.pathname, "/ks_verify_mixed_credit_20261011");
  assert.equal(process.env.KHATASATHI_SALES_REVIEW_OWNED_STORAGE, documentStorageRoot, "dedicated task storage must be bound before imports");
  const financial = async () => JSON.stringify(await Promise.all([
    prisma.invoice.findMany({ orderBy: { id: "asc" } }), prisma.payment.findMany({ orderBy: { id: "asc" } }),
    prisma.stockTransaction.findMany({ orderBy: { id: "asc" } }), prisma.cashDrawer.findMany({ orderBy: { id: "asc" } }),
    prisma.cashDrawerEvent.findMany({ orderBy: { id: "asc" } }), prisma.expense.findMany({ orderBy: { id: "asc" } }),
    prisma.supplierPayment.findMany({ orderBy: { id: "asc" } }),
  ]));
  const sourceSnapshot = async () => JSON.stringify(await Promise.all([prisma.document.findMany({ orderBy: { id: "asc" } }), prisma.auditLog.findMany({ orderBy: { id: "asc" } })]));
  let actorId: string | undefined; const ids: string[] = [], originalTransaction = prisma.$transaction.bind(prisma);
  const relative = `documents/sales-review-${randomUUID()}`, folder = path.resolve(documentStorageRoot, relative);
  assert.ok(folder.startsWith(documentStorageRoot + path.sep));
  const beforeFinancial = await financial(), baselineSources = await sourceSnapshot();
  try {
    await fs.mkdir(folder, { recursive: true });
    const bytes = await sharp({ create: { width: 12, height: 12, channels: 3, background: "white" } }).png().toBuffer(); await fs.writeFile(path.join(folder, "source.png"), bytes);
    const actor = await prisma.user.create({ data: { name: "Owned sales review", phone: `+97794${randomInt(10000000,99999999)}`, passwordHash: "unusable", role: "ADMIN" } }); actorId = actor.id;
    const checksum = createHash("sha256").update(bytes).digest("hex");
    for (const visibility of ["ADMIN_MANAGER", "ADMIN_MANAGER", "ADMIN_ONLY"] as const) {
      const doc = await prisma.document.create({ data: { documentType: "SALE_BILL", fileName: "source.png", storedFileName: "source.png", storedPath: relative,
        mimeType: "image/png", fileSize: bytes.length, checksum, visibility, uploadedById: actor.id, saleRecoveryStatus: "UNRESOLVED" } }); ids.push(doc.id);
    }
    const observations = { billNumber: "OWNED-SALES-REVIEW", customerName: null, billDate: null, total: "20.00", lines: [] };
    const corrected = { ...observations, lines: [] };
    const saved = await saveSalesReview(ids[0], actor, { expectedRevision: null, corrected });
    await saveSalesReview(ids[0], actor, { expectedRevision: null, corrected });
    assert.equal(await prisma.auditLog.count({ where: { actorId } }), 1, "manual-save lost response replay emits one audit");
    let arrivals = 0, release!: () => void; const connections = new Set<number>(), gate = new Promise<void>(resolve => { release = resolve; });
    prisma.$transaction = ((work: any) => originalTransaction(async (tx: any) => {
      const [connection] = await tx.$queryRaw`SELECT CONNECTION_ID() id`; connections.add(Number(connection.id));
      arrivals++; if (arrivals === 2) release(); await gate;
      return work(tx);
    })) as any;
    const outcomes = await Promise.allSettled(["21.00", "22.00"].map(total => saveSalesReview(ids[0], actor, { expectedRevision: saved.review!.revision, corrected: { ...corrected, total } })));
    prisma.$transaction = originalTransaction;
    assert.equal(arrivals, 2); assert.equal(connections.size, 2, "both competing real transactions entered on distinct connections before locks");
    assert.equal(outcomes.filter(o => o.status === "fulfilled").length, 1);
    const loser = outcomes.find(o => o.status === "rejected") as PromiseRejectedResult; assert.equal(loser.reason.status, 409);
    const winner: any = (outcomes.find(o => o.status === "fulfilled") as PromiseFulfilledResult<any>).value;
    assert.equal((await getSalesReview(ids[0], actor)).review!.corrected!.total, winner.review.corrected.total);
    assert.equal(await prisma.auditLog.count({ where: { actorId } }), 2);
    let stagedEntered = 0;
    prisma.$transaction = ((work: any) => originalTransaction(async (tx: any) => work(new Proxy(tx, { get(target, key) {
      if (key !== "auditLog") return Reflect.get(target, key);
      return { ...tx.auditLog, create: async () => {
        const staged = await tx.document.findUniqueOrThrow({ where: { id: ids[0] } });
        assert.equal(staged.salesReview.corrected.total, "23.00"); stagedEntered++; throw Error("Owned audit fault after real staged review update");
      } };
    } })))) as any;
    await assert.rejects(saveSalesReview(ids[0], actor, { expectedRevision: winner.review.revision, corrected: { ...corrected, total: "23.00" } }), /Owned audit fault/);
    prisma.$transaction = originalTransaction; assert.equal(stagedEntered, 1);
    assert.deepEqual((await getSalesReview(ids[0], actor)).review, winner.review); assert.equal(await prisma.auditLog.count({ where: { actorId } }), 2);
    const matches = await salesReviewMatches(ids[0], { ...actor, role: "MANAGER" });
    assert.ok(matches.duplicates.some(d => d.id === ids[1])); assert.ok(!matches.duplicates.some(d => d.id === ids[2]), "private duplicate identity never disclosed");
    let overlapEntered = 0;
    await assert.rejects(extractSalesReview(ids[0], actor, { operationKey: randomUUID(), expectedRevision: winner.review.revision }, async () => {
      overlapEntered++;
      const archived = await archiveSaleEvidence(ids[0], { reason: "Owned competing archive review" }, actor);
      assert.equal(archived!.document.saleRecoveryStatus, "ARCHIVED");
      assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: ids[0] } })).saleRecoveryStatus, "ARCHIVED", "competing owning archive committed before extraction lock");
      return { observations, model: "fixture-only" };
    }), (e: any) => e.status === 409);
    assert.equal(overlapEntered, 1); assert.deepEqual((await getSalesReview(ids[0], actor)).review, winner.review);
    assert.equal((await archiveSaleEvidence(ids[0], { reason: "Owned competing archive review" }, actor))!.replayed, true);
    assert.equal(await prisma.auditLog.count({ where: { actorId } }), 3);
    assert.equal(await financial(), beforeFinancial, "review, matching and archive never write operational financial rows");
  } finally {
    prisma.$transaction = originalTransaction;
    try {
      if (actorId) { await prisma.auditLog.deleteMany({ where: { actorId } }); await prisma.document.deleteMany({ where: { uploadedById: actorId } }); await prisma.user.delete({ where: { id: actorId } }); }
      await fs.rm(folder, { recursive: true, force: true });
      assert.equal(await sourceSnapshot(), baselineSources, "preexisting source/audit rows preserved after owned cleanup");
      assert.equal(await financial(), beforeFinancial);
    } finally { await prisma.$disconnect(); }
  }
});
