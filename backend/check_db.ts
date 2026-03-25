
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function check() {
  try {
    const columns = await prisma.$queryRaw`DESCRIBE Customer`;
    console.log(JSON.stringify(columns, null, 2));
  } catch (err) {
    console.error(err);
  } finally {
    await prisma.$disconnect();
  }
}

check();
