import prisma from "../../db/prisma";

export async function markAsRead(userId: string, alertKey: string) {
  return prisma.userAlertRead.upsert({
    where: { userId_alertKey: { userId, alertKey } },
    update: {},
    create: { userId, alertKey },
  });
}

export async function markAllAsRead(userId: string, alertKeys: string[]) {
  const data = alertKeys.map((key) => ({ userId, alertKey: key }));
  return prisma.userAlertRead.createMany({
    data,
    skipDuplicates: true,
  });
}

export async function getReadAlerts(userId: string) {
  const reads = await prisma.userAlertRead.findMany({
    where: { userId },
    select: { alertKey: true }
  });
  return reads.map(r => r.alertKey);
}

export async function markAsUnread(userId: string, alertKey: string) {
  return prisma.userAlertRead.deleteMany({
    where: { userId, alertKey },
  });
}
