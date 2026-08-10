import prisma from "../db/prisma";
import { tryNormalizeNepalMobilePhone } from "../lib/nepalPhone";
import { satisfiesStoredUserPhonePolicy } from "../lib/userIdentity";

async function main() {
  const includeDetails = process.argv.includes("--details");
  const users = await prisma.user.findMany({
    select: {
      id: true,
      name: true,
      role: true,
      isActive: true,
      phone: true,
      email: true,
    },
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });

  const audited = users.map((user) => {
    const normalizedPhone = tryNormalizeNepalMobilePhone(user.phone);
    const email = String(user.email || "").trim().toLowerCase();
    return {
      ...user,
      normalizedPhone,
      phoneIssue: !user.phone
        ? "MISSING"
        : !normalizedPhone
          ? "INVALID"
          : normalizedPhone !== user.phone
            ? "NORMALIZE"
            : null,
      emailIssue: !email
        ? "MISSING"
        : !/^\S+@\S+\.\S+$/.test(email)
          ? "INVALID"
          : null,
    };
  });

  const normalizedPhones = audited
    .map((user) => user.normalizedPhone)
    .filter((phone): phone is string => Boolean(phone));
  const duplicatePhones = new Set(
    normalizedPhones.filter(
      (phone, index) => normalizedPhones.indexOf(phone) !== index,
    ),
  );
  const normalizedEmails = audited
    .map((user) => String(user.email || "").trim().toLowerCase())
    .filter(Boolean);
  const duplicateEmails = new Set(
    normalizedEmails.filter(
      (email, index) => normalizedEmails.indexOf(email) !== index,
    ),
  );
  const activeUsers = audited.filter((user) => user.isActive);
  const archivedUsers = audited.filter((user) => !user.isActive);
  const countPhoneIssue = (
    records: typeof audited,
    issue: "MISSING" | "INVALID" | "NORMALIZE",
  ) => records.filter((user) => user.phoneIssue === issue).length;
  const activePhonesCanonical = activeUsers.every((user) =>
    satisfiesStoredUserPhonePolicy(user.phone, true),
  );

  console.log(
    JSON.stringify(
      {
        totalUsers: audited.length,
        activeUsers: activeUsers.length,
        archivedUsers: archivedUsers.length,
        phonePolicy: "ACTIVE_REQUIRED_ARCHIVED_HISTORY_OPTIONAL",
        missingPhones: audited.filter((user) => user.phoneIssue === "MISSING").length,
        invalidPhones: audited.filter((user) => user.phoneIssue === "INVALID").length,
        phonesNeedingNormalization: audited.filter(
          (user) => user.phoneIssue === "NORMALIZE",
        ).length,
        duplicateCanonicalPhones: duplicatePhones.size,
        missingEmails: audited.filter((user) => user.emailIssue === "MISSING").length,
        invalidEmails: audited.filter((user) => user.emailIssue === "INVALID").length,
        duplicateEmails: duplicateEmails.size,
        activePhoneIssues: {
          missing: countPhoneIssue(activeUsers, "MISSING"),
          invalid: countPhoneIssue(activeUsers, "INVALID"),
          normalize: countPhoneIssue(activeUsers, "NORMALIZE"),
        },
        archivedPhoneIssues: {
          missing: countPhoneIssue(archivedUsers, "MISSING"),
          invalid: countPhoneIssue(archivedUsers, "INVALID"),
          normalize: countPhoneIssue(archivedUsers, "NORMALIZE"),
        },
        readyForActivePhoneConstraint:
          activePhonesCanonical && duplicatePhones.size === 0,
        readyForGlobalPhoneNotNullMigration:
          audited.every(
            (user) =>
              user.normalizedPhone && user.normalizedPhone === user.phone,
          ) && duplicatePhones.size === 0,
        ...(includeDetails
          ? {
              recordsNeedingReview: audited
                .filter(
                  (user) =>
                    user.phoneIssue ||
                    user.emailIssue ||
                    (user.normalizedPhone && duplicatePhones.has(user.normalizedPhone)),
                )
                .map((user) => ({
                  id: user.id,
                  name: user.name,
                  role: user.role,
                  phoneIssue: user.phoneIssue,
                  emailIssue: user.emailIssue,
                  normalizedPhone: user.normalizedPhone,
                })),
            }
          : {}),
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error("User identity audit failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
