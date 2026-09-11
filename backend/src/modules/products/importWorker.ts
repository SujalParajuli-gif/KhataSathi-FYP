import fs from "node:fs/promises";
import { PDFParse } from "pdf-parse";
import sharp from "sharp";
import prisma from "../../db/prisma";
import { logger } from "../../lib/logger";
import { getImportSourcePath } from "./importSourceStorage";
import { attachProductImportSource, createImageImportPreview, createPdfImportPreview, createScannedPdfImportPreview } from "./importService";
import { extractPdfTextLineRegions } from "./pdfTextLocations";
import { parsePdfTextCatalogPages, type PdfTextCatalogPage } from "./pdfTextCatalogParser";
import { assertExtractionActive, importExecution, importMetadata, persistEmptyImportPage, type ImportPageProgress } from "./importExecution";

let running = false;
let stopping = false;
let active: { id: string; controller: AbortController } | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let inFlight: Promise<void> | undefined;
const JOB_BUDGET_MS = 10 * 60 * 1000;
const TERMINAL_WRITE_ATTEMPTS = 3;
export function pdfPageNeedsOcr(page: PdfTextCatalogPage) {
  return parsePdfTextCatalogPages([page]).rows.length === 0;
}

export function pdfPageHasMeaningfulContent(page: PdfTextCatalogPage) {
  const lines = page.text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => !/^(?:page\s*)?\d+(?:\s*(?:of|\/)\s*\d+)?$/i.test(line));
  return lines.some((line) => /[\p{L}]/u.test(line) || (line.match(/\d/g) || []).length >= 2);
}

export async function renderedPdfPageIsBlank(buffer: Buffer) {
  const { data, info } = await sharp(buffer)
    .flatten({ background: "white" })
    .greyscale()
    .resize({ width: 320, withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (!data.length || !info.width || !info.height) return false;
  let inkPixels = 0;
  for (const value of data) {
    if (value < 242) inkPixels += 1;
  }
  // A page number or tiny footer alone remains below this conservative limit.
  // Anything more substantial is routed to OCR instead of asserted blank.
  return inkPixels / data.length < 0.0015;
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
    let pdfHeaderContext = "";
    let pdfHeaderLine: PdfTextCatalogPage["headerLine"];
    if (parser) {
      const firstPageText = await parser.getText({ partial: [1] });
      pdfHeaderContext = (firstPageText.pages[0]?.text || "").split(/\r?\n/).slice(0, 15).find((line) =>
        /\b(?:description|product|item|name)\b/i.test(line) && /\b(?:rate|price|mrp|wsp)\b/i.test(line),
      ) || "";
      pdfHeaderLine = locatedPages.find((entry) => entry.pageNumber === 1)?.lines.find((line) =>
        /\b(?:description|product|item|name)\b/i.test(line.text) && /\b(?:rate|price|mrp|wsp)\b/i.test(line.text),
      );
    }
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
            const page: PdfTextCatalogPage = {
              pageNumber,
              text: text.pages[0]?.text || "",
              lines: locatedPages.find((entry) => entry.pageNumber === pageNumber)?.lines || [],
              ...(pageNumber > 1 && pdfHeaderContext ? { headerContext: pdfHeaderContext } : {}),
              ...(pageNumber > 1 && pdfHeaderLine ? { headerLine: pdfHeaderLine } : {}),
            };
            if (!pdfPageNeedsOcr(page)) {
              execution.extractor = "TEXT_TABLE_V3";
              await createPdfImportPreview({ ...common, pages: [page] });
            } else {
              const screenshots = await parser.getScreenshot({ partial: [pageNumber], desiredWidth: 1800, imageBuffer: true, imageDataUrl: false });
              const screenshot = screenshots.pages[0];
              if (!screenshot) throw new Error("This page could not be rendered.");
              const rendered = Buffer.from(screenshot.data);
              if (!pdfPageHasMeaningfulContent(page) && await renderedPdfPageIsBlank(rendered)) {
                execution.extractor = "EMPTY_PAGE";
                await persistEmptyImportPage();
              } else {
                execution.extractor = "PDF_OCR_AI";
                await createScannedPdfImportPreview({ ...common, pages: [{ pageNumber, mimeType: "image/png", buffer: rendered }] });
              }
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

async function persistTerminalBatchState(id: string, jobError: string | null) {
  let lastError: unknown;
  for (let attempt = 0; attempt < TERMINAL_WRITE_ATTEMPTS; attempt += 1) {
    try {
      const current = await prisma.productImportBatch.findUniqueOrThrow({ where: { id } });
      const meta = importMetadata(current.extractionMeta);
      const count = await prisma.productImportRow.count({ where: { batchId: id } });
      await prisma.productImportBatch.update({ where: { id }, data: {
        status: count ? "DRAFT" : "FAILED",
        totalRows: count,
        extractionMeta: { ...meta, jobError, finishedAt: new Date().toISOString() },
      } });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function reconcileStrandedTerminalBatch() {
  const stranded = await prisma.productImportBatch.findFirst({
    where: { status: "PROCESSING", deletedAt: null },
    orderBy: { createdAt: "asc" },
  });
  if (!stranded || active?.id === stranded.id) return;
  const meta = importMetadata(stranded.extractionMeta);
  const pages = (meta.pages || []) as ImportPageProgress[];
  const totalPages = Math.max(0, Number(meta.totalPages || 0));
  const visited = new Set(pages.map((page) => page.pageNumber)).size;
  const recoveryMessage = visited >= totalPages && totalPages > 0
    ? (typeof meta.jobError === "string" ? meta.jobError : null)
    : "Processing was interrupted. Completed pages are saved; resume the remaining pages when ready.";
  await persistTerminalBatchState(stranded.id, recoveryMessage);
}

export async function runImportWorkerOnce() {
  if (running || stopping) return;
  running = true;
  try {
    await reconcileStrandedTerminalBatch();
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
    await persistTerminalBatchState(next.id, jobError);
  } catch (error) { logger.error("Import worker failed", error); }
  finally { active = null; running = false; }
}

export async function startImportWorker() {
  stopping = false;
  // Reconcile the single previously active job from saved page markers before
  // converting genuinely in-flight startup states to interrupted.
  await reconcileStrandedTerminalBatch();
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

export async function controlImport(
  batchId: string,
  action: "cancel" | "retry" | "reprocess_empty",
  pageNumbers: number[] = [],
) {
  const batch = await prisma.productImportBatch.findFirst({ where: { id: batchId, deletedAt: null } });
  if (!batch) throw new Error("Import batch not found.");
  const meta = importMetadata(batch.extractionMeta);
  if (meta.parser !== "PAGE_PIPELINE_V1" || !["PDF", "IMAGE"].includes(batch.sourceType)) throw new Error("Upload this source again to use resumable extraction.");
  if (action === "cancel") {
    const result = await prisma.productImportBatch.updateMany({ where: { id: batchId, status: { in: ["QUEUED", "PROCESSING"] } }, data: { status: "CANCELLING" } });
    if (result.count && active?.id === batchId) active.controller.abort();
    else if (result.count) await prisma.productImportBatch.update({ where: { id: batchId }, data: { status: "INTERRUPTED" } });
  } else if (action === "reprocess_empty") {
    if (await prisma.productImportCommit.count({ where: { batchId } })) {
      throw new Error("This batch already has an import attempt. Upload the missing pages as a new batch.");
    }
    if (!batch.sourceStoredFileName) throw new Error("Upload the source again before reprocessing.");
    const selected = [...new Set(pageNumbers.filter((page) => Number.isInteger(page) && page > 0))];
    if (!selected.length) throw new Error("Select at least one empty page to reprocess.");
    const pages = (meta.pages || []) as ImportPageProgress[];
    const eligible = pages.filter((page) =>
      selected.includes(page.pageNumber) && page.status === "DONE" && page.extractor === "EMPTY_PAGE",
    );
    if (eligible.length !== selected.length) {
      throw new Error("Only completed pages previously classified as empty can be reprocessed.");
    }
    const nextMeta = {
      ...meta,
      pages: pages.filter((page) => !selected.includes(page.pageNumber)),
      jobError: null,
      reprocessedEmptyPages: selected,
    };
    const result = await prisma.productImportBatch.updateMany({
      where: { id: batchId, status: { in: ["DRAFT", "FAILED", "INTERRUPTED"] } },
      data: { status: "QUEUED", extractionMeta: nextMeta },
    });
    if (!result.count) throw new Error("This import is already processing or committed.");
  } else {
    if (meta.totalPages && (meta.pages || []).filter((page: ImportPageProgress) => page.status !== "FAILED").length >= meta.totalPages) throw new Error("All pages with candidates are saved. For partially read pages, upload a crop of missing products as a new import.");
    if (!batch.sourceStoredFileName) throw new Error("Upload the source again before retrying.");
    if (await prisma.productImportCommit.count({ where: { batchId } })) throw new Error("This batch already has an import attempt. Upload the missing pages as a new batch.");
    const result = await prisma.productImportBatch.updateMany({ where: { id: batchId, status: { in: ["DRAFT", "FAILED", "INTERRUPTED"] } }, data: { status: "QUEUED" } });
    if (!result.count) throw new Error("This import is already processing or committed.");
  }
  return { accepted: true };
}
