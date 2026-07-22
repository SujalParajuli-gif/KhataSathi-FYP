import prisma from "../db/prisma";
import { isUploadFileAvailable } from "./uploads";

type ProfileImageRecord = {
  id: string;
  profileImage: string | null;
};

// Reconcile profile-image references at API boundaries. The conditional update
// prevents a late file check from clearing a newer photo uploaded concurrently.
export async function reconcileProfileImages<T extends ProfileImageRecord>(
  records: T[],
): Promise<T[]> {
  const availability = new Map<string, boolean>();
  const imageUrls = Array.from(
    new Set(
      records
        .map((record) => record.profileImage)
        .filter((url): url is string => Boolean(url)),
    ),
  );

  await Promise.all(
    imageUrls.map(async (url) => {
      availability.set(url, await isUploadFileAvailable(url));
    }),
  );

  const staleRecords = records.filter(
    (record) =>
      Boolean(record.profileImage) &&
      availability.get(record.profileImage as string) === false,
  );

  await Promise.all(
    staleRecords.map((record) =>
      prisma.user.updateMany({
        where: {
          id: record.id,
          profileImage: record.profileImage,
        },
        data: { profileImage: null },
      }),
    ),
  );

  const staleIds = new Set(staleRecords.map((record) => record.id));
  return records.map((record) =>
    staleIds.has(record.id) ? { ...record, profileImage: null } : record,
  );
}

export async function reconcileProfileImage<T extends ProfileImageRecord>(
  record: T,
): Promise<T> {
  const [reconciled] = await reconcileProfileImages([record]);
  return reconciled;
}
