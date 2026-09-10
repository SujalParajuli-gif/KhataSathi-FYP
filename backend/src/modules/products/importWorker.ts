import fs from "node:fs/promises";
import { PDFParse } from "pdf-parse";
import prisma from "../../db/prisma";
import { logger } from "../../lib/logger";
import { getImportSourcePath } from "./importSourceStorage";
import { attachProductImportSource, createImageImportPreview, createPdfImportPreview, createScannedPdfImportPreview } from "./importService";
import { extractPdfTextLineRegions } from "./pdfTextLocations";
import { parsePdfTextCatalogPages, type PdfTextCatalogPage } from "./pdfTextCatalogParser";
import { assertExtractionActive, importExecution, importMetadata, type ImportPageProgress } from "./importExecution";

let running = false;
let stopping = false;
let active: { id: string; controller: AbortController } | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let inFlight: Promise<void> | undefined;
const JOB_BUDGET_MS = 10 * 60 * 1000;
export function pdfPageNeedsOcr(page: PdfTextCatalogPage) {
  return parsePdfTextCatalogPages([page]).rows.length === 0;
}

export async function enqueueImport(input: { fileName: string; mimeType: string; buffer: Buffer; createdById: string; supplier?: string }) {
  const batch = await prisma.productImportBatch.create({ data: { sourceType: input.mimeType === "application/pdf" || /\.pdf$/i.test(input.fileName) ? "PDF" : "IMAGE",
    fileName: input.fileName, supplier: input.supplier?.trim() || null, createdById: input.createdById, status: "UPLOADING",
    fileSizeBytes: input.buffer.length, extractionMeta: { parser: "PAGE_PIPELINE_V1", pages: [], queuedAt: new Date().toISOString() } } });
  try {
    await attachProductImportSource({ batchId: batch.id, originalName: input.fileName, mimeType: input.mimeType, buffer: input.buffer });
    await prisma.productImportBatch.update({ where: { id: batch.id }, data: { status: "QUEUED", fileFingerprint: (await prisma.productImportBatch.findUniqueOrThrow({ where: { id: batch.id } })).sourceChecksum } });
  } catch (error) {
    await prisma.productImportBatch.update({ where: { id: batch.id }, data: { status: "FAILED", extractionMeta: { jobError: "The source file could not be saved. Upload the file again." } } });
    throw error;
  }
  return { batchId: batch.id, sourceType: batch.sourceType, totalRows: 0, errorCount: 0, createdCount: 0, errors: [], message: "File saved. Extraction is queued; you can leave this page and return to its review." };
}

async function processBatch(id: string, signal: AbortSignal) {
  const batch = await prisma.productImportBatch.findUniqueOrThrow({ where: { id } });
  const sourcePath = getImportSourcePath(batch);
  if (!sourcePath) throw new Error("The saved source is unavailable. Upload the file again.");
  const buffer = await fs.readFile(sourcePath);
  const deadline = Date.now() + JOB_BUDGET_MS;
  const meta = importMetadata(batch.extractionMeta);
  const done = new Set<number>((meta.pages || []).filter((page: ImportPageProgress) => page.status !== "FAILED").map((page: ImportPageProgress) => page.pageNumber));
  const parser = batch.sourceType === "PDF" ? new PDFParse({ data: buffer }) : null;
  try {
    const totalPages = parser ? (await parser.getInfo()).total : 1;
    if (totalPages > 100) throw new Error("This PDF exceeds 100 pages. Split it into smaller files before importing.");
    await prisma.productImportBatch.update({ where: { id }, data: { extractionMeta: { ...meta, totalPages, jobError: null } } });
    const locatedPages = parser ? await extractPdfTextLineRegions(buffer).catch(() => []) : [];
    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
      if (done.has(pageNumber)) continue;
      const execution = { batchId: id, pageNumber, supplier: batch.supplier || "", signal, deadline, startedAt: Date.now(), extractor: "IMAGE_AI" };
      await importExecution.run(execution, async () => {
        assertExtractionActive();
        try {
          const common = { fileName: batch.fileName || "Supplier file", createdById: batch.createdById };
          if (!parser) {
            await createImageImportPreview({ ...common, mimeType: batch.sourceMimeType || "image/png", buffer });
          } else {
            const text = await parser.getText({ partial: [pageNumber] });
            const page: PdfTextCatalogPage = { pageNumber, text: text.pages[0]?.text || "", lines: locatedPages.find((entry) => entry.pageNumber === pageNumber)?.lines || [] };
            if (!pdfPageNeedsOcr(page)) {
              execution.extractor = "TEXT_TABLE_V3";
              await createPdfImportPreview({ ...common, pages: [page] });
            } else {
              execution.extractor = "PDF_OCR_AI";
              const screenshots = await parser.getScreenshot({ partial: [pageNumber], desiredWidth: 1800, imageBuffer: true, imageDataUrl: false });
              const screenshot = screenshots.pages[0];
              if (!screenshot) throw new Error("This page could not be rendered.");
              await createScannedPdfImportPreview({ ...common, pages: [{ pageNumber, mimeType: "image/png", buffer: Buffer.from(screenshot.data) }] });
            }
          }
        } catch (error) {
          signal.throwIfAborted();
          const current = await prisma.productImportBatch.findUniqueOrThrow({ where: { id } });
          const currentMeta = importMetadata(current.extractionMeta);
          const failure: ImportPageProgress = { pageNumber, status: "FAILED", extractor: execution.extractor, rows: 0, durationMs: Date.now() - execution.startedAt,
            message: "This page could not be read. Check the source, then retry the remaining pages." };
          await prisma.productImportBatch.update({ where: { id }, data: { extractionMeta: { ...currentMeta, pages: [...(currentMeta.pages || []).filter((page: ImportPageProgress) => page.pageNumber !== pageNumber), failure] } } });
          logger.error("Import page extraction failed", error);
          assertExtractionActive();
        }
      });
    }
  } finally { await parser?.destroy().catch(() => undefined); }
}

export async function runImportWorkerOnce() {
  if (running || stopping) return;
  running = true;
  try {
    const next = await prisma.productImportBatch.findFirst({ where: { status: "QUEUED", deletedAt: null }, orderBy: { createdAt: "asc" } });
    if (!next) return;
    const claimed = await prisma.productImportBatch.updateMany({ where: { id: next.id, status: "QUEUED", deletedAt: null }, data: { status: "PROCESSING" } });
    if (!claimed.count) return;
    active = { id: next.id, controller: new AbortController() };
    let jobError: string | null = null;
    try { await processBatch(next.id, active.controller.signal); }
    catch (error) {
      jobError = active.controller.signal.aborted ? "Processing stopped. Completed pages are saved; resume the remaining pages when ready." : "Processing was interrupted or the file exceeded its limits. Completed pages are saved. Split large files or retry remaining pages.";
      logger.error("Import processing stopped", error);
    }
    const current = await prisma.productImportBatch.findUniqueOrThrow({ where: { id: next.id } });
    const meta = importMetadata(current.extractionMeta);
    const count = await prisma.productImportRow.count({ where: { batchId: next.id } });
    await prisma.productImportBatch.update({ where: { id: next.id }, data: { status: count ? "DRAFT" : "FAILED", totalRows: count,
      extractionMeta: { ...meta, jobError, finishedAt: new Date().toISOString() } } });
  } catch (error) { logger.error("Import worker failed", error); }
  finally { active = null; running = false; }
}

export async function startImportWorker() {
  stopping = false;
  // This deployment runs one backend. A restart never silently retries external calls.
  await prisma.productImportBatch.updateMany({ where: { status: { in: ["PROCESSING", "CANCELLING", "UPLOADING"] } }, data: { status: "INTERRUPTED" } });
  await prisma.productImportBatch.updateMany({ where: { status: "COMMITTING" }, data: { status: "DRAFT" } });
  await prisma.productImportCommit.updateMany({ where: { status: "IN_PROGRESS" }, data: { status: "FAILED", completedAt: new Date(), error: "The server restarted during this attempt. Completed product rows are saved; review and submit remaining rows." } });
  const dispatch = () => { if (!running) inFlight = runImportWorkerOnce(); };
  timer = setInterval(dispatch, 2000);
  timer.unref();
  dispatch();
}
export async function stopImportWorker() { stopping = true; if (timer) clearInterval(timer); active?.controller.abort(); await inFlight; }

export async function controlImport(batchId: string, action: "cancel" | "retry") {
  const batch = await prisma.productImportBatch.findFirst({ where: { id: batchId, deletedAt: null } });
  if (!batch) throw new Error("Import batch not found.");
  const meta = importMetadata(batch.extractionMeta);
  if (meta.parser !== "PAGE_PIPELINE_V1" || !["PDF", "IMAGE"].includes(batch.sourceType)) throw new Error("Upload this source again to use resumable extraction.");
  if (action === "cancel") {
    const result = await prisma.productImportBatch.updateMany({ where: { id: batchId, status: { in: ["QUEUED", "PROCESSING"] } }, data: { status: "CANCELLING" } });
    if (result.count && active?.id === batchId) active.controller.abort();
    else if (result.count) await prisma.productImportBatch.update({ where: { id: batchId }, data: { status: "INTERRUPTED" } });
  } else {
    if (meta.totalPages && (meta.pages || []).filter((page: ImportPageProgress) => page.status !== "FAILED").length >= meta.totalPages) throw new Error("All pages with candidates are saved. For partially read pages, upload a crop of missing products as a new import.");
    if (!batch.sourceStoredFileName) throw new Error("Upload the source again before retrying.");
    if (await prisma.productImportCommit.count({ where: { batchId } })) throw new Error("This batch already has an import attempt. Upload the missing pages as a new batch.");
    const result = await prisma.productImportBatch.updateMany({ where: { id: batchId, status: { in: ["DRAFT", "FAILED", "INTERRUPTED"] } }, data: { status: "QUEUED" } });
    if (!result.count) throw new Error("This import is already processing or committed.");
  }
  return { accepted: true };
}
