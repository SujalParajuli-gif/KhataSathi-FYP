import fs from "node:fs/promises";
import path from "node:path";

const configuredStatusRoot = process.env.BACKUP_STATUS_ROOT?.trim();
const BACKUP_STATUS_ROOT = configuredStatusRoot
  ? path.resolve(configuredStatusRoot)
  : path.resolve(__dirname, "../../../backup-status");
const STATUS_FILE = path.join(BACKUP_STATUS_ROOT, "last-recovery-backup.json");
const MAX_STATUS_FILE_BYTES = 64 * 1024;
const RUNNING_STALE_AFTER_MS = 2 * 60 * 60 * 1000;

const SAFE_STAGES = new Set([
  "initializing",
  "repository",
  "database_dump",
  "snapshot",
  "retention",
  "complete",
]);

export type RecoveryBackupStatus = {
  available: boolean;
  status: "NEVER" | "RUNNING" | "SUCCESS" | "FAILED" | "STALE" | "UNAVAILABLE";
  stage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  snapshotId: string | null;
  appCommit: string | null;
  totalFilesProcessed: number;
  totalBytesProcessed: number;
  dataAdded: number;
  retentionApplied: boolean;
  contents: string[];
  message: string;
};

function safeDate(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeCount(value: unknown) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) return 0;
  return number;
}

export function sanitizeRecoveryBackupStatus(
  raw: unknown,
  now: Date = new Date(),
): RecoveryBackupStatus {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Recovery backup status has an invalid format.");
  }
  const data = raw as Record<string, unknown>;
  if (data.schemaVersion !== 1) {
    throw new Error("Recovery backup status version is unsupported.");
  }

  const storedStatus =
    data.status === "RUNNING" || data.status === "SUCCESS" || data.status === "FAILED"
      ? data.status
      : null;
  if (!storedStatus) throw new Error("Recovery backup status value is invalid.");

  const startedAt = safeDate(data.startedAt);
  const completedAt = safeDate(data.completedAt);
  if (!startedAt) throw new Error("Recovery backup start time is invalid.");

  const stale =
    storedStatus === "RUNNING" &&
    now.getTime() - new Date(startedAt).getTime() > RUNNING_STALE_AFTER_MS;
  const status = stale ? "STALE" : storedStatus;
  const stage =
    typeof data.stage === "string" && SAFE_STAGES.has(data.stage)
      ? data.stage
      : null;
  const snapshotId =
    typeof data.snapshotId === "string" && /^[a-f0-9]{8,64}$/i.test(data.snapshotId)
      ? data.snapshotId
      : null;
  const appCommit =
    typeof data.appCommit === "string" && /^[a-f0-9]{7,64}$/i.test(data.appCommit)
      ? data.appCommit
      : null;
  const allowedContents = new Set(["database", "uploads", "documents"]);
  const contents = Array.isArray(data.contents)
    ? Array.from(
        new Set(
          data.contents.filter(
            (item): item is string =>
              typeof item === "string" && allowedContents.has(item),
          ),
        ),
      )
    : [];

  const message =
    status === "SUCCESS"
      ? "The latest full recovery backup completed successfully."
      : status === "RUNNING"
        ? "A full recovery backup is currently running."
        : status === "STALE"
          ? "The last backup still says running and needs server review."
          : "The latest full recovery backup failed before completion.";

  return {
    available: true,
    status,
    stage,
    startedAt,
    completedAt,
    snapshotId,
    appCommit,
    totalFilesProcessed: safeCount(data.totalFilesProcessed),
    totalBytesProcessed: safeCount(data.totalBytesProcessed),
    dataAdded: safeCount(data.dataAdded),
    retentionApplied: data.retentionApplied === true,
    contents,
    message,
  };
}

export async function getRecoveryBackupStatus(): Promise<RecoveryBackupStatus> {
  try {
    const stats = await fs.lstat(STATUS_FILE);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_STATUS_FILE_BYTES) {
      throw new Error("Recovery backup status file is unsafe or too large.");
    }
    const contents = await fs.readFile(STATUS_FILE, "utf8");
    return sanitizeRecoveryBackupStatus(JSON.parse(contents));
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return {
        available: false,
        status: "NEVER",
        stage: null,
        startedAt: null,
        completedAt: null,
        snapshotId: null,
        appCommit: null,
        totalFilesProcessed: 0,
        totalBytesProcessed: 0,
        dataAdded: 0,
        retentionApplied: false,
        contents: [],
        message: "No full recovery backup has reported a result yet.",
      };
    }

    return {
      available: false,
      status: "UNAVAILABLE",
      stage: null,
      startedAt: null,
      completedAt: null,
      snapshotId: null,
      appCommit: null,
      totalFilesProcessed: 0,
      totalBytesProcessed: 0,
      dataAdded: 0,
      retentionApplied: false,
      contents: [],
      message: "The full recovery backup status could not be read safely.",
    };
  }
}
