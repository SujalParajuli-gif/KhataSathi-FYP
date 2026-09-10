import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma } from "@prisma/client";
import prisma from "../../db/prisma";

export type ImportPageProgress = { pageNumber: number; status: "DONE" | "PARTIAL" | "FAILED"; extractor: string; rows: number; durationMs: number; candidateCount?: number; reviewRequiredCount?: number; message?: string };
export type ImportExecution = { batchId: string; pageNumber: number; supplier: string; signal: AbortSignal; deadline: number; startedAt: number; extractor: string };
export const importExecution = new AsyncLocalStorage<ImportExecution>();
export function importMetadata(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
export function assertExtractionActive() {
  const execution = importExecution.getStore();
  execution?.signal.throwIfAborted();
  if (execution && Date.now() >= execution.deadline) throw new Error("The import reached its processing time limit. Retry the remaining pages.");
}

export function importCoverage(value: unknown) {
  const meta = importMetadata(value);
  const pages = (Array.isArray(meta.pages) ? meta.pages : []) as ImportPageProgress[];
  const total = Math.max(0, Number(meta.totalPages) || 0);
  const completed = pages.filter((page) => page.status === "DONE").length;
  return { total, completed, failedPages: pages.filter((page) => page.status !== "DONE"),
    requiresAcknowledgement: meta.parser === "PAGE_PIPELINE_V1" && (completed < total || !total || Boolean(meta.jobError)) };
}

// A page's rows and completion marker are saved together. Retrying an interrupted
// job skips completed pages and never replaces the operator's saved corrections.
export async function persistImportPreview(args: Prisma.ProductImportBatchCreateArgs) {
  const execution = importExecution.getStore();
  if (!execution) return prisma.productImportBatch.create({ ...args, include: { rows: { orderBy: { rowNumber: "asc" }, take: 50 } } });
  assertExtractionActive();
  return prisma.$transaction(async (tx) => {
    const batch = await tx.productImportBatch.findUniqueOrThrow({ where: { id: execution.batchId } });
    if (batch.deletedAt || batch.status !== "PROCESSING") throw new Error("Import processing was cancelled.");
    const meta = importMetadata(batch.extractionMeta);
    const pages = (meta.pages || []) as ImportPageProgress[];
    const inputRows = args.data.rows?.create;
    const rows = (Array.isArray(inputRows) ? inputRows : inputRows ? [inputRows] : []) as Prisma.ProductImportRowCreateWithoutBatchInput[];
    const goodRows = rows.filter((row) => row.status !== "FAILED");
    if (pages.some((page) => page.pageNumber === execution.pageNumber && page.status !== "FAILED")) {
      return tx.productImportBatch.findUniqueOrThrow({ where: { id: batch.id }, include: { rows: { take: 50 } } });
    }
    const lastRow = await tx.productImportRow.aggregate({ where: { batchId: batch.id }, _max: { rowNumber: true } });
    const offset = lastRow._max.rowNumber || 0;
    const page: ImportPageProgress = { pageNumber: execution.pageNumber,
      status: goodRows.length === rows.length && rows.length ? "DONE" : goodRows.length ? "PARTIAL" : "FAILED",
      extractor: execution.extractor, rows: goodRows.length, candidateCount: rows.length,
      reviewRequiredCount: goodRows.filter((row) => !row.resolution).length, durationMs: Date.now() - execution.startedAt };
    if (page.status !== "DONE") page.message = page.status === "PARTIAL"
      ? "Only part of this page was extracted. Saved candidates are retained; upload a crop of missing products as a new import."
      : rows.some((row) => row.error?.includes("not configured"))
        ? "Image reading is not configured. Ask an administrator to enable it, or upload a CSV/XLSX version."
        : "No complete product table was extracted. Check this page or retry it.";
    const incomingMeta = importMetadata(args.data.extractionMeta);
    const columns = new Map<string, any>((meta.priceColumns || []).map((column: any) => [column.key, column]));
    for (const column of incomingMeta.priceColumns || []) columns.set(column.key, column);
    const savedRows = goodRows.map((row, index) => ({ ...row, rowNumber: offset + index + 1 }));
    if (offset + savedRows.length > 5000) throw new Error("The import exceeds 5000 rows. Split the source into smaller files.");
    return tx.productImportBatch.update({ where: { id: batch.id }, data: {
      totalRows: { increment: savedRows.length },
      extractionMeta: { ...meta, parser: "PAGE_PIPELINE_V1", pages: [...pages.filter((entry) => entry.pageNumber !== page.pageNumber), page], priceColumns: [...columns.values()] },
      priceMapping: { ...importMetadata(args.data.priceMapping), ...importMetadata(batch.priceMapping) },
      rows: { create: savedRows },
    }, include: { rows: { orderBy: { rowNumber: "asc" }, take: 50 } } });
  });
}
