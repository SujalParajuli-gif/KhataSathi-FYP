import prisma from "../../db/prisma";
import { importCoverage } from "./importExecution";

// Status polling must not load extracted rows, compare catalog matches, or expose source paths.
export async function getProductImportStatus(batchId: string) {
  const batch = await prisma.productImportBatch.findFirst({
    where: { id: batchId, deletedAt: null },
    select: { id: true, fileName: true, sourceType: true, status: true,
      totalRows: true, importedRows: true, failedRows: true, createdAt: true, extractionMeta: true },
  });
  if (!batch) return null;
  const { extractionMeta, ...summary } = batch;
  const coverage = importCoverage(extractionMeta, batch.status);
  return { batch: summary, coverage: {
    total: coverage.total, visited: coverage.visited, completed: coverage.completed,
    canRetry: coverage.canRetry, outcome: coverage.outcome,
  } };
}
