import fs from "fs";
import path from "path";
import prisma from "../db/prisma";
import { createCsvImportPreview } from "../modules/products/service";
import {
  parseProductSpreadsheet,
  SpreadsheetImportError,
} from "../modules/products/spreadsheetImport";

async function main() {
  const filePath = process.argv[2];

  if (!filePath) {
    throw new Error(
      "Usage: pnpm prepare:supplier-review -- <path-to-supplier.csv|xlsx>",
    );
  }

  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Supplier spreadsheet not found: ${resolvedPath}`);
  }

  const extension = path.extname(resolvedPath).toLowerCase();
  if (![".csv", ".xlsx"].includes(extension)) {
    throw new Error(
      "This command prepares CSV/XLSX review batches only. Open PDF and image catalogues from Products > Import so they remain inside the same review flow.",
    );
  }

  const actorHint = String(process.env.PILOT_REVIEW_ADMIN || "").trim();
  const actor = actorHint
    ? await prisma.user.findFirst({
        where: {
          isActive: true,
          role: "ADMIN",
          OR: [{ id: actorHint }, { email: actorHint }, { phone: actorHint }],
        },
        select: { id: true, name: true, email: true },
      })
    : await prisma.user.findFirst({
        where: { isActive: true, role: "ADMIN" },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, email: true },
      });

  if (!actor) {
    throw new Error(
      "An active Admin is required to own the supplier review. Set PILOT_REVIEW_ADMIN to the Admin ID, email, or phone if needed.",
    );
  }

  const spreadsheet = await parseProductSpreadsheet({
    buffer: fs.readFileSync(resolvedPath),
    fileName: path.basename(resolvedPath),
    mimeType:
      extension === ".xlsx"
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : "text/csv",
  });
  const result = await createCsvImportPreview({
    fileName: path.basename(resolvedPath),
    rows: spreadsheet.rows,
    rowNumbers: spreadsheet.rowNumbers,
    sourceType: spreadsheet.sourceType,
    createdById: actor.id,
  });

  console.log(
    JSON.stringify(
      {
        reviewBatchId: result.batchId,
        owner: actor.name || actor.email || actor.id,
        sourceType: result.sourceType,
        rowsCaptured: result.totalRows,
        rowsNeedingAttention: result.errorCount,
        productsCreated: 0,
        nextStep:
          "Open Products > Import, review and save corrections, export the review sheet if needed, then use the final confirmation to import selected rows.",
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    if (error instanceof SpreadsheetImportError) {
      console.error(error.message);
    } else {
      console.error(error?.message || error);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
