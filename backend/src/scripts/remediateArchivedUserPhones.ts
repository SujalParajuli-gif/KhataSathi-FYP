import prisma from "../db/prisma";
import { tryNormalizeNepalMobilePhone } from "../lib/nepalPhone";

type Remediation = {
  id: string;
  name: string;
  previousPhone: string | null;
  nextPhone: string | null;
  outcome: "NORMALIZED" | "CLEARED_INVALID";
};

async function main() {
  const apply = process.argv.includes("--apply");
  const users = await prisma.user.findMany({
    select: { id: true, name: true, role: true, isActive: true, phone: true },
    orderBy: { name: "asc" },
  });

  const activeProblems = users
    .filter((user) => user.isActive)
    .filter((user) => tryNormalizeNepalMobilePhone(user.phone) !== user.phone);
  if (activeProblems.length > 0) {
    throw new Error(
      `Active accounts require human correction before remediation: ${activeProblems
        .map((user) => user.name)
        .join(", ")}`,
    );
  }

  const remediations: Remediation[] = users
    .filter((user) => !user.isActive)
    .flatMap((user) => {
      const normalized = tryNormalizeNepalMobilePhone(user.phone);
      if (normalized === user.phone) return [];
      return [{
        id: user.id,
        name: user.name,
        previousPhone: user.phone,
        nextPhone: normalized,
        outcome: normalized ? "NORMALIZED" : "CLEARED_INVALID",
      } satisfies Remediation];
    });

  const finalPhones = users
    .map((user) => {
      const remediation = remediations.find((item) => item.id === user.id);
      return remediation ? remediation.nextPhone : user.phone;
    })
    .filter((phone): phone is string => Boolean(phone));
  const duplicate = finalPhones.find(
    (phone, index) => finalPhones.indexOf(phone) !== index,
  );
  if (duplicate) {
    throw new Error(`Remediation would create duplicate phone ${duplicate}.`);
  }

  console.log(JSON.stringify({ apply, remediations }, null, 2));
  if (!apply || remediations.length === 0) return;

  const actor = users.find((user) => user.isActive && user.role === "ADMIN");
  if (!actor) {
    throw new Error("An active Admin is required to audit archived-phone remediation.");
  }

  await prisma.$transaction(async (tx) => {
    for (const remediation of remediations) {
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          action: "ARCHIVED_USER_PHONE_REMEDIATED",
          entityType: "User",
          entityId: remediation.id,
          meta: {
            previousPhone: remediation.previousPhone,
            nextPhone: remediation.nextPhone,
            outcome: remediation.outcome,
            reason:
              "Pilot identity cleanup; archived history retained without inventing contact data.",
          },
        },
      });
      await tx.user.update({
        where: { id: remediation.id, isActive: false },
        data: { phone: remediation.nextPhone },
      });
    }
  });
}

main()
  .catch((error) => {
    console.error("Archived phone remediation failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
