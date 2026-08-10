import prisma from "../db/prisma";
import { applyReviewedSearchSynonymSeed } from "../modules/products/searchAliasService";

function readApproverReference() {
  const named = process.argv.find((argument) => argument.startsWith("--approved-by="));
  if (named) return named.slice("--approved-by=".length).trim();
  const flagIndex = process.argv.indexOf("--approved-by");
  return flagIndex >= 0 ? String(process.argv[flagIndex + 1] || "").trim() : "";
}

async function main() {
  const approverReference = readApproverReference();
  if (!approverReference) {
    throw new Error(
      "Provide the approving Admin ID or email: pnpm search:seed-aliases -- --approved-by <id-or-email>",
    );
  }

  const approver = await prisma.user.findFirst({
    where: {
      OR: [{ id: approverReference }, { email: approverReference.toLowerCase() }],
    },
    select: { id: true, name: true, email: true, role: true, isActive: true },
  });
  if (!approver || approver.role !== "ADMIN" || !approver.isActive) {
    throw new Error("The approving account must be an active Admin.");
  }

  const result = await applyReviewedSearchSynonymSeed(approver.id);
  console.log(
    `Applied ${result.appliedCount} reviewed aliases as ${approver.name} (${approver.email}); disabled ${result.disabledStaleCount} stale controlled aliases and rebuilt ${result.rebuiltCount} product search documents at normalizer version ${result.normalizerVersion}.`,
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
