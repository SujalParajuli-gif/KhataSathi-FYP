import fs from "fs/promises";
import path from "path";
import prisma from "../db/prisma";
import { resolveUploadFilePath } from "../lib/uploads";
import { applyReviewedSearchSynonymSeed } from "../modules/products/searchAliasService";
import {
  hasConfirmation,
  validateCleanPilotBundle,
} from "./cleanPilotBundle";

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function assertEmptyTarget() {
  const [users, products, invoices, documents, importReviews, auditLogs] =
    await Promise.all([
      prisma.user.count(),
      prisma.product.count(),
      prisma.invoice.count(),
      prisma.document.count(),
      prisma.productImportBatch.count(),
      prisma.auditLog.count(),
    ]);
  if ([users, products, invoices, documents, importReviews, auditLogs].some(Boolean)) {
    throw new Error(
      `Target is not clean (users=${users}, products=${products}, invoices=${invoices}, documents=${documents}, importReviews=${importReviews}, auditLogs=${auditLogs}).`,
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (!hasConfirmation(args, "IMPORT-APPROVED-PILOT-ACCOUNTS")) {
    throw new Error(
      "Identity import refused. Supply --confirmation IMPORT-APPROVED-PILOT-ACCOUNTS.",
    );
  }
  const raw = await readStdin();
  const bundle = validateCleanPilotBundle(JSON.parse(raw));
  await assertEmptyTarget();

  const writtenFiles: string[] = [];
  let databaseCommitted = false;
  try {
    for (const image of bundle.profileImages) {
      const target = resolveUploadFilePath(image.publicUrl);
      if (!target) throw new Error("A transferred profile image path is unsafe.");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, Buffer.from(image.contentBase64, "base64"), {
        flag: "wx",
      });
      writtenFiles.push(target);
    }

    const imageByUser = new Map(
      bundle.profileImages.map((image) => [image.userId, image.publicUrl]),
    );
    await prisma.$transaction(async (tx) => {
      for (const account of bundle.accounts) {
        await tx.user.create({
          data: {
            id: account.id,
            name: account.name,
            email: account.email,
            phone: account.phone,
            gender: account.gender,
            address: account.address,
            passwordHash: account.passwordHash,
            mustChangePassword: account.mustChangePassword,
            role: account.role,
            isActive: true,
            lastLogin: null,
            lastPresenceAt: null,
            profileImage: imageByUser.get(account.id) || null,
            nagariktaNo: account.nagariktaNo,
            createdAt: new Date(account.createdAt),
          },
        });
      }
      for (const privilege of bundle.cashierPrivileges) {
        await tx.cashierPrivilege.create({
          data: {
            ...privilege,
            createdAt: new Date(privilege.createdAt),
            updatedAt: new Date(privilege.updatedAt),
          },
        });
      }
      await tx.businessSettings.upsert({
        where: { id: 1 },
        create: {
          id: 1,
          ...bundle.settings,
          businessMode: "CATALOG_ONLY",
          staffDraftRequestsEnabled: false,
        },
        update: {
          ...bundle.settings,
          businessMode: "CATALOG_ONLY",
          staffDraftRequestsEnabled: false,
          overridePinHash: null,
          overridePinUpdatedAt: null,
        },
      });
      const admin = bundle.accounts.find((account) => account.role === "ADMIN")!;
      await tx.auditLog.create({
        data: {
          actorId: admin.id,
          action: "CLEAN_PILOT_IDENTITIES_IMPORTED",
          entityType: "BusinessSettings",
          entityId: "1",
          meta: {
            importedRoles: bundle.accounts.map((account) => account.role),
            sourceExportedAt: bundle.exportedAt,
            businessMode: "CATALOG_ONLY",
            oldBusinessDataImported: false,
          },
        },
      });
    });
    databaseCommitted = true;

    const admin = bundle.accounts.find((account) => account.role === "ADMIN")!;
    const vocabulary = await applyReviewedSearchSynonymSeed(admin.id);
    const [users, products, sessions, importReviews, documents, settings] =
      await Promise.all([
        prisma.user.count(),
        prisma.product.count(),
        prisma.authSession.count(),
        prisma.productImportBatch.count(),
        prisma.document.count(),
        prisma.businessSettings.findUnique({ where: { id: 1 } }),
      ]);
    console.log(
      JSON.stringify(
        {
          importedAccounts: users,
          roles: bundle.accounts.map((account) => account.role).sort(),
          profileImages: writtenFiles.length,
          products,
          sessions,
          importReviews,
          documents,
          businessMode: settings?.businessMode,
          staffDraftRequestsEnabled: settings?.staffDraftRequestsEnabled,
          controlledSearchAliases: vocabulary.appliedCount,
          readyForSupplierReview: true,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    if (!databaseCommitted) {
      await Promise.all(writtenFiles.map((file) => fs.rm(file, { force: true })));
    }
    throw error;
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
