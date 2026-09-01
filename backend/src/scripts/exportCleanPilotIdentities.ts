import prisma from "../db/prisma";
import {
  hasConfirmation,
  readIdentityArguments,
  validateCleanPilotBundle,
} from "./cleanPilotBundle";
import { createCleanPilotBundle } from "./cleanPilotSource";

async function main() {
  const args = process.argv.slice(2);
  if (!hasConfirmation(args, "EXPORT-APPROVED-PILOT-ACCOUNTS")) {
    throw new Error(
      "Identity export refused. Supply --confirmation EXPORT-APPROVED-PILOT-ACCOUNTS.",
    );
  }
  const bundle = validateCleanPilotBundle(
    await createCleanPilotBundle(readIdentityArguments(args)),
  );
  process.stdout.write(JSON.stringify(bundle));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
