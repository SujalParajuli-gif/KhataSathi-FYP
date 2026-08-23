import prisma from "../db/prisma";
import { readIdentityArguments } from "./cleanPilotBundle";
import { collectSourceCounts, resolvePilotAccounts } from "./cleanPilotSource";

async function main() {
  const references = readIdentityArguments(process.argv.slice(2));
  const [accounts, counts, settings] = await Promise.all([
    resolvePilotAccounts(references),
    collectSourceCounts(),
    prisma.businessSettings.findUnique({ where: { id: 1 } }),
  ]);
  const preservedIds = new Set(accounts.map((account) => account.id));
  const omittedUsers = await prisma.user.count({
    where: { id: { notIn: [...preservedIds] } },
  });

  console.log(
    JSON.stringify(
      {
        safeToPrepare: true,
        generatedAt: new Date().toISOString(),
        preserve: accounts.map((account) => ({
          id: account.id,
          name: account.name,
          role: account.role,
          active: account.isActive,
          hasEmail: Boolean(account.email),
          hasPhone: Boolean(account.phone),
          hasProfileImage: Boolean(account.profileImage),
        })),
        sourceCounts: counts,
        excludedFromCleanPilot: {
          userRows: omittedUsers,
          products: counts.products,
          brands: counts.brands,
          invoices: counts.invoices,
          customers: counts.customers,
          importReviews: counts.productImportBatches,
          documents: counts.documents,
          auditLogs: counts.auditLogs,
          sessions: counts.authSessions,
        },
        targetPolicy: {
          businessMode: "CATALOG_ONLY",
          staffBillingDraftRequests: false,
          oldSessionsTransferred: false,
          oldBusinessRecordsTransferred: false,
          centralSearchVocabularyApplied: true,
          supplierProductsImported: 0,
        },
        sourceMode: settings?.businessMode || "UNKNOWN",
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
