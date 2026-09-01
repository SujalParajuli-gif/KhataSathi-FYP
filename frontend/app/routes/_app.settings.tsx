import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import Icon from "~/components/ui/Icon";
import ProjectSelect from "~/components/ui/ProjectSelect";
import ProjectDateInput from "~/components/ui/ProjectDateInput";
import {
  ActiveFilterChips,
  MobileFilterButton,
  MobileFilterSheet,
  MobileFilterTabs,
  type MobileFilterChip,
} from "~/components/ui/MobileFilters";
import PaginationBar from "~/components/ui/PaginationBar";
import SwipeableTabRail, { type SwipeableTabRailController } from "~/components/ui/SwipeableTabRail";
import { useHorizontalGesture } from "~/hooks/useHorizontalGesture";
import { useToast } from "~/components/ui/Toast";
import {
  ConfirmDialog,
  DialogButton,
  ModalFrame,
  SuccessDialog,
} from "~/components/ui/Modal";
import {
  addCashDrawerEventApi,
  closeCashDrawerApi,
  createBrandApi,
  getBusinessSettingsApi,
  getBusinessModePreflightApi,
  getBackupScheduleApi,
  getStorageIntegrityReportApi,
  getRecoveryBackupStatusApi,
  getCurrentCashDrawerApi,
  getOverridePolicyApi,
  listCashDrawersApi,
  listBackupHistoryApi,
  listAuditLogsApi,
  listBrandsApi,
  listCashierPrivilegesApi,
  listLoginAttemptsApi,
  listUsersApi,
  openCashDrawerApi,
  restoreBackupApi,
  triggerBackupApi,
  updateBackupScheduleApi,
  updateBusinessSettingsApi,
  updateBusinessModeApi,
  updateCashierPrivilegeApi,
  updateOverridePinApi,
  updateBrandApi,
  type BusinessSettings,
  type BusinessMode,
  type BusinessModePreflight,
  type CashierPrivilegeRow,
  type CashDrawer,
  type OverridePolicy,
  type StorageIntegrityIssue,
  type StorageIntegrityReport,
  type RecoveryBackupStatus,
} from "~/lib/api/endpoints";
import { useBusinessCapabilities } from "~/lib/businessCapabilities";
import { isRateLimitError } from "~/lib/api/client";
import { useRateLimitRecovery } from "~/lib/api/useRateLimitRecovery";
import { focusInvalidField } from "~/lib/forms/focusInvalidField";
import {
  effectiveStaffDraftRequests,
  isBusinessAccessDraftDirty,
  stageBusinessModeSelection,
} from "~/lib/settings/businessModeDraft";

type TabKey =
  | "overview"
  | "drawer"
  | "cashier-controls"
  | "brands"
  | "audit"
  | "backup";

const SETTINGS_TAB_CACHE_MS = 30_000;
type Brand = {
  id: string;
  name: string;
  active: boolean;
  productCount: number;
  activeProductCount: number;
};
type UserLite = {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  role: "ADMIN" | "MANAGER" | "CASHIER" | "STAFF";
  isActive: boolean;
  lastLogin?: string | null;
};
type AuditLogRow = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
  actor?: { name?: string | null; email?: string | null } | null;
  meta?: Record<string, unknown> | null;
};
type LoginAttemptRow = {
  id: string;
  email: string;
  success: boolean;
  ip?: string | null;
  createdAt: string;
};
type BackupResult = {
  filename?: string;
  filepath?: string;
  message?: string;
  backup?: BackupHistoryRow;
};
type BackupHistoryRow = {
  id: string;
  type: "BACKUP" | "RESTORE";
  status: "RUNNING" | "SUCCESS" | "FAILED";
  filename?: string | null;
  filepath?: string | null;
  sizeBytes?: number | null;
  message?: string | null;
  detail?: string | null;
  createdAt: string;
  completedAt?: string | null;
  createdBy?: { name?: string | null; email?: string | null } | null;
};
type BackupScheduleDraft = {
  enabled: boolean;
  frequency: "DAILY" | "WEEKLY";
  timeOfDay: string;
  dayOfWeek: number;
  lastRunAt?: string | null;
};
type SecurityDateRange = { from: string; to: string };

// this builds our default settings model in memory incase nothing is provided yet
const INITIAL_DEFAULTS = buildBusinessDefaults(5, 15, 2, 7, 8, 30);
const INITIAL_SECURITY_RANGE: SecurityDateRange = { from: "", to: "" };
const DEFAULT_ADMIN_PAGE_SIZE = 20;
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const INITIAL_BACKUP_SCHEDULE: BackupScheduleDraft = {
  enabled: false,
  frequency: "DAILY",
  timeOfDay: "02:00",
  dayOfWeek: 1,
  lastRunAt: null,
};

// we wrote this to help combine overlapping class names quickly
function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

// date formatting helpers for standardizing UI layouts
function formatDateTime(value?: string | null) {
  if (!value) return "Never";
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// this gives audit and login rows a shorter "how long ago" label for quick scanning
function formatRelativeTime(value?: string | null) {
  if (!value) return "Never";
  const diffMinutes = Math.floor(
    (Date.now() - new Date(value).getTime()) / (1000 * 60),
  );
  if (diffMinutes < 1) return "Just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

function getPresetDateRange(preset: "today" | "7d" | "30d" | "thisMonth"): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  if (preset === "today") {
    return { from: to, to };
  }
  if (preset === "7d") {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return { from: d.toISOString().slice(0, 10), to };
  }
  if (preset === "30d") {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return { from: d.toISOString().slice(0, 10), to };
  }
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  return { from: firstOfMonth.toISOString().slice(0, 10), to };
}

function formatFileSize(value?: number | null) {
  const bytes = Number(value || 0);
  if (bytes <= 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const STORAGE_OWNER_LABELS: Record<
  NonNullable<StorageIntegrityIssue["ownerType"]>,
  string
> = {
  PRODUCT_IMAGE: "Product image",
  PRODUCT_THUMBNAIL: "Product thumbnail",
  PROFILE_IMAGE: "Profile image",
  DOCUMENT_ORIGINAL: "Document original",
  DOCUMENT_THUMBNAIL: "Document thumbnail",
  PRODUCT_IMPORT_SOURCE: "Product import source",
};

function StorageIssueGroup({
  title,
  count,
  issues,
  truncated,
  tone,
  description,
}: {
  title: string;
  count: number;
  issues: StorageIntegrityIssue[];
  truncated: boolean;
  tone: "amber" | "rose";
  description: string;
}) {
  if (count === 0) return null;
  const toneClass =
    tone === "rose"
      ? "border-rose-200 bg-rose-50 text-rose-800"
      : "border-amber-200 bg-amber-50 text-amber-900";

  return (
    <details className={`group overflow-hidden rounded-[8px] border ${toneClass}`}>
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
        <span>
          <span className="block text-[13px] font-extrabold">{title}</span>
          <span className="mt-0.5 block text-[11px] font-semibold opacity-75">
            {description}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="rounded-full bg-white/80 px-2.5 py-1 text-[11px] font-extrabold">
            {count}
          </span>
          <Icon
            name="expand_more"
            sizePx={19}
            className="transition-transform group-open:rotate-180"
          />
        </span>
      </summary>
      <div className="border-t border-current/15 bg-white px-3 py-2 sm:px-4">
        {issues.map((issue, index) => (
          <div
            key={`${issue.storage}-${issue.relativePath}-${issue.ownerId || index}`}
            className="border-b border-slate-100 py-3 last:border-0"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[12px] font-extrabold text-slate-900">
                  {issue.ownerType
                    ? STORAGE_OWNER_LABELS[issue.ownerType]
                    : issue.storage === "UPLOADS"
                      ? "Upload file"
                      : "Document file"}
                </div>
                {issue.ownerLabel ? (
                  <div className="mt-0.5 break-words text-[12px] font-semibold text-slate-600">
                    {issue.ownerLabel}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-wrap gap-1.5">
                <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-extrabold text-slate-600">
                  {issue.storage === "UPLOADS" ? "Uploads" : "Documents"}
                </span>
                {issue.ownerInactive ? (
                  <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-extrabold text-slate-600">
                    Inactive owner
                  </span>
                ) : null}
                {issue.ownerDeleted ? (
                  <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-extrabold text-slate-600">
                    In Bin
                  </span>
                ) : null}
              </div>
            </div>
            <code className="mt-2 block break-all rounded-[6px] bg-slate-100 px-2.5 py-2 text-[11px] font-semibold text-slate-700">
              {issue.relativePath}
            </code>
            {issue.sizeBytes !== undefined ? (
              <div className="mt-1.5 text-[11px] font-semibold text-slate-500">
                {formatFileSize(issue.sizeBytes)}
                {issue.modifiedAt
                  ? ` · Modified ${formatDateTime(issue.modifiedAt)}`
                  : ""}
              </div>
            ) : null}
          </div>
        ))}
        {truncated ? (
          <div className="py-3 text-[11px] font-bold text-slate-500">
            Showing the first {issues.length} items. The totals above include all findings.
          </div>
        ) : null}
      </div>
    </details>
  );
}

function StorageIntegrityPanel({
  report,
  busy,
  error,
  onRun,
}: {
  report: StorageIntegrityReport | null;
  busy: boolean;
  error: string;
  onRun: () => void;
}) {
  const findings = report
    ? report.summary.missingReferences +
    report.summary.unreferencedFiles +
    report.summary.staleTempFiles
    : 0;

  return (
    <div className="rounded-[8px] border border-slate-200 bg-white p-4 shadow-sm sm:p-5 xl:col-span-2">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] bg-blue-50 text-blue-600">
            <Icon name="storage" sizePx={21} />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[17px] font-extrabold text-slate-900">
                Storage Integrity
              </h2>
              <span className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-[10px] font-extrabold uppercase text-blue-700">
                Read-only
              </span>
              {report ? (
                <span
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-[10px] font-extrabold uppercase",
                    report.status === "HEALTHY"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : report.status === "UNAVAILABLE"
                        ? "border-rose-200 bg-rose-50 text-rose-700"
                        : "border-amber-200 bg-amber-50 text-amber-800",
                  )}
                >
                  {report.status === "HEALTHY"
                    ? "Healthy"
                    : report.status === "UNAVAILABLE"
                      ? "Check incomplete"
                      : `${findings} finding${findings === 1 ? "" : "s"}`}
                </span>
              ) : null}
            </div>
            <p className="mt-1 max-w-3xl text-[12px] font-medium leading-5 text-slate-500">
              Compare database records with product images, profile photos, and protected documents on disk. This check never deletes, moves, renames, or restores files.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onRun}
          disabled={busy}
          className="inline-flex h-11 w-full shrink-0 items-center justify-center gap-2 rounded-[8px] bg-slate-950 px-4 text-[12px] font-extrabold text-white transition hover:bg-slate-800 disabled:cursor-wait disabled:opacity-60 sm:w-auto"
        >
          <Icon name={busy ? "progress_activity" : "fact_check"} sizePx={18} className={busy ? "animate-spin" : ""} />
          {busy ? "Checking storage..." : report ? "Run check again" : "Run storage check"}
        </button>
      </div>

      {error ? (
        <div className="mt-4 rounded-[8px] border border-rose-200 bg-rose-50 px-4 py-3 text-[12px] font-bold text-rose-700">
          {error}
        </div>
      ) : null}

      {!report && !error ? (
        <div className="mt-4 rounded-[8px] border border-slate-200 bg-slate-50 px-4 py-3 text-[12px] font-semibold text-slate-600">
          Run this after imports, migrations, restores, or manual file transfers. It is intentionally manual so normal Settings visits stay fast.
        </div>
      ) : null}

      {report ? (
        <div className="mt-5 space-y-4">
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            {[
              ["Tracked references", report.summary.databaseReferences],
              ["Files on disk", report.summary.filesOnDisk],
              ["Missing files", report.summary.missingReferences],
              ["Review candidates", report.summary.unreferencedFiles + report.summary.staleTempFiles],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-[8px] border border-slate-200 bg-slate-50 p-3.5">
                <div className="text-[10px] font-extrabold uppercase tracking-[0.06em] text-slate-500">
                  {label}
                </div>
                <div className="mt-1 text-[22px] font-black text-slate-950">{value}</div>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-2 rounded-[8px] border border-slate-200 bg-slate-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-bold text-slate-600">
              {report.roots.map((root) => (
                <span key={root.storage} className={root.accessible ? "text-slate-600" : "text-rose-700"}>
                  {root.storage === "UPLOADS" ? "Uploads" : "Documents"}: {root.accessible ? `${root.filesOnDisk} files · ${formatFileSize(root.bytesOnDisk)}` : root.error}
                </span>
              ))}
            </div>
            <span className="shrink-0 text-[11px] font-semibold text-slate-500">
              Checked {formatDateTime(report.generatedAt)}
            </span>
          </div>

          {report.status === "HEALTHY" ? (
            <div className="flex items-start gap-3 rounded-[8px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-800">
              <Icon name="check_circle" sizePx={20} className="mt-0.5 shrink-0" />
              <div>
                <div className="text-[13px] font-extrabold">Storage references are healthy</div>
                <div className="mt-0.5 text-[11px] font-semibold opacity-80">Every tracked file was found and no unreferenced or stale temporary files were detected.</div>
              </div>
            </div>
          ) : null}

          {report.status !== "HEALTHY" ? (
            <div className="space-y-2.5">
              <StorageIssueGroup
                title="Missing referenced files"
                count={report.summary.missingReferences}
                issues={report.issues.missingReferences}
                truncated={report.limits.missingReferencesTruncated}
                tone="rose"
                description="The database expects these files, but they were not found on readable storage."
              />
              <StorageIssueGroup
                title="Unreferenced files"
                count={report.summary.unreferencedFiles}
                issues={report.issues.unreferencedFiles}
                truncated={report.limits.unreferencedFilesTruncated}
                tone="amber"
                description="These files are not linked by current database records. Review them before any future cleanup."
              />
              <StorageIssueGroup
                title="Stale temporary files"
                count={report.summary.staleTempFiles}
                issues={report.issues.staleTempFiles}
                truncated={report.limits.staleTempFilesTruncated}
                tone="amber"
                description={`Temporary document files older than ${report.limits.staleTempHours} hours.`}
              />
              {(report.summary.unreferencedFiles > 0 || report.summary.staleTempFiles > 0) ? (
                <div className="text-[11px] font-semibold leading-5 text-slate-500">
                  A review candidate is not automatically safe to delete. This screen intentionally provides no cleanup button.
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RecoveryBackupPanel({
  status,
  busy,
  onRefresh,
}: {
  status: RecoveryBackupStatus | null;
  busy: boolean;
  onRefresh: () => void;
}) {
  const successful = status?.status === "SUCCESS";
  const running = status?.status === "RUNNING";
  const needsAttention =
    status?.status === "FAILED" ||
    status?.status === "STALE" ||
    status?.status === "UNAVAILABLE";
  const badgeClass = successful
    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
    : running
      ? "border-blue-200 bg-blue-50 text-blue-700"
      : needsAttention
        ? "border-rose-200 bg-rose-50 text-rose-700"
        : "border-slate-200 bg-slate-100 text-slate-600";
  const badgeLabel = status
    ? status.status === "NEVER"
      ? "Not run yet"
      : status.status === "STALE"
        ? "Server review needed"
        : status.status.toLowerCase().replace(/^./, (letter) => letter.toUpperCase())
    : "Loading";

  return (
    <div className="overflow-hidden rounded-[8px] border border-slate-200 bg-white shadow-sm xl:col-span-2">
      <div className="flex flex-col gap-4 border-b border-slate-200 p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] bg-emerald-50 text-emerald-600">
            <Icon name="encrypted" sizePx={21} />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[17px] font-extrabold text-slate-900">
                Full Recovery Backup
              </h2>
              <span className={`rounded-full border px-2.5 py-1 text-[10px] font-extrabold uppercase ${badgeClass}`}>
                {badgeLabel}
              </span>
            </div>
            <p className="mt-1 max-w-3xl text-[12px] font-medium leading-5 text-slate-500">
              Deduplicated and encrypted Restic snapshot of MySQL, product/profile uploads, and protected documents. It runs from the isolated VPS recovery service, not from the browser.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={busy}
          className="inline-flex h-10 w-full shrink-0 items-center justify-center gap-2 rounded-[8px] border border-slate-300 bg-white px-4 text-[12px] font-extrabold text-slate-800 transition hover:bg-slate-100 disabled:opacity-60 sm:w-auto"
        >
          <Icon name="refresh" sizePx={17} className={busy ? "animate-spin" : ""} />
          Refresh status
        </button>
      </div>

      <div className="grid gap-4 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div>
          <div className="flex flex-wrap gap-2">
            {["Database", "Uploads", "Documents"].map((item) => (
              <span key={item} className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-[11px] font-extrabold text-slate-700">
                <Icon name="check_circle" sizePx={14} className="text-emerald-600" />
                {item}
              </span>
            ))}
          </div>
          <div className={cn(
            "mt-3 rounded-[8px] border px-4 py-3 text-[12px] font-semibold leading-5",
            successful
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : needsAttention
                ? "border-rose-200 bg-rose-50 text-rose-700"
                : "border-slate-200 bg-slate-50 text-slate-600",
          )}>
            {status?.message || "Reading the latest recovery backup status..."}
          </div>
          {status?.status === "SUCCESS" && !status.retentionApplied ? (
            <div className="mt-2 text-[11px] font-bold text-amber-700">
              The snapshot succeeded, but retention cleanup needs server review.
            </div>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-slate-200 pt-4 lg:min-w-[370px] lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
          <div>
            <div className="text-[10px] font-extrabold uppercase tracking-[0.06em] text-slate-500">Last completed</div>
            <div className="mt-1 text-[12px] font-extrabold text-slate-900">
              {formatDateTime(status?.completedAt)}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-extrabold uppercase tracking-[0.06em] text-slate-500">Snapshot</div>
            <div className="mt-1 font-mono text-[12px] font-extrabold text-slate-900">
              {status?.snapshotId ? status.snapshotId.slice(0, 12) : "-"}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-extrabold uppercase tracking-[0.06em] text-slate-500">Protected data</div>
            <div className="mt-1 text-[12px] font-extrabold text-slate-900">
              {formatFileSize(status?.totalBytesProcessed)}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-extrabold uppercase tracking-[0.06em] text-slate-500">Added this run</div>
            <div className="mt-1 text-[12px] font-extrabold text-slate-900">
              {formatFileSize(status?.dataAdded)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatNpr(value: number) {
  return `NPR ${Number(value || 0).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })}`;
}

function normalizeBackupSchedule(raw: any): BackupScheduleDraft {
  return {
    enabled: raw?.enabled === true,
    frequency: raw?.frequency === "WEEKLY" ? "WEEKLY" : "DAILY",
    timeOfDay:
      typeof raw?.timeOfDay === "string" && /^\d{2}:\d{2}$/.test(raw.timeOfDay)
        ? raw.timeOfDay
        : "02:00",
    dayOfWeek: Math.max(0, Math.min(6, Number(raw?.dayOfWeek ?? 1))),
    lastRunAt: raw?.lastRunAt || null,
  };
}

// settings percentages should always stay inside 0 to 100 so billing math stays valid
function clampPercent(v: number) {
  return Math.max(0, Math.min(100, v));
}

// this normalizes the business defaults into the exact shape used by the settings form
function buildBusinessDefaults(
  defaultLowStock: number,
  wholesaleQtyThreshold: number,
  loyaltyDiscountPercent: number,
  returnWindowDays: number,
  parkedBillExpiryHours: number,
  draftRequestExpiryMinutes: number,
  defaultInitialStock = 30,
) {
  return {
    defaultInitialStock: Math.max(0, defaultInitialStock),
    defaultLowStock: Math.max(0, defaultLowStock),
    wholesaleQtyThreshold: Math.max(1, wholesaleQtyThreshold),
    loyaltyDiscountPercent: clampPercent(loyaltyDiscountPercent),
    returnWindowDays: Math.max(0, Math.floor(returnWindowDays)),
    parkedBillExpiryHours: Math.max(1, Math.floor(parkedBillExpiryHours)),
    draftRequestExpiryMinutes: Math.max(
      1,
      Math.floor(draftRequestExpiryMinutes),
    ),
  };
}

type BusinessDefaults = ReturnType<typeof buildBusinessDefaults>;
type BusinessDefaultsDraft = Record<keyof BusinessDefaults, string>;
type BusinessDefaultsErrors = Partial<Record<keyof BusinessDefaults, string>>;

function defaultsToDraft(defaults: BusinessDefaults): BusinessDefaultsDraft {
  return Object.fromEntries(
    Object.entries(defaults).map(([key, value]) => [key, String(value)]),
  ) as BusinessDefaultsDraft;
}

function validateBusinessDefaultsDraft(draft: BusinessDefaultsDraft) {
  const errors: BusinessDefaultsErrors = {};
  const rules: Array<{
    key: keyof BusinessDefaults;
    label: string;
    min: number;
    max?: number;
    integer?: boolean;
  }> = [
      { key: "defaultInitialStock", label: "New product initial stock", min: 0 },
      { key: "defaultLowStock", label: "Stock alert threshold", min: 0 },
      { key: "wholesaleQtyThreshold", label: "Wholesale quantity threshold", min: 1 },
      { key: "loyaltyDiscountPercent", label: "Loyalty discount", min: 0, max: 100 },
      { key: "returnWindowDays", label: "Return window", min: 0, integer: true },
      { key: "parkedBillExpiryHours", label: "Parked bill expiry", min: 1, integer: true },
      { key: "draftRequestExpiryMinutes", label: "Draft request expiry", min: 1, integer: true },
    ];

  for (const rule of rules) {
    const raw = draft[rule.key].trim();
    const value = Number(raw);
    if (!raw || !Number.isFinite(value)) {
      errors[rule.key] = `${rule.label} requires a valid number.`;
    } else if (value < rule.min || (rule.max !== undefined && value > rule.max)) {
      errors[rule.key] = rule.max === undefined
        ? `${rule.label} must be at least ${rule.min}.`
        : `${rule.label} must be between ${rule.min} and ${rule.max}.`;
    } else if (rule.integer && !Number.isInteger(value)) {
      errors[rule.key] = `${rule.label} must be a whole number.`;
    }
  }
  return errors;
}

function parseBusinessDefaultsDraft(draft: BusinessDefaultsDraft): BusinessDefaults {
  return {
    defaultInitialStock: Number(draft.defaultInitialStock),
    defaultLowStock: Number(draft.defaultLowStock),
    wholesaleQtyThreshold: Number(draft.wholesaleQtyThreshold),
    loyaltyDiscountPercent: Number(draft.loyaltyDiscountPercent),
    returnWindowDays: Number(draft.returnWindowDays),
    parkedBillExpiryHours: Number(draft.parkedBillExpiryHours),
    draftRequestExpiryMinutes: Number(draft.draftRequestExpiryMinutes),
  };
}

function formatBusinessMode(mode: BusinessMode) {
  if (mode === "CATALOG_ONLY") return "Catalog only";
  if (mode === "INVENTORY_ONLY") return "Catalog + inventory";
  return "Full POS";
}

function SettingsToggleSwitch({
  checked,
  onChange,
  disabled = false,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-[26px] w-[46px] min-h-[26px] min-w-[46px] shrink-0 cursor-pointer items-center rounded-full border p-0 transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-45",
        checked
          ? "border-slate-950 bg-slate-950"
          : "border-slate-300 bg-slate-200",
      )}
    >
      <span
        className={cn(
          "pointer-events-none absolute left-[3px] top-1/2 h-[20px] w-[20px] min-h-[20px] min-w-[20px] -translate-y-1/2 rounded-full bg-white shadow-sm transition-transform duration-150 ease-out",
          checked ? "translate-x-[20px]" : "translate-x-0",
        )}
      />
    </button>
  );
}

function BusinessNumberField({
  fieldKey,
  label,
  helper,
  value,
  onChange,
  disabled = false,
  error,
  suffix,
  integer = false,
}: {
  fieldKey: keyof BusinessDefaults;
  label: string;
  helper: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  error?: string;
  suffix?: string;
  integer?: boolean;
}) {
  return (
    <label className="block">
      <div className="flex items-center justify-between gap-2">
        <span className={cn("text-[13px] font-extrabold", disabled ? "text-[#8C8889]" : "text-[#11120D]")}>
          {label}
        </span>
      </div>
      <div className="relative mt-1.5">
        <input
          data-business-default={fieldKey}
          data-business-default-error={error ? "true" : undefined}
          type="number"
          step={integer ? 1 : "any"}
          value={value}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          aria-describedby={`${fieldKey}-help${error ? ` ${fieldKey}-error` : ""}`}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => onChange(event.target.value)}
          className={cn(
            "h-10 w-full rounded-[10px] border px-3 text-[13px] font-semibold text-[#11120D] outline-none transition",
            suffix ? "pr-16" : "",
            disabled
              ? "cursor-not-allowed border-[#E5E7EB] bg-[#F8FAFC] text-[#8C8889]"
              : error
                ? "border-rose-400 bg-white focus:border-rose-600 focus:ring-2 focus:ring-rose-100"
                : "border-[#D4D7DC] bg-white focus:border-[#11120D]",
          )}
        />
        {suffix ? (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-[6px] bg-[#F1F3F5] px-2 py-0.5 text-[11px] font-extrabold text-[#64748B]">
            {suffix}
          </span>
        ) : null}
      </div>
      <span id={`${fieldKey}-help`} className="mt-1.5 block text-[11.5px] font-medium leading-4 text-[#64748B]">
        {helper}
      </span>
      {error ? (
        <span id={`${fieldKey}-error`} className="mt-1 block text-[11.5px] font-bold text-rose-700" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

// this renders the small state badges used for saved/unsaved status and row conditions
function Pill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
}) {
  const tones = {
    neutral: "bg-slate-100 text-slate-600 border-slate-200",
    success: "bg-emerald-50 text-emerald-700 border-emerald-200",
    warning: "bg-orange-50 text-orange-700 border-orange-200",
    danger: "bg-rose-50 text-rose-700 border-rose-200",
    info: "bg-blue-50 text-blue-700 border-blue-200",
  };
  return (
    <span
      className={cn(
        "inline-flex rounded-full border px-2.5 py-1 text-[11px] font-extrabold",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

function SwitchControl({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-[32px] w-[60px] shrink-0 items-center rounded-full border transition focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2",
        checked
          ? "border-blue-600 bg-blue-600"
          : "border-slate-300 bg-slate-200",
      )}
    >
      <span
        className={cn(
          "absolute left-[3px] h-[26px] w-[26px] rounded-full bg-white shadow-sm transition",
          checked && "translate-x-[28px]",
        )}
      />
    </button>
  );
}

// keeping pagination inside valid limits prevents the security lists from landing on empty pages
function clampPage(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

// the main settings workspace
// this handles updating business rules (defaults), managing brand lists, reviewing application audit logs, and running database backups
export default function SettingsPage() {
  const capabilities = useBusinessCapabilities();
  const { showToast } = useToast();
  const [tab, setTab] = useState<TabKey>("overview"); // active settings section tab
  const settingsTabRailRef = useRef<SwipeableTabRailController | null>(null);
  const [rateLimitRecoveryKey, setRateLimitRecoveryKey] = useState(0);
  const settingsTabLoadedAtRef = useRef(new Map<TabKey, number>());
  const securityQueryLoadedAtRef = useRef(new Map<string, number>());
  const requestRateLimitRecovery = useRateLimitRecovery(() => {
    setRateLimitRecoveryKey((current) => current + 1);
  });
  const [loading, setLoading] = useState(true); // tracks whether the initial data fetch is still running
  const [modeDraft, setModeDraft] = useState<BusinessMode>(
    capabilities.businessMode,
  );
  const [staffDraftsDraft, setStaffDraftsDraft] = useState(
    capabilities.staffDraftRequestsEnabled,
  );
  const [modeReason, setModeReason] = useState("");
  const [modePreflight, setModePreflight] =
    useState<BusinessModePreflight | null>(null);
  const [modeError, setModeError] = useState("");
  const [modeBusy, setModeBusy] = useState(false);
  const [showModeConfirm, setShowModeConfirm] = useState(false);
  const [refreshing, setRefreshing] = useState(false); // lighter refresh state used after saves without showing the full page loader
  const [brands, setBrands] = useState<Brand[]>([]); // brand records shown in brand management
  const [users, setUsers] = useState<UserLite[]>([]); // lightweight staff list used for overview counts
  const [cashierPrivileges, setCashierPrivileges] = useState<
    CashierPrivilegeRow[]
  >([]);
  const [userManagementPage, setUserManagementPage] = useState(1);
  const [userManagementPageSize, setUserManagementPageSize] = useState(10);
  const [savingCashierPrivilegeId, setSavingCashierPrivilegeId] = useState<
    string | null
  >(null);
  const [overridePolicy, setOverridePolicy] = useState<OverridePolicy>({
    pinConfigured: false,
    pinUpdatedAt: null,
  });
  const [overridePinDraft, setOverridePinDraft] = useState("");
  const [savingOverridePin, setSavingOverridePin] = useState(false);
  const [overridePinError, setOverridePinError] = useState("");
  const [showOverridePinConfirm, setShowOverridePinConfirm] = useState(false);
  const [auditLogs, setAuditLogs] = useState<AuditLogRow[]>([]); // recent audit log rows
  const [loginAttempts, setLoginAttempts] = useState<LoginAttemptRow[]>([]); // recent login attempts for security review
  const [securityDateDraft, setSecurityDateDraft] = useState<SecurityDateRange>(
    INITIAL_SECURITY_RANGE,
  ); // editable date inputs for the audit tab before the user applies them
  const [securityDateFilter, setSecurityDateFilter] =
    useState<SecurityDateRange>(INITIAL_SECURITY_RANGE); // the active date range sent to both audit endpoints
  const [securityAuditActionDraft, setSecurityAuditActionDraft] = useState("");
  const [securityAuditActionFilter, setSecurityAuditActionFilter] =
    useState("");
  const [securityEntityDraft, setSecurityEntityDraft] = useState("");
  const [securityEntityFilter, setSecurityEntityFilter] = useState("");
  const [securityLoginEmailDraft, setSecurityLoginEmailDraft] = useState("");
  const [securityLoginEmailFilter, setSecurityLoginEmailFilter] = useState("");
  const [securityLoginStatusDraft, setSecurityLoginStatusDraft] = useState<
    "ALL" | "SUCCESS" | "FAILED"
  >("ALL");
  const [securityLoginStatusFilter, setSecurityLoginStatusFilter] = useState<
    "ALL" | "SUCCESS" | "FAILED"
  >("ALL");
  const [securityFilterError, setSecurityFilterError] = useState(""); // validation message when the chosen date range is invalid
  const [mobileSecurityFiltersOpen, setMobileSecurityFiltersOpen] =
    useState(false);
  const [securityLoading, setSecurityLoading] = useState(false); // lighter loading state for the audit tab lists
  const [auditPage, setAuditPage] = useState(1); // current page inside the audit logs list
  const [loginPage, setLoginPage] = useState(1); // current page inside the login attempts list
  const [auditPageSize, setAuditPageSize] = useState(DEFAULT_ADMIN_PAGE_SIZE);
  const [loginPageSize, setLoginPageSize] = useState(DEFAULT_ADMIN_PAGE_SIZE);
  const [auditTotal, setAuditTotal] = useState(0); // total audit rows matching the current date filter
  const [loginTotal, setLoginTotal] = useState(0); // total login attempt rows matching the current date filter
  const [failedLoginCount, setFailedLoginCount] = useState(0); // total failed login attempts for the current date range
  const [brandQuery, setBrandQuery] = useState(""); // text search for the brands tab
  const [brandSelection, setBrandSelection] = useState("all"); // selected brand row from the dropdown filter inside brand management
  const [brandFilter, setBrandFilter] = useState<"all" | "active" | "inactive">(
    "all",
  );
  const [brandPage, setBrandPage] = useState(1); // current page inside the brand management table
  const [brandPageSize, setBrandPageSize] = useState(DEFAULT_ADMIN_PAGE_SIZE);
  const [backupBusy, setBackupBusy] = useState(false); // blocks repeated backup triggers
  const [backupResult, setBackupResult] = useState<BackupResult | null>(null); // raw backup result returned by the backend
  const [backupHistory, setBackupHistory] = useState<BackupHistoryRow[]>([]);
  const [backupSchedule, setBackupSchedule] = useState<BackupScheduleDraft>(
    INITIAL_BACKUP_SCHEDULE,
  );
  const [backupScheduleDraft, setBackupScheduleDraft] =
    useState<BackupScheduleDraft>(INITIAL_BACKUP_SCHEDULE);
  const [backupScheduleBusy, setBackupScheduleBusy] = useState(false);
  const [backupScheduleError, setBackupScheduleError] = useState("");
  const [storageIntegrityReport, setStorageIntegrityReport] =
    useState<StorageIntegrityReport | null>(null);
  const [storageIntegrityBusy, setStorageIntegrityBusy] = useState(false);
  const [storageIntegrityError, setStorageIntegrityError] = useState("");
  const [recoveryBackupStatus, setRecoveryBackupStatus] =
    useState<RecoveryBackupStatus | null>(null);
  const [recoveryBackupStatusBusy, setRecoveryBackupStatusBusy] =
    useState(false);
  const [showBackupScheduleConfirm, setShowBackupScheduleConfirm] =
    useState(false);
  const [restoreTarget, setRestoreTarget] = useState<BackupHistoryRow | null>(
    null,
  );
  const [restoreConfirmation, setRestoreConfirmation] = useState("");
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState("");
  const [showBackupConfirm, setShowBackupConfirm] = useState(false); // confirmation dialog before backup
  const [showBackupSuccess, setShowBackupSuccess] = useState(false); // success dialog after backup completes
  const [showBrandForm, setShowBrandForm] = useState(false); // add/edit brand modal toggle
  const [editingBrand, setEditingBrand] = useState<Brand | null>(null); // current brand being edited, or null for add mode
  const [brandName, setBrandName] = useState(""); // brand form name field
  const [brandActive, setBrandActive] = useState(true); // brand form active state field
  const [brandError, setBrandError] = useState(""); // brand mutation error
  const [pendingBrandDeactivation, setPendingBrandDeactivation] =
    useState<Brand | null>(null);
  const [pendingBrandSave, setPendingBrandSave] = useState(false); // tells the confirm dialog whether it is finishing a save flow or a direct toggle flow
  const [defaultLowStock, setDefaultLowStock] = useState(
    String(INITIAL_DEFAULTS.defaultLowStock),
  );
  const [defaultInitialStock, setDefaultInitialStock] = useState(
    String(INITIAL_DEFAULTS.defaultInitialStock),
  );
  const [wholesaleQtyThreshold, setWholesaleQtyThreshold] = useState(
    String(INITIAL_DEFAULTS.wholesaleQtyThreshold),
  );
  const [loyaltyDiscountPercent, setLoyaltyDiscountPercent] = useState(
    String(INITIAL_DEFAULTS.loyaltyDiscountPercent),
  );
  const [returnWindowDays, setReturnWindowDays] = useState(
    String(INITIAL_DEFAULTS.returnWindowDays),
  );
  const [parkedBillExpiryHours, setParkedBillExpiryHours] = useState(
    String(INITIAL_DEFAULTS.parkedBillExpiryHours),
  );
  const [draftRequestExpiryMinutes, setDraftRequestExpiryMinutes] = useState(
    String(INITIAL_DEFAULTS.draftRequestExpiryMinutes),
  );
  const [savedDefaults, setSavedDefaults] = useState(INITIAL_DEFAULTS); // snapshot of the last saved business defaults
  const [showDefaultsConfirm, setShowDefaultsConfirm] = useState(false); // confirmation dialog before saving business defaults
  const [defaultsShowErrors, setDefaultsShowErrors] = useState(false);
  const [defaultsBusy, setDefaultsBusy] = useState(false);
  const [defaultsSaveError, setDefaultsSaveError] = useState("");
  const [currentDrawer, setCurrentDrawer] = useState<CashDrawer | null>(null);
  const [drawerHistory, setDrawerHistory] = useState<CashDrawer[]>([]);
  const [drawerBusy, setDrawerBusy] = useState(false);
  const [drawerError, setDrawerError] = useState("");
  const [drawerOpeningFloat, setDrawerOpeningFloat] = useState("1000");
  const [drawerAmount, setDrawerAmount] = useState("");
  const [drawerActualTotal, setDrawerActualTotal] = useState("");
  const [drawerNote, setDrawerNote] = useState("");
  const [drawerHistoryExpanded, setDrawerHistoryExpanded] = useState(false);
  const [drawerAction, setDrawerAction] = useState<
    "open" | "cash-in" | "cash-out" | "close" | null
  >(null);
  const [editingCashier, setEditingCashier] =
    useState<CashierPrivilegeRow | null>(null);
  const [cashierPrivilegeDraft, setCashierPrivilegeDraft] = useState<
    CashierPrivilegeRow["privilege"] | null
  >(null);
  const [showCashierSaveConfirm, setShowCashierSaveConfirm] = useState(false);
  const [securitySubTab, setSecuritySubTab] = useState<"audit" | "login">("audit");

  // the security lists share one date range filter, so these helpers keep both API payloads consistent
  function buildSecurityDateParams() {
    return {
      ...(securityDateFilter.from ? { from: securityDateFilter.from } : {}),
      ...(securityDateFilter.to ? { to: securityDateFilter.to } : {}),
    };
  }

  function securityQueryKey() {
    return [
      securityDateFilter.from,
      securityDateFilter.to,
      securityAuditActionFilter,
      securityEntityFilter,
      securityLoginEmailFilter,
      securityLoginStatusFilter,
      auditPage,
      auditPageSize,
      loginPage,
      loginPageSize,
    ].join("|");
  }

  async function loadSecurityData() {
    setSecurityLoading(true);
    const queryKey = securityQueryKey();

    try {
      const dateParams = buildSecurityDateParams();
      const [auditData, loginData, failedData] = await Promise.allSettled([
        listAuditLogsApi({
          ...dateParams,
          ...(securityAuditActionFilter
            ? { action: securityAuditActionFilter }
            : {}),
          ...(securityEntityFilter ? { entityType: securityEntityFilter } : {}),
          page: auditPage,
          pageSize: auditPageSize,
        }),
        listLoginAttemptsApi({
          ...dateParams,
          ...(securityLoginEmailFilter
            ? { email: securityLoginEmailFilter }
            : {}),
          ...(securityLoginStatusFilter !== "ALL"
            ? { success: securityLoginStatusFilter === "SUCCESS" }
            : {}),
          page: loginPage,
          pageSize: loginPageSize,
        }),
        listLoginAttemptsApi({
          ...dateParams,
          success: false,
          page: 1,
          pageSize: 1,
        }),
      ]);

      if (auditData.status === "fulfilled") {
        setAuditLogs(
          Array.isArray(auditData.value?.logs) ? auditData.value.logs : [],
        );
        setAuditTotal(Number(auditData.value?.total ?? 0));
      }

      if (loginData.status === "fulfilled") {
        setLoginAttempts(
          Array.isArray(loginData.value?.attempts)
            ? loginData.value.attempts
            : [],
        );
        setLoginTotal(Number(loginData.value?.total ?? 0));
      }

      if (failedData.status === "fulfilled") {
        setFailedLoginCount(Number(failedData.value?.total ?? 0));
      }

      const results = [auditData, loginData, failedData];
      const hasFailure = results.some((result) => result.status === "rejected");
      if (
        results.some(
          (result) =>
            result.status === "rejected" && isRateLimitError(result.reason),
        )
      ) {
        requestRateLimitRecovery();
      }
      if (hasFailure) securityQueryLoadedAtRef.current.delete(queryKey);
      else securityQueryLoadedAtRef.current.set(queryKey, Date.now());
      return !hasFailure;
    } finally {
      setSecurityLoading(false);
    }
  }

  async function refreshSettingsData() {
    if (tab === "audit") {
      await loadSecurityData();
      return;
    }
    await loadData(false, tab);
  }

  // Each settings tab loads only the data it owns. This keeps the initial
  // Business Rules screen light and prevents hidden tabs from spending the
  // request budget before the admin opens them.
  async function loadData(showLoader = true, targetTab: TabKey = tab) {
    if (showLoader) setLoading(true);
    else setRefreshing(true);
    const needsBrands = targetTab === "brands";
    const needsUsers = targetTab === "cashier-controls";
    const needsBusinessRules = targetTab === "overview";
    const needsBackup = targetTab === "backup";
    const needsDrawer = targetTab === "drawer";

    try {
      const [
        brandData,
        userData,
        settingsData,
        backupData,
        scheduleData,
        recoveryStatusData,
        currentDrawerData,
        drawerHistoryData,
        cashierPrivilegeData,
        overridePolicyData,
      ] = await Promise.allSettled([
        needsBrands ? listBrandsApi() : Promise.resolve(null),
        needsUsers ? listUsersApi() : Promise.resolve(null),
        needsBusinessRules ? getBusinessSettingsApi() : Promise.resolve(null),
        needsBackup ? listBackupHistoryApi() : Promise.resolve(null),
        needsBackup ? getBackupScheduleApi() : Promise.resolve(null),
        needsBackup ? getRecoveryBackupStatusApi() : Promise.resolve(null),
        needsDrawer ? getCurrentCashDrawerApi() : Promise.resolve(null),
        needsDrawer ? listCashDrawersApi() : Promise.resolve(null),
        needsUsers ? listCashierPrivilegesApi() : Promise.resolve(null),
        needsUsers ? getOverridePolicyApi() : Promise.resolve(null),
      ]);

      if (needsBrands && brandData.status === "fulfilled") {
        // mapping brands into a compact shape keeps the UI layer simple
        const raw = Array.isArray(brandData.value) ? brandData.value : [];
        setBrands(
          raw.map((brand: any) => ({
            id: brand.id,
            name: brand.name || "Unknown",
            active: brand.isActive !== false,
            productCount: Number(brand.productCount || 0),
            activeProductCount: Number(brand.activeProductCount || 0),
          })),
        );
      }
      if (needsUsers && userData.status === "fulfilled") {
        // same idea for users: only keeping the fields required by overview and audit cards
        const raw = Array.isArray(userData.value) ? userData.value : [];
        setUsers(
          raw.map((user: any) => ({
            id: user.id,
            name: user.name || "Unknown",
            email: user.email || "",
            phone: user.phone || null,
            role: user.role || "CASHIER",
            isActive: user.isActive !== false,
            lastLogin: user.lastLogin || null,
          })),
        );
      }
      if (
        needsUsers &&
        cashierPrivilegeData.status === "fulfilled" &&
        cashierPrivilegeData.value
      ) {
        setCashierPrivileges(
          Array.isArray(cashierPrivilegeData.value.cashiers)
            ? cashierPrivilegeData.value.cashiers
            : [],
        );
      }
      if (
        needsUsers &&
        overridePolicyData.status === "fulfilled" &&
        overridePolicyData.value
      ) {
        setOverridePolicy(overridePolicyData.value);
      }
      if (needsBusinessRules && settingsData.status === "fulfilled") {
        // normalizing defaults here keeps all number fields safe even if the backend returns strings or missing values
        const normalizedSettings = buildBusinessDefaults(
          Number(settingsData.value?.defaultLowStockThreshold ?? 5),
          Number(settingsData.value?.defaultWholesaleQtyThreshold ?? 15),
          Number(settingsData.value?.loyaltyDiscountPercent ?? 2),
          Number(settingsData.value?.returnWindowDays ?? 7),
          Number(settingsData.value?.parkedBillExpiryHours ?? 8),
          Number(settingsData.value?.draftRequestExpiryMinutes ?? 30),
          Number(settingsData.value?.defaultInitialStock ?? 30),
        );
        const defaultsDraft = defaultsToDraft(normalizedSettings);
        setDefaultInitialStock(defaultsDraft.defaultInitialStock);
        setDefaultLowStock(defaultsDraft.defaultLowStock);
        setWholesaleQtyThreshold(defaultsDraft.wholesaleQtyThreshold);
        setLoyaltyDiscountPercent(defaultsDraft.loyaltyDiscountPercent);
        setReturnWindowDays(defaultsDraft.returnWindowDays);
        setParkedBillExpiryHours(defaultsDraft.parkedBillExpiryHours);
        setDraftRequestExpiryMinutes(
          defaultsDraft.draftRequestExpiryMinutes,
        );
        setSavedDefaults(normalizedSettings);
        if (settingsData.value?.businessMode) {
          setModeDraft(settingsData.value.businessMode);
        }
        setStaffDraftsDraft(
          settingsData.value?.businessMode === "FULL_POS" &&
          settingsData.value?.staffDraftRequestsEnabled === true,
        );
      }
      if (
        needsDrawer &&
        currentDrawerData.status === "fulfilled" &&
        currentDrawerData.value
      ) {
        setCurrentDrawer(currentDrawerData.value.drawer || null);
      }
      if (
        needsDrawer &&
        drawerHistoryData.status === "fulfilled" &&
        drawerHistoryData.value
      ) {
        setDrawerHistory(
          Array.isArray(drawerHistoryData.value.drawers)
            ? drawerHistoryData.value.drawers
            : [],
        );
      }
      if (needsBackup && backupData.status === "fulfilled") {
        const raw = Array.isArray(backupData.value?.backups)
          ? backupData.value.backups
          : [];
        setBackupHistory(
          raw.map((backup: any) => ({
            id: String(backup.id),
            type: backup.type === "RESTORE" ? "RESTORE" : "BACKUP",
            status:
              backup.status === "SUCCESS" || backup.status === "FAILED"
                ? backup.status
                : "RUNNING",
            filename: backup.filename || null,
            filepath: backup.filepath || null,
            sizeBytes:
              backup.sizeBytes === null || backup.sizeBytes === undefined
                ? null
                : Number(backup.sizeBytes),
            message: backup.message || null,
            detail: backup.detail || null,
            createdAt: String(backup.createdAt || new Date().toISOString()),
            completedAt: backup.completedAt || null,
            createdBy: backup.createdBy || null,
          })),
        );
      }
      if (needsBackup && scheduleData.status === "fulfilled") {
        const nextSchedule = normalizeBackupSchedule(scheduleData.value);
        setBackupSchedule(nextSchedule);
        setBackupScheduleDraft(nextSchedule);
      }
      if (
        needsBackup &&
        recoveryStatusData.status === "fulfilled" &&
        recoveryStatusData.value
      ) {
        setRecoveryBackupStatus(recoveryStatusData.value);
      }

      const relevantResults = [
        ...(needsBrands ? [brandData] : []),
        ...(needsUsers
          ? [userData, cashierPrivilegeData, overridePolicyData]
          : []),
        ...(needsBusinessRules ? [settingsData] : []),
        ...(needsBackup ? [backupData, scheduleData, recoveryStatusData] : []),
        ...(needsDrawer ? [currentDrawerData, drawerHistoryData] : []),
      ];
      const hasFailure = relevantResults.some(
        (result) => result.status === "rejected",
      );

      if (
        relevantResults.some(
          (result) =>
            result.status === "rejected" && isRateLimitError(result.reason),
        )
      ) {
        requestRateLimitRecovery();
      }
      if (hasFailure) settingsTabLoadedAtRef.current.delete(targetTab);
      else settingsTabLoadedAtRef.current.set(targetTab, Date.now());
      return !hasFailure;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    const loadedAt = settingsTabLoadedAtRef.current.get(tab) ?? 0;
    if (Date.now() - loadedAt < SETTINGS_TAB_CACHE_MS) {
      setLoading(false);
      return;
    }
    const timer = window.setTimeout(() => {
      void loadData(loading, tab);
    }, 140);
    return () => window.clearTimeout(timer);
  }, [tab, rateLimitRecoveryKey]);

  useEffect(() => {
    if (tab !== "audit") return;
    const loadedAt =
      securityQueryLoadedAtRef.current.get(securityQueryKey()) ?? 0;
    if (Date.now() - loadedAt < SETTINGS_TAB_CACHE_MS) return;
    const timer = window.setTimeout(() => {
      void loadSecurityData();
    }, 140);
    return () => window.clearTimeout(timer);
  }, [
    tab,
    auditPage,
    auditPageSize,
    loginPage,
    loginPageSize,
    securityDateFilter.from,
    securityDateFilter.to,
    securityAuditActionFilter,
    securityEntityFilter,
    securityLoginEmailFilter,
    securityLoginStatusFilter,
    rateLimitRecoveryKey,
  ]);

  // resetting and clamping the brand table page keeps pagination stable when the filter set changes
  useEffect(() => {
    setBrandPage(1);
  }, [brandQuery, brandSelection, brandFilter]);

  // Counts come from the database with the brand list, so pagination on the
  // Products page can never make these totals incomplete.
  const brandStats = useMemo(() => {
    const stats: Record<
      string,
      { total: number; active: number; low: number }
    > = {};
    brands.forEach((brand) => {
      stats[brand.id] = {
        total: brand.productCount,
        active: brand.activeProductCount,
        low: 0,
      };
    });
    return stats;
  }, [brands]);

  const filteredBrands = useMemo(() => {
    const query = brandQuery.trim().toLowerCase();
    return brands
      .filter((brand) =>
        brandSelection === "all" ? true : brand.id === brandSelection,
      )
      .filter((brand) =>
        brandFilter === "all"
          ? true
          : brandFilter === "active"
            ? brand.active
            : !brand.active,
      )
      .filter((brand) =>
        query ? brand.name.toLowerCase().includes(query) : true,
      );
  }, [brandFilter, brandQuery, brandSelection, brands]);

  const brandOptions = useMemo(
    () =>
      brands.slice().sort((left, right) => left.name.localeCompare(right.name)),
    [brands],
  );

  const auditTotalPages = Math.max(1, Math.ceil(auditTotal / auditPageSize));
  const loginTotalPages = Math.max(1, Math.ceil(loginTotal / loginPageSize));
  const brandTotalPages = Math.max(
    1,
    Math.ceil(filteredBrands.length / brandPageSize),
  );
  const userManagementTotalPages = Math.max(
    1,
    Math.ceil(cashierPrivileges.length / userManagementPageSize),
  );
  const auditPageClamped = clampPage(auditPage, 1, auditTotalPages);
  const loginPageClamped = clampPage(loginPage, 1, loginTotalPages);
  const brandPageClamped = clampPage(brandPage, 1, brandTotalPages);
  const userManagementPageClamped = clampPage(
    userManagementPage,
    1,
    userManagementTotalPages,
  );
  const pagedCashierPrivileges = useMemo(() => {
    const start = (userManagementPageClamped - 1) * userManagementPageSize;
    return cashierPrivileges.slice(start, start + userManagementPageSize);
  }, [cashierPrivileges, userManagementPageClamped, userManagementPageSize]);
  const userManagementPageStart =
    cashierPrivileges.length === 0
      ? 0
      : (userManagementPageClamped - 1) * userManagementPageSize;
  const userManagementPageEnd = Math.min(
    cashierPrivileges.length,
    userManagementPageStart + userManagementPageSize,
  );
  useEffect(() => {
    if (userManagementPage !== userManagementPageClamped) {
      setUserManagementPage(userManagementPageClamped);
    }
  }, [userManagementPage, userManagementPageClamped]);
  const pagedBrands = useMemo(() => {
    const start = (brandPageClamped - 1) * brandPageSize;
    return filteredBrands.slice(start, start + brandPageSize);
  }, [brandPageClamped, brandPageSize, filteredBrands]);
  const brandPageStart =
    filteredBrands.length === 0 ? 0 : (brandPageClamped - 1) * brandPageSize;
  const brandPageEnd =
    filteredBrands.length === 0 ? 0 : brandPageStart + pagedBrands.length;
  const auditPageStart =
    auditTotal === 0 ? 0 : (auditPageClamped - 1) * auditPageSize;
  const auditPageEnd = auditTotal === 0 ? 0 : auditPageStart + auditLogs.length;
  const loginPageStart =
    loginTotal === 0 ? 0 : (loginPageClamped - 1) * loginPageSize;
  const loginPageEnd =
    loginTotal === 0 ? 0 : loginPageStart + loginAttempts.length;

  const activeUsers = users.filter((user) => user.isActive);
  const adminUsers = activeUsers.filter((user) => user.role === "ADMIN");
  const managerUsers = activeUsers.filter((user) => user.role === "MANAGER");
  const cashierUsers = activeUsers.filter((user) => user.role === "CASHIER");
  const staffUsers = activeUsers.filter((user) => user.role === "STAFF");
  const defaultsDraft: BusinessDefaultsDraft = {
    defaultInitialStock,
    defaultLowStock,
    wholesaleQtyThreshold,
    loyaltyDiscountPercent,
    returnWindowDays,
    parkedBillExpiryHours,
    draftRequestExpiryMinutes,
  };
  const defaultsErrors = validateBusinessDefaultsDraft(defaultsDraft);
  const defaultsValid = Object.keys(defaultsErrors).length === 0;
  const normalizedDefaults = parseBusinessDefaultsDraft(defaultsDraft);

  useEffect(() => {
    setBrandPage((current) => clampPage(current, 1, brandTotalPages));
  }, [brandTotalPages]);

  useEffect(() => {
    setAuditPage((current) => clampPage(current, 1, auditTotalPages));
  }, [auditTotalPages]);

  useEffect(() => {
    setLoginPage((current) => clampPage(current, 1, loginTotalPages));
  }, [loginTotalPages]);
  const defaultsDirty =
    !defaultsValid || normalizedDefaults.defaultInitialStock !==
    savedDefaults.defaultInitialStock ||
    normalizedDefaults.defaultLowStock !== savedDefaults.defaultLowStock ||
    normalizedDefaults.wholesaleQtyThreshold !==
    savedDefaults.wholesaleQtyThreshold ||
    normalizedDefaults.loyaltyDiscountPercent !==
    savedDefaults.loyaltyDiscountPercent ||
    normalizedDefaults.returnWindowDays !== savedDefaults.returnWindowDays ||
    normalizedDefaults.parkedBillExpiryHours !==
    savedDefaults.parkedBillExpiryHours ||
    normalizedDefaults.draftRequestExpiryMinutes !==
    savedDefaults.draftRequestExpiryMinutes;
  const effectiveStaffDraftsDraft = effectiveStaffDraftRequests(
    modeDraft,
    staffDraftsDraft,
  );
  const accessDirty = isBusinessAccessDraftDirty({
    draftMode: modeDraft,
    savedMode: capabilities.businessMode,
    draftStaffRequests: staffDraftsDraft,
    savedStaffRequests: capabilities.staffDraftRequestsEnabled,
  });
  const modeReasonPresets =
    modeDraft !== capabilities.businessMode
      ? [
          modeDraft === "FULL_POS"
            ? {
                label: "Full POS rollout",
                text: "Storewide Full POS launch and cashier rollout",
              }
            : modeDraft === "INVENTORY_ONLY"
              ? {
                  label: "Enable inventory",
                  text: "Enabling counted stock management and receiving",
                }
              : {
                  label: "Catalog maintenance",
                  text: "Temporary catalog-only access for catalog maintenance",
                },
          {
            label: "Workflow testing",
            text: "System feature verification and workflow testing",
          },
          {
            label: "Routine configuration",
            text: "Routine operational capability update by administrator",
          },
        ]
      : [
          {
            label: effectiveStaffDraftsDraft
              ? "Enable staff requests"
              : "Disable staff requests",
            text: effectiveStaffDraftsDraft
              ? "Enable staff billing draft requests for floor assistants"
              : "Disable staff billing draft requests for floor assistants",
          },
          {
            label: "Workflow testing",
            text: "System feature verification and workflow testing",
          },
          {
            label: "Routine configuration",
            text: "Routine operational capability update by administrator",
          },
        ];
  const defaultChanges = defaultsValid
    ? [
      { key: "defaultInitialStock" as const, label: "New product initial stock", unit: "units" },
      { key: "defaultLowStock" as const, label: "Stock alert threshold", unit: "units" },
      { key: "wholesaleQtyThreshold" as const, label: "Wholesale threshold", unit: "units" },
      { key: "loyaltyDiscountPercent" as const, label: "Loyalty discount", unit: "%" },
      { key: "returnWindowDays" as const, label: "Return window", unit: "days" },
      { key: "parkedBillExpiryHours" as const, label: "Parked bill expiry", unit: "hours" },
      { key: "draftRequestExpiryMinutes" as const, label: "Draft request expiry", unit: "minutes" },
    ]
      .filter(({ key }) => normalizedDefaults[key] !== savedDefaults[key])
      .map(({ key, label, unit }) => ({
        key,
        label,
        unit,
        before: savedDefaults[key],
        after: normalizedDefaults[key],
      }))
    : [];

  // form state resetting functions
  function resetBrandForm() {
    setEditingBrand(null);
    setBrandName("");
    setBrandActive(true);
    setBrandError("");
  }

  function closeBrandForm() {
    setShowBrandForm(false);
    resetBrandForm();
  }

  async function saveBrandCore(forceDeactivate = false) {
    const nextName = brandName.trim();
    if (!nextName) {
      setBrandError("Brand name is required.");
      return;
    }
    setBrandError("");

    // editing and creating share the same normalized save flow, with forceDeactivate handling the warning-confirm path
    if (editingBrand) {
      await updateBrandApi(editingBrand.id, {
        name: nextName,
        isActive: forceDeactivate ? false : brandActive,
      });
    } else {
      const created = await createBrandApi(nextName);
      if (!brandActive) {
        await updateBrandApi(created.id, { isActive: false });
      }
    }

    closeBrandForm();
    await refreshSettingsData();
  }

  // checks if the user is deactivating a brand that was previously active,
  // triggering a warning flow before making changes
  async function saveBrand() {
    try {
      if (editingBrand && editingBrand.active && !brandActive) {
        setPendingBrandSave(true);
        setPendingBrandDeactivation(editingBrand);
        return;
      }

      await saveBrandCore(false);
    } catch (error: any) {
      setBrandError(
        error?.response?.data?.error ||
        error?.message ||
        "Failed to save the brand.",
      );
    }
  }

  async function confirmBrandDeactivation() {
    const brand = pendingBrandDeactivation;
    if (!brand) return;

    try {
      // this confirm dialog is reused in two cases:
      // 1. finishing a save where an active brand is being turned inactive
      // 2. directly toggling an active brand off from the table
      if (pendingBrandSave) {
        await saveBrandCore(true);
      } else {
        await updateBrandApi(brand.id, { isActive: false });
        await refreshSettingsData();
      }
    } catch (error: any) {
      setBrandError(
        error?.response?.data?.error ||
        error?.message ||
        "Failed to update the brand.",
      );
    } finally {
      setPendingBrandSave(false);
      setPendingBrandDeactivation(null);
    }
  }

  async function requestToggleBrandStatus(brand: Brand) {
    // active brands need confirmation before deactivation, but inactive brands can be reactivated immediately
    if (brand.active) {
      setPendingBrandSave(false);
      setPendingBrandDeactivation(brand);
      return;
    }

    try {
      await updateBrandApi(brand.id, { isActive: true });
      await refreshSettingsData();
    } catch (error: any) {
      setBrandError(
        error?.response?.data?.error ||
        error?.message ||
        "Failed to reactivate the brand.",
      );
    }
  }

  // triggering a new database backup manually
  async function handleBackup() {
    try {
      setBackupBusy(true);
      const result = await triggerBackupApi();
      setBackupResult(result);
      showToast("success", "Database export created successfully.");
      setShowBackupConfirm(false);
      setShowBackupSuccess(true);
      await refreshSettingsData();
    } catch (error: any) {
      showToast(
        "danger",
        error?.response?.data?.error || "Failed to trigger backup.",
        { persistent: true },
      );
    } finally {
      setBackupBusy(false);
    }
  }

  async function handleStorageIntegrityCheck() {
    try {
      setStorageIntegrityBusy(true);
      setStorageIntegrityError("");
      const report = await getStorageIntegrityReportApi();
      setStorageIntegrityReport(report);
      if (report.status === "HEALTHY") {
        showToast("success", "Storage check completed with no findings.");
      }
    } catch (error: any) {
      setStorageIntegrityError(
        error?.response?.data?.error ||
        error?.message ||
        "Storage check could not be completed.",
      );
    } finally {
      setStorageIntegrityBusy(false);
    }
  }

  async function refreshRecoveryBackupStatus() {
    try {
      setRecoveryBackupStatusBusy(true);
      setRecoveryBackupStatus(await getRecoveryBackupStatusApi());
    } catch (error: any) {
      showToast(
        "danger",
        error?.response?.data?.error ||
        error?.message ||
        "Recovery backup status could not be refreshed.",
      );
    } finally {
      setRecoveryBackupStatusBusy(false);
    }
  }

  function requestRestoreBackup(backup: BackupHistoryRow) {
    setRestoreTarget(backup);
    setRestoreConfirmation("");
    setRestoreError("");
  }

  async function handleRestoreBackup() {
    if (!restoreTarget) return;

    try {
      setRestoreBusy(true);
      setRestoreError("");
      await restoreBackupApi(restoreTarget.id, restoreConfirmation.trim());
      showToast("success", `Restore completed from ${restoreTarget.filename}.`);
      setRestoreTarget(null);
      setRestoreConfirmation("");
      await refreshSettingsData();
    } catch (error: any) {
      setRestoreError(
        error?.response?.data?.error ||
        error?.response?.data?.detail ||
        error?.message ||
        "Failed to restore backup.",
      );
      await loadData(false);
    } finally {
      setRestoreBusy(false);
    }
  }

  async function saveCashierPrivilege(
    cashier: CashierPrivilegeRow,
    patch: Partial<CashierPrivilegeRow["privilege"]>,
  ) {
    setSavingCashierPrivilegeId(cashier.id);
    const nextPrivilege = { ...cashier.privilege, ...patch };

    setCashierPrivileges((current) =>
      current.map((row) =>
        row.id === cashier.id ? { ...row, privilege: nextPrivilege } : row,
      ),
    );

    try {
      const result = await updateCashierPrivilegeApi(cashier.id, nextPrivilege);
      setCashierPrivileges((current) =>
        current.map((row) =>
          row.id === cashier.id ? { ...row, privilege: result.privilege } : row,
        ),
      );
      showToast("success", `${cashier.name}'s permissions updated.`);
    } catch (error: any) {
      showToast(
        "danger",
        error?.response?.data?.error ||
        error?.message ||
        "Failed to update user permissions.",
      );
      await refreshSettingsData();
    } finally {
      setSavingCashierPrivilegeId(null);
    }
  }

  async function saveOverridePin() {
    const nextPin = overridePinDraft.trim();
    if (!/^\d{4}$/.test(nextPin)) {
      setOverridePinError("Enter exactly 4 digits.");
      return;
    }

    try {
      setSavingOverridePin(true);
      setOverridePinError("");
      const policy = await updateOverridePinApi(nextPin);
      setOverridePolicy(policy);
      setOverridePinDraft("");
      setShowOverridePinConfirm(false);
      showToast("success", "Override PIN updated.");
      await refreshSettingsData();
    } catch (error: any) {
      setOverridePinError(
        error?.response?.data?.error ||
        error?.message ||
        "Failed to update override PIN.",
      );
    } finally {
      setSavingOverridePin(false);
    }
  }

  async function saveBackupSchedule() {
    try {
      setBackupScheduleBusy(true);
      setBackupScheduleError("");
      const saved = await updateBackupScheduleApi({
        enabled: backupScheduleDraft.enabled,
        frequency: backupScheduleDraft.frequency,
        timeOfDay: backupScheduleDraft.timeOfDay,
        dayOfWeek:
          backupScheduleDraft.frequency === "WEEKLY"
            ? backupScheduleDraft.dayOfWeek
            : null,
      });
      const nextSchedule = normalizeBackupSchedule(saved);
      setBackupSchedule(nextSchedule);
      setBackupScheduleDraft(nextSchedule);
      setShowBackupScheduleConfirm(false);
      showToast("success", "Database export schedule updated.");
      await loadData(false);
    } catch (error: any) {
      setBackupScheduleError(
        error?.response?.data?.error ||
        error?.message ||
        "Failed to update backup schedule.",
      );
    } finally {
      setBackupScheduleBusy(false);
    }
  }

  function discardBusinessDefaults() {
    const savedDraft = defaultsToDraft(savedDefaults);
    setDefaultInitialStock(savedDraft.defaultInitialStock);
    setDefaultLowStock(savedDraft.defaultLowStock);
    setWholesaleQtyThreshold(savedDraft.wholesaleQtyThreshold);
    setLoyaltyDiscountPercent(savedDraft.loyaltyDiscountPercent);
    setReturnWindowDays(savedDraft.returnWindowDays);
    setParkedBillExpiryHours(savedDraft.parkedBillExpiryHours);
    setDraftRequestExpiryMinutes(savedDraft.draftRequestExpiryMinutes);
    setDefaultsShowErrors(false);
    setDefaultsSaveError("");
  }

  function reviewBusinessDefaults() {
    setDefaultsShowErrors(true);
    setDefaultsSaveError("");
    if (!defaultsValid) {
      window.requestAnimationFrame(() => {
        focusInvalidField(
          document.querySelector<HTMLElement>(
            '[data-business-default-error="true"]',
          ),
        );
      });
      return;
    }
    setShowDefaultsConfirm(true);
  }

  // running the update for business defaults
  async function saveBusinessDefaults() {
    if (!defaultsValid || defaultChanges.length === 0) return;
    const payload: Partial<BusinessSettings> = {};
    for (const change of defaultChanges) {
      if (change.key === "defaultInitialStock") payload.defaultInitialStock = change.after;
      if (change.key === "defaultLowStock") payload.defaultLowStockThreshold = change.after;
      if (change.key === "wholesaleQtyThreshold") payload.defaultWholesaleQtyThreshold = change.after;
      if (change.key === "loyaltyDiscountPercent") payload.loyaltyDiscountPercent = change.after;
      if (change.key === "returnWindowDays") payload.returnWindowDays = change.after;
      if (change.key === "parkedBillExpiryHours") payload.parkedBillExpiryHours = change.after;
      if (change.key === "draftRequestExpiryMinutes") payload.draftRequestExpiryMinutes = change.after;
    }

    try {
      setDefaultsBusy(true);
      setDefaultsSaveError("");
      const updated = await updateBusinessSettingsApi(payload);
      const saved = buildBusinessDefaults(
        Number(updated.defaultLowStockThreshold),
        Number(updated.defaultWholesaleQtyThreshold),
        Number(updated.loyaltyDiscountPercent),
        Number(updated.returnWindowDays),
        Number(updated.parkedBillExpiryHours),
        Number(updated.draftRequestExpiryMinutes),
        Number(updated.defaultInitialStock),
      );
      const savedDraft = defaultsToDraft(saved);
      setDefaultInitialStock(savedDraft.defaultInitialStock);
      setDefaultLowStock(savedDraft.defaultLowStock);
      setWholesaleQtyThreshold(savedDraft.wholesaleQtyThreshold);
      setLoyaltyDiscountPercent(savedDraft.loyaltyDiscountPercent);
      setReturnWindowDays(savedDraft.returnWindowDays);
      setParkedBillExpiryHours(savedDraft.parkedBillExpiryHours);
      setDraftRequestExpiryMinutes(savedDraft.draftRequestExpiryMinutes);
      setSavedDefaults(saved);
      setDefaultsShowErrors(false);
      setShowDefaultsConfirm(false);
      showToast("success", "Business defaults updated.");
      await refreshSettingsData();
    } catch (error: any) {
      const message =
        error?.response?.data?.error ||
        error?.message ||
        "Business defaults could not be saved.";
      setDefaultsSaveError(message);
      showToast("danger", message);
    } finally {
      setDefaultsBusy(false);
    }
  }

  async function refreshDrawerData() {
    const [current, history] = await Promise.all([
      getCurrentCashDrawerApi(),
      listCashDrawersApi(),
    ]);
    setCurrentDrawer(current.drawer || null);
    setDrawerHistory(history.drawers || []);
  }

  async function handleOpenDrawer() {
    try {
      setDrawerBusy(true);
      setDrawerError("");
      const result = await openCashDrawerApi({
        openingFloat: Number(drawerOpeningFloat || 0),
        note: drawerNote.trim() || undefined,
      });
      setCurrentDrawer(result.drawer);
      setDrawerNote("");
      showToast("success", "Cash drawer opened.");
      await refreshDrawerData();
    } catch (error: any) {
      setDrawerError(
        error?.response?.data?.error ||
        error?.message ||
        "Failed to open cash drawer.",
      );
    } finally {
      setDrawerBusy(false);
    }
  }

  async function handleDrawerEvent(type: "CASH_IN" | "CASH_OUT") {
    if (!currentDrawer) return;
    try {
      setDrawerBusy(true);
      setDrawerError("");
      const result = await addCashDrawerEventApi(currentDrawer.id, {
        type,
        amount: Number(drawerAmount || 0),
        note: drawerNote.trim() || undefined,
      });
      setCurrentDrawer(result.drawer);
      setDrawerAmount("");
      setDrawerNote("");
      showToast(
        "success",
        type === "CASH_IN" ? "Cash added." : "Cash removed.",
      );
      await refreshDrawerData();
    } catch (error: any) {
      setDrawerError(
        error?.response?.data?.error ||
        error?.message ||
        "Failed to update cash drawer.",
      );
    } finally {
      setDrawerBusy(false);
    }
  }

  async function handleCloseDrawer() {
    if (!currentDrawer) return;
    try {
      setDrawerBusy(true);
      setDrawerError("");
      const result = await closeCashDrawerApi(currentDrawer.id, {
        actualTotal: Number(drawerActualTotal || 0),
        note: drawerNote.trim() || undefined,
      });
      setCurrentDrawer(null);
      setDrawerHistory((current) => [
        result.drawer,
        ...current.filter((item) => item.id !== result.drawer.id),
      ]);
      setDrawerActualTotal("");
      setDrawerNote("");
      showToast("success", "Cash drawer closed.");
      await refreshDrawerData();
    } catch (error: any) {
      setDrawerError(
        error?.response?.data?.error ||
        error?.message ||
        "Failed to close cash drawer.",
      );
    } finally {
      setDrawerBusy(false);
    }
  }

  // applying the selected date range updates both security panels together and resets them back to page 1
  function applySecurityFilters() {
    if (
      securityDateDraft.from &&
      securityDateDraft.to &&
      securityDateDraft.from > securityDateDraft.to
    ) {
      setSecurityFilterError("The from date cannot be after the to date.");
      return false;
    }

    setSecurityFilterError("");
    setAuditPage(1);
    setLoginPage(1);
    setSecurityDateFilter({ ...securityDateDraft });
    setSecurityAuditActionFilter(securityAuditActionDraft.trim());
    setSecurityEntityFilter(securityEntityDraft.trim());
    setSecurityLoginEmailFilter(securityLoginEmailDraft.trim());
    setSecurityLoginStatusFilter(securityLoginStatusDraft);
    return true;
  }

  // clearing the filter returns both lists to their latest records without touching the rest of the page
  function clearSecurityFilters() {
    setSecurityFilterError("");
    setSecurityDateDraft(INITIAL_SECURITY_RANGE);
    setSecurityDateFilter(INITIAL_SECURITY_RANGE);
    setSecurityAuditActionDraft("");
    setSecurityAuditActionFilter("");
    setSecurityEntityDraft("");
    setSecurityEntityFilter("");
    setSecurityLoginEmailDraft("");
    setSecurityLoginEmailFilter("");
    setSecurityLoginStatusDraft("ALL");
    setSecurityLoginStatusFilter("ALL");
    setAuditPage(1);
    setLoginPage(1);
  }

  const mobileSecurityFilterCount = [
    Boolean(securityDateFilter.from || securityDateFilter.to),
    Boolean(securityAuditActionFilter),
    Boolean(securityEntityFilter),
    Boolean(securityLoginEmailFilter),
    securityLoginStatusFilter !== "ALL",
  ].filter(Boolean).length;
  const mobileSecurityFilterChips: MobileFilterChip[] = [
    ...(securityDateFilter.from || securityDateFilter.to
      ? [
        {
          id: "dates",
          label: `${securityDateFilter.from || "Any"} – ${securityDateFilter.to || "Any"}`,
          onRemove: () => {
            setSecurityDateDraft(INITIAL_SECURITY_RANGE);
            setSecurityDateFilter(INITIAL_SECURITY_RANGE);
            setAuditPage(1);
            setLoginPage(1);
          },
        },
      ]
      : []),
    ...(securityAuditActionFilter
      ? [
        {
          id: "action",
          label: `Action: ${securityAuditActionFilter}`,
          onRemove: () => {
            setSecurityAuditActionDraft("");
            setSecurityAuditActionFilter("");
            setAuditPage(1);
          },
        },
      ]
      : []),
    ...(securityEntityFilter
      ? [
        {
          id: "entity",
          label: `Entity: ${securityEntityFilter}`,
          onRemove: () => {
            setSecurityEntityDraft("");
            setSecurityEntityFilter("");
            setAuditPage(1);
          },
        },
      ]
      : []),
    ...(securityLoginEmailFilter
      ? [
        {
          id: "account",
          label: securityLoginEmailFilter,
          onRemove: () => {
            setSecurityLoginEmailDraft("");
            setSecurityLoginEmailFilter("");
            setLoginPage(1);
          },
        },
      ]
      : []),
    ...(securityLoginStatusFilter !== "ALL"
      ? [
        {
          id: "login",
          label:
            securityLoginStatusFilter === "SUCCESS" ? "Successful" : "Failed",
          onRemove: () => {
            setSecurityLoginStatusDraft("ALL");
            setSecurityLoginStatusFilter("ALL");
            setLoginPage(1);
          },
        },
      ]
      : []),
  ];

  function openMobileSecurityFilters() {
    setSecurityDateDraft({ ...securityDateFilter });
    setSecurityAuditActionDraft(securityAuditActionFilter);
    setSecurityEntityDraft(securityEntityFilter);
    setSecurityLoginEmailDraft(securityLoginEmailFilter);
    setSecurityLoginStatusDraft(securityLoginStatusFilter);
    setSecurityFilterError("");
    setMobileSecurityFiltersOpen(true);
  }

  function closeMobileSecurityFilters() {
    setSecurityDateDraft({ ...securityDateFilter });
    setSecurityAuditActionDraft(securityAuditActionFilter);
    setSecurityEntityDraft(securityEntityFilter);
    setSecurityLoginEmailDraft(securityLoginEmailFilter);
    setSecurityLoginStatusDraft(securityLoginStatusFilter);
    setSecurityFilterError("");
    setMobileSecurityFiltersOpen(false);
  }

  function selectBusinessMode(nextMode: BusinessMode) {
    const next = stageBusinessModeSelection({
      currentDraftMode: modeDraft,
      currentStaffRequests: staffDraftsDraft,
      nextMode,
      savedMode: capabilities.businessMode,
      savedStaffRequests: capabilities.staffDraftRequestsEnabled,
    });
    const selectionChanged =
      next.mode !== modeDraft ||
      next.staffDraftRequestsEnabled !== staffDraftsDraft;
    setModeDraft(next.mode);
    setStaffDraftsDraft(next.staffDraftRequestsEnabled);
    if (selectionChanged) setModeReason("");
    setModeError("");
    setModePreflight(null);
  }

  async function reviewBusinessModeChange() {
    if (!accessDirty) {
      setModeError("Select an access change before reviewing it.");
      return;
    }
    if (defaultsDirty) {
      setModeError(
        "Save or discard the unsaved default changes before changing shop access.",
      );
      return;
    }
    const reason = modeReason.trim();
    if (reason.length < 5) {
      setModeError(
        "Explain the change in at least 5 characters for the audit trail.",
      );
      return;
    }
    setModeBusy(true);
    setModeError("");
    setModePreflight(null);
    try {
      const result = await getBusinessModePreflightApi(
        modeDraft,
        modeDraft === "FULL_POS" ? staffDraftsDraft : false,
      );
      setModePreflight(result);
      if (!result.allowed) {
        setModeError(
          "Finish the active work listed below before changing mode.",
        );
        return;
      }
      setShowModeConfirm(true);
    } catch (error: any) {
      setModeError(
        error?.response?.data?.error ||
        error?.message ||
        "The mode safety check failed.",
      );
    } finally {
      setModeBusy(false);
    }
  }

  async function confirmBusinessModeChange() {
    setModeBusy(true);
    setModeError("");
    try {
      const updated = await updateBusinessModeApi({
        businessMode: modeDraft,
        reason: modeReason.trim(),
        staffDraftRequestsEnabled:
          modeDraft === "FULL_POS" ? staffDraftsDraft : false,
      });
      setModeDraft(updated.settings.businessMode);
      setStaffDraftsDraft(updated.settings.staffDraftRequestsEnabled);
      setShowModeConfirm(false);
      setModeReason("");
      setModePreflight(null);
      showToast(
        "success",
        "Business mode updated. Access rules were reapplied.",
      );
      window.dispatchEvent(new CustomEvent("business_capabilities_changed"));
    } catch (error: any) {
      const preflight = error?.response?.data?.preflight as
        | BusinessModePreflight
        | undefined;
      if (preflight) setModePreflight(preflight);
      setModeError(
        error?.response?.data?.error ||
        error?.message ||
        "Business mode could not be updated.",
      );
      setShowModeConfirm(false);
    } finally {
      setModeBusy(false);
    }
  }

  const settingsTabs = [
    { key: "overview", label: "Business Rules" },
    ...(capabilities.posEnabled
      ? [{ key: "drawer" as TabKey, label: "Cash Drawer" }]
      : []),
    { key: "cashier-controls", label: "User Management" },
    { key: "brands", label: "Brands" },
    { key: "audit", label: "Audit & Security" },
    { key: "backup", label: "Backup" },
  ] as Array<{ key: TabKey; label: string }>;

  function moveSettingsTab(direction: -1 | 1) {
    const currentIndex = settingsTabs.findIndex((item) => item.key === tab);
    const nextTab = settingsTabs[currentIndex + direction];
    if (nextTab) setTab(nextTab.key);
  }

  const settingsSwipeGesture = useHorizontalGesture<HTMLElement>({
    enabled: !defaultsDirty && !accessDirty,
    threshold: 72,
    edgeGuard: 24,
    allowMouse: true,
    maxViewportWidth: 1023,
    onMove: (offsetX) => {
      const direction: -1 | 1 = offsetX < 0 ? 1 : -1;
      const currentIndex = settingsTabs.findIndex((item) => item.key === tab);
      if (!settingsTabs[currentIndex + direction]) {
        settingsTabRailRef.current?.settle();
        return;
      }
      settingsTabRailRef.current?.setGestureProgress(
        direction,
        Math.min(1, Math.abs(offsetX) / 140),
      );
    },
    onSwipeLeft: () => moveSettingsTab(1),
    onSwipeRight: () => moveSettingsTab(-1),
    onEnd: () => window.requestAnimationFrame(() => settingsTabRailRef.current?.settle()),
  });

  useEffect(() => {
    if (tab === "drawer" && !capabilities.posEnabled) setTab("overview");
  }, [capabilities.posEnabled, tab]);

  const tabTitles: Record<TabKey, { title: string; subtitle: string }> = {
    overview: {
      title: "Business Rules",
      subtitle: "System-wide operational defaults.",
    },
    drawer: { title: "Cash Drawer", subtitle: "Manage sessions and history." },
    "cashier-controls": {
      title: "User Management",
      subtitle: "Role permissions and security controls.",
    },
    brands: {
      title: "Brand Management",
      subtitle: "Manage labels and inventory tags.",
    },
    audit: { title: "Audit & Security", subtitle: "Activity monitoring." },
    backup: { title: "System Backup", subtitle: "Data protection." },
  };

  const permissionDisplay = [
    ["canCreateDiscountedCustomer", "CREATE CUSTOMER"],
    ["canRequestCustomerDiscount", "REQUEST DISCOUNT"],
    ["canApplyManualDiscount", "MANUAL DISCOUNT"],
    ["canVoidPayment", "VOID PAYMENT"],
    ["canOverrideBillingPrice", "PRICE OVERRIDE"],
    ["canViewWholesalePrice", "VIEW WHOLESALE / थोक मूल्य"],
  ] as const;

  function roleLabel(role?: string | null) {
    if (role === "MANAGER") return "Manager";
    if (role === "STAFF") return "Staff";
    return "Cashier";
  }

  function openCashierEdit(cashier: CashierPrivilegeRow) {
    setEditingCashier(cashier);
    setCashierPrivilegeDraft({ ...cashier.privilege });
  }

  function updateCashierDraft(
    patch: Partial<CashierPrivilegeRow["privilege"]>,
  ) {
    setCashierPrivilegeDraft((current) =>
      current ? { ...current, ...patch } : current,
    );
  }

  async function confirmCashierPrivilegeSave() {
    if (!editingCashier || !cashierPrivilegeDraft) return;
    await saveCashierPrivilege(editingCashier, cashierPrivilegeDraft);
    setShowCashierSaveConfirm(false);
    setEditingCashier(null);
    setCashierPrivilegeDraft(null);
  }

  function closeCashierEdit() {
    setEditingCashier(null);
    setCashierPrivilegeDraft(null);
    setShowCashierSaveConfirm(false);
  }

  const visibleDrawerHistory = drawerHistoryExpanded
    ? drawerHistory
    : drawerHistory.slice(0, 3);

  const pageTitle = tabTitles[tab];

  if (loading) {
    return (
      <div className="flex h-[60vh] items-center justify-center font-semibold text-slate-400">
        Loading settings...
      </div>
    );
  }

  return (
    <div className="-m-[12px] min-h-[calc(100dvh-72px)] bg-white text-slate-900 sm:-m-[20px] lg:-m-[24px]">
      <div className="border-b border-[#CFCFD3] bg-white shadow-sm">
        <SwipeableTabRail
          items={settingsTabs.map((item) => ({ value: item.key, label: item.label }))}
          value={tab}
          controllerRef={settingsTabRailRef}
          onChange={setTab}
          ariaLabel="Settings sections"
          className="px-4 sm:px-7"
          railClassName="gap-6 sm:gap-8"
          buttonClassName="px-1 py-4 text-[14px] font-extrabold sm:text-[15px]"
        />
      </div>

      <main {...settingsSwipeGesture} className="w-full px-4 py-5 sm:px-7 sm:py-6">
        {tab === "overview" && defaultsDirty ? (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-[12px] border border-[#D4D7DC] bg-[#F8FAFC] p-3">
            <div className="flex items-center gap-2 text-[12.5px] font-bold text-[#11120D]">
              <span className="h-2 w-2 rounded-full bg-amber-500" />
              <span>Unsaved business rule changes</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={discardBusinessDefaults}
                disabled={defaultsBusy}
                className="h-8.5 rounded-[8px] border border-[#D4D7DC] bg-white px-3 text-[12px] font-extrabold text-[#374151] hover:bg-[#F3F4F6]"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={reviewBusinessDefaults}
                disabled={defaultsBusy}
                className="h-8.5 rounded-[8px] bg-[#11120D] px-4 text-[12px] font-extrabold text-white transition hover:bg-[#2A2C27] disabled:opacity-50"
              >
                {defaultsBusy ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </div>
        ) : null}

        {tab === "overview" ? (
          <section className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <div className="rounded-[16px] border border-[#D8DBE0] bg-white p-5 shadow-2xs xl:col-span-2">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="text-[10px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
                    Active capability mode
                  </div>
                  <h2 className="mt-1 text-[18px] font-black text-[#11120D]">
                    Choose what this shop can operate
                  </h2>
                  <p className="mt-0.5 max-w-3xl text-[12.5px] font-medium leading-relaxed text-[#64748B]">
                    Roles decide who may act. This mode decides whether the whole shop may use inventory or POS features at all.
                  </p>
                </div>
                <span className="inline-flex h-8 items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 text-[11.5px] font-bold text-emerald-800 shrink-0 shadow-2xs">
                  <Icon name="check_circle" sizePx={14} className="text-emerald-600" />
                  <span>Saved: {formatBusinessMode(capabilities.businessMode)}</span>
                </span>
              </div>

              <div className="mt-4 grid gap-3 lg:grid-cols-3">
                {[
                  {
                    value: "CATALOG_ONLY" as const,
                    title: "Catalog only",
                    icon: "storefront",
                    description:
                      "Products, imports, prices, lookup, users and audit. Stock is not shown or claimed.",
                    badge: "Basic Mode",
                  },
                  {
                    value: "INVENTORY_ONLY" as const,
                    title: "Catalog + inventory",
                    icon: "inventory_2",
                    description:
                      "Adds counted stock, receiving, corrections and stock alerts. Billing stays off.",
                    badge: "Stock Control",
                  },
                  {
                    value: "FULL_POS" as const,
                    title: "Full POS",
                    icon: "point_of_sale",
                    description:
                      "Adds billing, invoices, payments, cash drawer, returns and financial workflows.",
                    badge: "Complete Suite",
                  },
                ].map((option) => {
                  const selected = modeDraft === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => selectBusinessMode(option.value)}
                      className={cn(
                        "relative flex flex-col justify-between min-h-[136px] rounded-[12px] p-4 text-left transition active:scale-98",
                        selected
                          ? "border-2 border-slate-800 bg-[#F1F5F9] shadow-xs"
                          : "border border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50/60",
                      )}
                      aria-pressed={selected}
                    >
                      <div>
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2.5">
                            <div
                              className={cn(
                                "flex h-7 w-7 items-center justify-center rounded-[8px] transition",
                                selected
                                  ? "bg-slate-900 text-white shadow-2xs"
                                  : "bg-slate-100 text-slate-500",
                              )}
                            >
                              <Icon name={option.icon} sizePx={16} />
                            </div>
                            <span className={cn("text-[14px] font-black", selected ? "text-slate-950" : "text-slate-800")}>
                              {option.title}
                            </span>
                          </div>
                          <div
                            className={cn(
                              "flex h-5 w-5 items-center justify-center rounded-full transition",
                              selected
                                ? "bg-slate-900 text-white shadow-2xs"
                                : "border-2 border-slate-300 bg-white",
                            )}
                          >
                            {selected ? (
                              <Icon name="check" sizePx={13} className="font-bold" />
                            ) : null}
                          </div>
                        </div>
                        <p className={cn("mt-2.5 text-[12px] font-medium leading-relaxed", selected ? "text-slate-600" : "text-slate-500")}>
                          {option.description}
                        </p>
                      </div>
                      <div className="mt-3">
                        <span
                          className={cn(
                            "inline-block rounded-full px-2.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wide transition",
                            selected
                              ? "border border-slate-300 bg-slate-200/80 text-slate-800"
                              : "bg-slate-100 text-slate-500",
                          )}
                        >
                          {option.badge}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Staff Billing Requests Pro Switch Toggle */}
              <div
                className={cn(
                  "mt-3.5 flex items-start sm:items-center justify-between gap-3 rounded-[12px] border p-3.5 transition",
                  modeDraft === "FULL_POS" ? "border-slate-300 bg-[#F8FAFC] hover:bg-white" : "border-slate-200 bg-slate-50/80 opacity-75",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-extrabold text-slate-950">
                      Staff billing draft requests
                    </span>
                    {modeDraft !== "FULL_POS" ? (
                      <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10.5px] font-extrabold text-slate-500">
                        Requires Full POS
                      </span>
                    ) : (
                      <span className="rounded-full border border-slate-300 bg-white px-2 py-0.5 text-[10.5px] font-extrabold text-slate-800">
                        Floor Assistant Tool
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[11.5px] font-medium leading-normal text-slate-500">
                    Allows floor staff to build and transmit selected items directly to cashier registers as pending draft bills.
                  </p>
                </div>

                <div className="flex items-center gap-2.5 shrink-0 pt-0.5 sm:pt-0">
                  <span className="hidden sm:inline-block text-[11.5px] font-bold text-slate-500">
                    {modeDraft === "FULL_POS" && staffDraftsDraft ? "Enabled" : "Disabled"}
                  </span>
                  <SettingsToggleSwitch
                    checked={modeDraft === "FULL_POS" && staffDraftsDraft}
                    disabled={modeDraft !== "FULL_POS"}
                    onChange={(checked) => {
                      setStaffDraftsDraft(checked);
                      setModeReason("");
                      setModeError("");
                      setModePreflight(null);
                    }}
                    ariaLabel="Toggle staff billing draft requests"
                  />
                </div>
              </div>

              {/* Dynamic Staged Access Migration Panel */}
              {accessDirty ? (
                <div className="mt-4 overflow-hidden rounded-[14px] border border-slate-300 bg-[#F8FAFC] shadow-2xs">
                  <div className="p-3.5 sm:p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-[13px] font-black text-slate-950 sm:text-[14px]">
                        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-slate-900 text-white">
                          <Icon name="swap_horiz" sizePx={16} />
                        </span>
                        <span>Pending Shop Access Change</span>
                      </div>
                      <div className="mt-2 text-[12px] font-medium leading-relaxed text-slate-600">
                        {modeDraft !== capabilities.businessMode ? (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="rounded-[7px] border border-slate-300 bg-white px-2 py-1 font-extrabold text-slate-800">
                              {formatBusinessMode(capabilities.businessMode)}
                            </span>
                            <Icon name="arrow_forward" sizePx={14} className="text-slate-500" />
                            <span className="rounded-[7px] bg-slate-900 px-2 py-1 font-extrabold text-white">
                              {formatBusinessMode(modeDraft)}
                            </span>
                          </div>
                        ) : (
                          <span>
                            Staff billing draft requests will be <strong className="font-extrabold text-slate-950">{effectiveStaffDraftsDraft ? "enabled" : "disabled"}</strong>.
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setModeDraft(capabilities.businessMode);
                        setStaffDraftsDraft(capabilities.staffDraftRequestsEnabled);
                        setModeReason("");
                        setModeError("");
                        setModePreflight(null);
                      }}
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border border-slate-300 bg-white text-slate-700 shadow-2xs transition-colors hover:bg-slate-100 sm:w-auto sm:gap-1 sm:px-2.5"
                      aria-label="Discard pending shop access change"
                    >
                      <Icon name="close" sizePx={14} />
                      <span className="hidden text-[11.5px] font-extrabold sm:inline">Discard</span>
                    </button>
                  </div>

                  {/* Quick Reason Presets */}
                  <div className="mt-3.5 space-y-2 border-t border-slate-200/80 pt-3.5">
                    <div className="text-[10px] font-extrabold uppercase tracking-[0.06em] text-slate-500">
                      Suggested audit reasons
                    </div>
                    <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 sm:flex sm:flex-wrap">
                      {modeReasonPresets.map((preset) => (
                        <button
                          key={preset.label}
                          type="button"
                          onClick={() => {
                            setModeReason(preset.text);
                            setModeError("");
                          }}
                          className={cn(
                            "min-h-9 max-w-full rounded-[9px] border px-3 py-2 text-left text-[11.5px] font-bold leading-snug shadow-2xs transition-colors sm:min-h-8 sm:py-1.5",
                            modeReason === preset.text
                              ? "border-slate-900 bg-slate-900 text-white"
                              : "border-slate-200 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50",
                          )}
                          aria-pressed={modeReason === preset.text}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Reason Input & Action */}
                  <div className="mt-3.5 flex flex-col gap-3 sm:flex-row sm:items-end">
                    <label className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center justify-between gap-1">
                        <span className="text-[11.5px] font-extrabold text-slate-950">
                          Audit trail reason <span className="text-rose-600">*</span>
                        </span>
                        <span className={cn("text-[10.5px] font-extrabold", modeReason.trim().length >= 5 ? "text-emerald-700" : "text-slate-500")}>
                          {modeReason.trim().length} characters · 5 minimum
                        </span>
                      </div>
                      <textarea
                        value={modeReason}
                        rows={2}
                        maxLength={240}
                        onChange={(event) => {
                          setModeReason(event.target.value);
                          setModeError("");
                        }}
                        placeholder="Explain why this access change is needed"
                        className="min-h-[68px] w-full resize-y rounded-[10px] border border-slate-300 bg-white px-3 py-2.5 text-[12.5px] font-semibold leading-relaxed text-slate-900 outline-none transition-colors placeholder:font-medium placeholder:text-slate-400 focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                      />
                    </label>

                    <button
                      type="button"
                      onClick={() => void reviewBusinessModeChange()}
                      disabled={modeBusy || defaultsDirty || modeReason.trim().length < 5}
                      className="inline-flex h-11 w-full shrink-0 items-center justify-center gap-1.5 rounded-[10px] bg-slate-950 px-5 text-[12.5px] font-extrabold text-white shadow-2xs transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50 sm:h-10 sm:w-auto"
                    >
                      <Icon name="check_circle" sizePx={16} />
                      <span>{modeBusy ? "Checking…" : "Review & Apply"}</span>
                    </button>
                  </div>

                  {defaultsDirty ? (
                    <div className="mt-2.5 text-[12px] font-bold text-amber-800">
                      Save or discard the unsaved defaults above before reviewing this access change.
                    </div>
                  ) : null}

                  {modeError ? (
                    <div className="mt-2.5 text-[12px] font-extrabold text-rose-700" role="alert">
                      {modeError}
                    </div>
                  ) : null}

                  {modePreflight && modePreflight.blockers.length > 0 ? (
                    <div className="mt-3 overflow-hidden rounded-[10px] border border-rose-300 bg-rose-50">
                      <div className="border-b border-rose-200 px-3.5 py-2.5">
                        <div className="text-[12.5px] font-extrabold text-rose-950">
                          {modePreflight.blockers.length} blocking workflow{modePreflight.blockers.length === 1 ? "" : "s"}
                        </div>
                        <div className="mt-0.5 text-[11.5px] font-medium text-rose-800">
                          Resolve these items before changing shop access.
                        </div>
                      </div>
                      <div className="divide-y divide-rose-200">
                        {modePreflight.blockers.map((blocker) => (
                          <div key={blocker.key} className="flex gap-3 px-3.5 py-2.5 text-[12px] text-rose-950">
                            <span className="font-black">{blocker.count}</span>
                            <span className="font-semibold">{blocker.message}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  </div>
                </div>
              ) : (
                <div className="mt-3.5 flex items-center justify-between rounded-[10px] border border-emerald-200/80 bg-emerald-50/50 px-3.5 py-2.5 text-[12px] font-semibold text-emerald-950">
                  <div className="flex items-center gap-2">
                    <Icon name="verified_user" sizePx={15} className="text-emerald-600" />
                    <span>
                      Current active mode: <strong className="font-black text-emerald-950">{formatBusinessMode(capabilities.businessMode)}</strong>. Click any capability mode above to stage a mode migration.
                    </span>
                  </div>
                  <span className="hidden rounded-full border border-emerald-300 bg-white px-2.5 py-0.5 text-[10px] font-extrabold text-emerald-800 shadow-2xs sm:inline-block">
                    Active
                  </span>
                </div>
              )}
            </div>

            <div className="rounded-[16px] border border-[#D8DBE0] bg-white p-5 shadow-2xs">
              <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-7 w-7 items-center justify-center rounded-[8px] bg-blue-50 text-[#2F67D8]">
                    <Icon name="inventory_2" sizePx={17} />
                  </div>
                  <h2 className="text-[16px] font-black text-[#11120D]">
                    Inventory & Pricing
                  </h2>
                </div>
                {!capabilities.inventoryEnabled ? <Pill tone="warning">Requires inventory</Pill> : null}
              </div>

              {!capabilities.inventoryEnabled ? (
                <div className="mb-5 rounded-[12px] border border-[#E5E7EB] bg-[#F8FAFC] p-3.5 text-[12px] font-semibold leading-relaxed text-[#64748B]">
                  Stock defaults are locked in Catalog only. Saved values remain preserved,
                  and new products will not claim stock until inventory is enabled and an
                  opening count is completed.
                </div>
              ) : null}

              <div className="space-y-4">
                <BusinessNumberField
                  fieldKey="defaultInitialStock"
                  label="New product initial stock"
                  helper="Fallback used only when inventory is enabled. Keep it aligned with physically counted stock."
                  value={defaultInitialStock}
                  onChange={(value) => {
                    setDefaultInitialStock(value);
                    setDefaultsSaveError("");
                  }}
                  disabled={!capabilities.inventoryEnabled}
                  error={capabilities.inventoryEnabled && defaultsShowErrors ? defaultsErrors.defaultInitialStock : undefined}
                  suffix="units"
                />
                <BusinessNumberField
                  fieldKey="defaultLowStock"
                  label="Stock alert threshold"
                  helper="Products at or below this quantity appear in low-stock alerts."
                  value={defaultLowStock}
                  onChange={(value) => {
                    setDefaultLowStock(value);
                    setDefaultsSaveError("");
                  }}
                  disabled={!capabilities.inventoryEnabled}
                  error={capabilities.inventoryEnabled && defaultsShowErrors ? defaultsErrors.defaultLowStock : undefined}
                  suffix="units"
                />
                <BusinessNumberField
                  fieldKey="wholesaleQtyThreshold"
                  label="Wholesale quantity threshold / थोक सीमा"
                  helper="Default minimum quantity required to use the wholesale price."
                  value={wholesaleQtyThreshold}
                  onChange={(value) => {
                    setWholesaleQtyThreshold(value);
                    setDefaultsSaveError("");
                  }}
                  error={defaultsShowErrors ? defaultsErrors.wholesaleQtyThreshold : undefined}
                  suffix="units"
                />
                <BusinessNumberField
                  fieldKey="loyaltyDiscountPercent"
                  label="Loyalty discount"
                  helper={capabilities.posEnabled
                    ? "System-wide default for loyalty-eligible customers."
                    : "Available when Full POS is enabled. The saved value is preserved."}
                  value={loyaltyDiscountPercent}
                  onChange={(value) => {
                    setLoyaltyDiscountPercent(value);
                    setDefaultsSaveError("");
                  }}
                  disabled={!capabilities.posEnabled}
                  error={capabilities.posEnabled && defaultsShowErrors ? defaultsErrors.loyaltyDiscountPercent : undefined}
                  suffix="%"
                />
              </div>
            </div>

            <div className="rounded-[16px] border border-[#D8DBE0] bg-white p-5 shadow-2xs">
              <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-7 w-7 items-center justify-center rounded-[8px] bg-slate-100 text-[#11120D]">
                    <Icon name="tune" sizePx={17} />
                  </div>
                  <h2 className="text-[16px] font-black text-[#11120D]">
                    Operational Limits
                  </h2>
                </div>
                {!capabilities.posEnabled ? <Pill tone="warning">Requires Full POS</Pill> : null}
              </div>

              {!capabilities.posEnabled ? (
                <div className="mb-5 rounded-[12px] border border-[#E5E7EB] bg-[#F8FAFC] p-3.5 text-[12px] font-semibold leading-relaxed text-[#64748B]">
                  Billing time limits are locked while POS is off. Their saved values remain
                  available for the next time Full POS is enabled.
                </div>
              ) : null}

              <div className="space-y-4">
                <BusinessNumberField
                  fieldKey="returnWindowDays"
                  label="Return window"
                  helper="Number of days after purchase during which a return is permitted."
                  value={returnWindowDays}
                  onChange={(value) => {
                    setReturnWindowDays(value);
                    setDefaultsSaveError("");
                  }}
                  disabled={!capabilities.posEnabled}
                  error={capabilities.posEnabled && defaultsShowErrors ? defaultsErrors.returnWindowDays : undefined}
                  suffix="days"
                  integer
                />
                <BusinessNumberField
                  fieldKey="parkedBillExpiryHours"
                  label="Parked bill expiry"
                  helper="Hours before an unfinished parked bill is automatically cleared."
                  value={parkedBillExpiryHours}
                  onChange={(value) => {
                    setParkedBillExpiryHours(value);
                    setDefaultsSaveError("");
                  }}
                  disabled={!capabilities.posEnabled}
                  error={capabilities.posEnabled && defaultsShowErrors ? defaultsErrors.parkedBillExpiryHours : undefined}
                  suffix="hours"
                  integer
                />
                <BusinessNumberField
                  fieldKey="draftRequestExpiryMinutes"
                  label="Staff draft request expiry"
                  helper="Minutes before an unanswered staff billing request expires."
                  value={draftRequestExpiryMinutes}
                  onChange={(value) => {
                    setDraftRequestExpiryMinutes(value);
                    setDefaultsSaveError("");
                  }}
                  disabled={!capabilities.posEnabled}
                  error={capabilities.posEnabled && defaultsShowErrors ? defaultsErrors.draftRequestExpiryMinutes : undefined}
                  suffix="minutes"
                  integer
                />
              </div>
            </div>
          </section>
        ) : null}

        {tab === "drawer" ? (
          <section className="grid grid-cols-1 gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
            <div className="rounded-[8px] border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-5 flex items-center justify-between">
                <h2 className="text-[17px] font-extrabold text-slate-800">
                  Current Session
                </h2>
                <span
                  className={cn(
                    "rounded-[8px] px-3 py-2 text-[12px] font-extrabold uppercase",
                    currentDrawer
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-slate-100 text-slate-600",
                  )}
                >
                  {currentDrawer ? "Open" : "Closed"}
                </span>
              </div>

              {currentDrawer ? (
                <div className="rounded-[8px] border border-slate-100 bg-slate-50 p-5">
                  <div className="text-[13px] font-extrabold uppercase tracking-[0.18em] text-slate-500">
                    Expected Balance
                  </div>
                  <div className="mt-3 text-[32px] font-black leading-none text-slate-800">
                    Rs.{" "}
                    {Number(currentDrawer.expectedTotal || 0).toLocaleString()}
                  </div>
                  <div className="mt-6 space-y-2 border-t border-slate-200 pt-4 text-[14px] font-medium text-slate-500">
                    <div className="flex justify-between gap-4">
                      <span>Started with:</span>
                      <span className="font-extrabold text-slate-600">
                        Rs.{" "}
                        {Number(
                          currentDrawer.openingFloat || 0,
                        ).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span>Opened at:</span>
                      <span className="font-extrabold text-slate-600">
                        {formatDateTime(currentDrawer.openedAt)}
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-[8px] border border-dashed border-slate-200 bg-slate-50 p-5 text-center">
                  <div className="text-[16px] font-extrabold">
                    Drawer is closed
                  </div>
                  <div className="mt-1 text-[14px] font-medium text-slate-500">
                    Open a session before recording cash movement.
                  </div>
                </div>
              )}

              <div className="mt-5 grid grid-cols-2 gap-3">
                {currentDrawer ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setDrawerAction("cash-in")}
                      className="flex h-[82px] flex-col items-center justify-center gap-2 rounded-[8px] border border-slate-200 bg-white text-[14px] font-extrabold transition hover:bg-slate-100"
                    >
                      <Icon
                        name="south_west"
                        sizePx={28}
                        className="text-emerald-600"
                      />
                      Cash In
                    </button>
                    <button
                      type="button"
                      onClick={() => setDrawerAction("cash-out")}
                      className="flex h-[82px] flex-col items-center justify-center gap-2 rounded-[8px] border border-slate-200 bg-white text-[14px] font-extrabold transition hover:bg-slate-100"
                    >
                      <Icon
                        name="north_east"
                        sizePx={28}
                        className="text-rose-600"
                      />
                      Cash Out
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setDrawerAction("open")}
                    className="col-span-2 h-11 rounded-[8px] bg-slate-900 text-[14px] font-extrabold text-white transition hover:bg-slate-800"
                  >
                    Open Drawer
                  </button>
                )}
              </div>

              {currentDrawer ? (
                <button
                  type="button"
                  onClick={() => setDrawerAction("close")}
                  className="mt-4 h-11 w-full rounded-[8px] bg-slate-900 text-[14px] font-extrabold text-white transition hover:bg-slate-800"
                >
                  Close Drawer
                </button>
              ) : null}

              {drawerError ? (
                <div className="mt-4 rounded-[14px] border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] font-bold text-rose-700">
                  {drawerError}
                </div>
              ) : null}
            </div>

            <div className="overflow-hidden rounded-[8px] border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center justify-between px-5 py-4">
                <h2 className="text-[17px] font-extrabold text-slate-800">
                  History
                </h2>
                <button
                  type="button"
                  onClick={() => setDrawerHistoryExpanded((value) => !value)}
                  className="inline-flex h-9 items-center rounded-[8px] border border-slate-200 bg-white px-3 text-[12px] font-extrabold text-slate-700 transition hover:bg-slate-100"
                >
                  {drawerHistoryExpanded ? "Show Less" : "View All"}
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[600px] border-collapse text-left">
                  <thead className="bg-[#F8FAFC] text-[11px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
                    <tr>
                      <th className="px-4 py-3">Date</th>
                      <th className="px-4 py-3">Opened By</th>
                      <th className="px-4 py-3">Opening</th>
                      <th className="px-4 py-3">Closing</th>
                      <th className="px-4 py-3 text-right">Diff</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleDrawerHistory.map((drawer) => (
                      <tr
                        key={drawer.id}
                        className="border-b border-[#E5E7EB] transition-colors hover:bg-[#ECEFF3] last:border-0"
                      >
                        <td className="px-4 py-3">
                          <div className="text-[13px] font-extrabold text-slate-950">
                            {new Date(drawer.openedAt).toLocaleDateString(
                              undefined,
                              {
                                month: "short",
                                day: "2-digit",
                                year: "numeric",
                              },
                            )}
                          </div>
                          <div className="mt-1 text-[12px] font-medium text-slate-500">
                            {new Date(drawer.openedAt).toLocaleTimeString(
                              undefined,
                              {
                                hour: "2-digit",
                                minute: "2-digit",
                              },
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-[13px] font-semibold text-slate-900">
                          {drawer.cashier?.name || "Cashier"}
                        </td>
                        <td className="px-4 py-3 font-mono text-[13px] font-extrabold text-slate-900">
                          Rs.{" "}
                          {Number(drawer.openingFloat || 0).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 font-mono text-[13px] font-extrabold text-slate-900">
                          {drawer.actualTotal === null ||
                            drawer.actualTotal === undefined
                            ? "-"
                            : `Rs. ${Number(drawer.actualTotal || 0).toLocaleString()}`}
                        </td>
                        <td
                          className={cn(
                            "px-4 py-3 text-right font-mono text-[13px] font-extrabold",
                            Number(drawer.difference || 0) < 0
                              ? "text-rose-600"
                              : Number(drawer.difference || 0) > 0
                                ? "text-emerald-600"
                                : "text-emerald-600",
                          )}
                        >
                          {drawer.difference === null ||
                            drawer.difference === undefined
                            ? "-"
                            : Number(drawer.difference) === 0
                              ? "-"
                              : `${Number(drawer.difference) > 0 ? "+" : ""}${Number(
                                drawer.difference,
                              ).toLocaleString()}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="space-y-3 p-5 sm:hidden">
                {visibleDrawerHistory.map((drawer) => (
                  <div
                    key={drawer.id}
                    className="rounded-[16px] border border-slate-200 bg-white p-4"
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="font-extrabold text-slate-950">
                          {drawer.cashier?.name || "Cashier"}
                        </div>
                        <div className="mt-1 text-[12px] font-semibold text-slate-500">
                          {formatDateTime(drawer.openedAt)}
                        </div>
                      </div>
                      <Pill
                        tone={drawer.status === "OPEN" ? "success" : "neutral"}
                      >
                        {drawer.status}
                      </Pill>
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-2 text-[12px] font-semibold">
                      <span>
                        Opening: Rs.{" "}
                        {Number(drawer.openingFloat || 0).toLocaleString()}
                      </span>
                      <span>
                        Expected: Rs.{" "}
                        {Number(drawer.expectedTotal || 0).toLocaleString()}
                      </span>
                      <span>
                        Closing:{" "}
                        {drawer.actualTotal === null ||
                          drawer.actualTotal === undefined
                          ? "-"
                          : `Rs. ${Number(drawer.actualTotal || 0).toLocaleString()}`}
                      </span>
                      <span>
                        Diff:{" "}
                        {drawer.difference === null ||
                          drawer.difference === undefined
                          ? "-"
                          : Number(drawer.difference).toLocaleString()}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        ) : null}

        {tab === "cashier-controls" ? (
          <section className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
            <div className="self-start rounded-[8px] border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-5 flex items-center gap-3">
                <Icon name="key" sizePx={24} className="text-amber-500" />
                <h2 className="text-[17px] font-extrabold text-slate-800">
                  Override PIN
                </h2>
              </div>
              <div className="rounded-[8px] border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] font-bold leading-5 text-amber-800">
                Required for cashier price overrides and sensitive voids.
              </div>
              <label className="mt-5 block">
                <span className="text-[13px] font-extrabold uppercase tracking-wide text-slate-500">
                  4-digit PIN
                </span>
                <div className="mt-2 flex gap-3">
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={4}
                    value={overridePinDraft}
                    onChange={(event) => {
                      setOverridePinDraft(
                        event.target.value.replace(/\D/g, "").slice(0, 4),
                      );
                      setOverridePinError("");
                    }}
                    placeholder="0000"
                    className="h-11 min-w-0 flex-1 rounded-[8px] border border-slate-200 px-4 text-center text-[17px] font-black tracking-[10px] outline-none focus:border-blue-600"
                  />
                  <button
                    type="button"
                    disabled={
                      savingOverridePin || overridePinDraft.length !== 4
                    }
                    onClick={() => setShowOverridePinConfirm(true)}
                    className="h-11 rounded-[8px] bg-slate-950 px-5 text-[13px] font-extrabold text-white transition hover:bg-slate-800 disabled:opacity-40"
                  >
                    {savingOverridePin ? "..." : "Set"}
                  </button>
                </div>
              </label>
              {overridePinError ? (
                <div className="mt-3 text-[13px] font-extrabold text-rose-600">
                  {overridePinError}
                </div>
              ) : null}
              <div className="mt-4 text-[12px] italic text-slate-400">
                {overridePolicy.pinUpdatedAt
                  ? `Last updated: ${formatDateTime(overridePolicy.pinUpdatedAt)}`
                  : "PIN has not been configured yet."}
              </div>
            </div>

            <div className="overflow-hidden rounded-[8px] border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center justify-between px-5 py-4">
                <h2 className="text-[17px] font-extrabold text-slate-800">
                  Users ({cashierPrivileges.length})
                </h2>
                <div className="flex items-center gap-2 text-[12px] font-extrabold uppercase text-slate-500">
                  <span className="h-3 w-3 rounded-full bg-blue-500" />
                  Authorized:{" "}
                  {
                    cashierPrivileges.filter((row) =>
                      permissionDisplay.some(([key]) =>
                        Boolean((row.privilege as any)[key]),
                      ),
                    ).length
                  }
                </div>
              </div>
              <div className="hidden overflow-x-auto lg:block">
                <table className="w-full min-w-[700px] border-collapse text-left">
                  <thead className="bg-[#F8FAFC] text-[11px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
                    <tr>
                      <th className="px-4 py-3">User</th>
                      <th className="px-4 py-3">Role</th>
                      <th className="px-4 py-3">Permissions</th>
                      <th className="px-4 py-3">Max Discounts</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedCashierPrivileges.map((cashier) => (
                      <tr
                        key={cashier.id}
                        className="border-b border-[#E5E7EB] transition-colors hover:bg-[#ECEFF3] last:border-0"
                      >
                        <td className="px-4 py-3">
                          <div className="text-[13px] font-extrabold text-slate-950">
                            {cashier.name}
                          </div>
                          <div className="mt-1 text-[12px] text-slate-500">
                            {cashier.email ||
                              cashier.phone ||
                              "No sign-in contact"}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <Pill
                            tone={
                              cashier.role === "MANAGER"
                                ? "info"
                                : cashier.role === "STAFF"
                                  ? "warning"
                                  : "neutral"
                            }
                          >
                            {roleLabel(cashier.role)}
                          </Pill>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-2">
                            {permissionDisplay
                              .filter(([key]) =>
                                Boolean((cashier.privilege as any)[key]),
                              )
                              .map(([key, label]) => (
                                <span
                                  key={key}
                                  className="rounded-[6px] bg-blue-50 px-2 py-1 text-[11px] font-extrabold text-blue-700"
                                >
                                  {label}
                                </span>
                              ))}
                            {permissionDisplay.every(
                              ([key]) =>
                                !Boolean((cashier.privilege as any)[key]),
                            ) ? (
                              <span className="text-[12px] font-semibold text-slate-400">
                                No permissions
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-[12px] leading-5 text-slate-500">
                          <div>
                            Loyalty:{" "}
                            <span className="text-slate-950 font-semibold">
                              {cashier.privilege.maxCustomerLoyaltyPercent}%
                            </span>
                          </div>
                          <div className="mt-1">
                            Wholesale:{" "}
                            <span className="text-slate-950 font-semibold">
                              {cashier.privilege.maxCustomerWholesalePercent}%
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => openCashierEdit(cashier)}
                            className="inline-flex h-9 items-center justify-center rounded-[8px] border border-slate-300 bg-white px-3 text-[12px] font-extrabold text-slate-700 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                          >
                            Edit
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="space-y-3 p-5 lg:hidden">
                {pagedCashierPrivileges.map((cashier) => (
                  <div
                    key={cashier.id}
                    className="rounded-[8px] border border-slate-200 bg-white p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-extrabold">{cashier.name}</div>
                        <div className="text-[13px] text-slate-500">
                          {cashier.email ||
                            cashier.phone ||
                            "No sign-in contact"}
                        </div>
                        <div className="mt-2">
                          <Pill
                            tone={
                              cashier.role === "MANAGER"
                                ? "info"
                                : cashier.role === "STAFF"
                                  ? "warning"
                                  : "neutral"
                            }
                          >
                            {roleLabel(cashier.role)}
                          </Pill>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => openCashierEdit(cashier)}
                        className="inline-flex h-9 items-center justify-center rounded-[8px] border border-slate-300 bg-white px-3 text-[12px] font-extrabold text-slate-700"
                      >
                        Edit
                      </button>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {permissionDisplay
                        .filter(([key]) =>
                          Boolean((cashier.privilege as any)[key]),
                        )
                        .map(([key, label]) => (
                          <span
                            key={key}
                            className="rounded-[6px] bg-blue-50 px-2 py-1 text-[11px] font-extrabold text-blue-700"
                          >
                            {label}
                          </span>
                        ))}
                    </div>
                  </div>
                ))}
              </div>
              <PaginationBar
                variant="classic"
                page={userManagementPageClamped}
                totalPages={userManagementTotalPages}
                total={cashierPrivileges.length}
                start={userManagementPageStart}
                end={userManagementPageEnd}
                label="users"
                pageSize={userManagementPageSize}
                onPageChange={setUserManagementPage}
                onPageSizeChange={(nextPageSize) => {
                  setUserManagementPageSize(nextPageSize);
                  setUserManagementPage(1);
                }}
                className="rounded-none border-x-0 border-b-0 border-slate-200"
              />
            </div>
          </section>
        ) : null}

        {tab === "brands" ? (
          <section className="overflow-hidden rounded-[14px] border border-[#D8DBE0] bg-white shadow-2xs">
            <div className="flex flex-col gap-3 border-b border-[#E5E7EB] bg-white p-3.5 sm:flex-row sm:items-center sm:justify-between sm:p-4">
              <div className="flex w-full items-center gap-2 sm:max-w-[440px]">
                <div className="relative flex-1">
                  <Icon
                    name="search"
                    sizePx={18}
                    className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"
                  />
                  <input
                    value={brandQuery}
                    onChange={(event) => setBrandQuery(event.target.value)}
                    placeholder="Search brands..."
                    className="h-10 w-full rounded-[10px] border border-[#D4D7DC] bg-white pl-10 pr-4 text-[13px] font-medium outline-none focus:border-[#11120D]"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => {
                    resetBrandForm();
                    setShowBrandForm(true);
                  }}
                  className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-[10px] bg-[#11120D] px-3.5 text-[12.5px] font-extrabold text-white shadow-2xs transition active:scale-98 sm:hidden"
                >
                  <Icon name="add" sizePx={18} />
                  <span>Add</span>
                </button>
              </div>

              <div className="flex w-full items-center justify-between gap-3 sm:w-auto">
                <MobileFilterTabs
                  className="w-full sm:hidden"
                  ariaLabel="Brand status"
                  value={brandFilter}
                  onChange={setBrandFilter}
                  items={(["all", "active", "inactive"] as const).map(
                    (value) => ({
                      value,
                      label: value[0].toUpperCase() + value.slice(1),
                    }),
                  )}
                />

                <div className="hidden items-center gap-2.5 sm:flex">
                  <div className="inline-flex rounded-[8px] border border-[#D4D7DC] bg-white p-1">
                    {(["all", "active", "inactive"] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setBrandFilter(value)}
                        className={cn(
                          "rounded-[6px] px-3.5 py-1 text-[12.5px] font-extrabold capitalize transition",
                          brandFilter === value
                            ? "bg-[#11120D] text-white"
                            : "text-[#64748B] hover:text-[#11120D]",
                        )}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      resetBrandForm();
                      setShowBrandForm(true);
                    }}
                    className="inline-flex h-9 items-center justify-center gap-1.5 rounded-[8px] bg-[#11120D] px-3.5 text-[12.5px] font-extrabold text-white shadow-2xs transition hover:bg-[#2A2C27] active:scale-98"
                  >
                    <Icon name="add" sizePx={17} />
                    <span>Add Brand</span>
                  </button>
                </div>
              </div>
            </div>
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[600px] border-collapse text-left">
                <thead className="bg-[#F8FAFC] text-[11px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
                  <tr>
                    <th className="px-4 py-3">Brand Name</th>
                    <th className="px-4 py-3">Products</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedBrands.map((brand) => {
                    const stats = brandStats[brand.id] || {
                      total: 0,
                      active: 0,
                      low: 0,
                    };
                    return (
                      <tr
                        key={brand.id}
                        className="border-b border-[#E5E7EB] transition-colors hover:bg-[#ECEFF3] last:border-0"
                      >
                        <td className="px-4 py-3 text-[13px] font-extrabold text-slate-950">
                          {brand.name}
                        </td>
                        <td className="px-4 py-3">
                          <span className="rounded-[6px] bg-slate-100 px-2 py-1 text-[11px] font-extrabold text-slate-600">
                            {stats.total} items
                          </span>
                          <span className="ml-2 text-[11px] font-semibold text-slate-400">
                            {stats.active} active
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={cn(
                              "rounded-[6px] px-2 py-1 text-[10px] font-extrabold uppercase",
                              brand.active
                                ? "bg-emerald-100 text-emerald-700"
                                : "bg-slate-100 text-slate-500",
                            )}
                          >
                            {brand.active ? "Active" : "Inactive"}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setEditingBrand(brand);
                                setBrandName(brand.name);
                                setBrandActive(brand.active);
                                setBrandError("");
                                setShowBrandForm(true);
                              }}
                              className="inline-flex h-9 items-center justify-center rounded-[8px] border border-slate-300 bg-white px-3 text-[12px] font-extrabold text-slate-700 transition hover:bg-slate-100"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => requestToggleBrandStatus(brand)}
                              disabled={brand.active && stats.active > 0}
                              title={
                                brand.active && stats.active > 0
                                  ? "Reassign or deactivate linked products first"
                                  : undefined
                              }
                              className={cn(
                                "inline-flex h-9 items-center justify-center rounded-[8px] border px-3 text-[12px] font-extrabold transition",
                                brand.active
                                  ? "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
                                  : "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100",
                                brand.active && stats.active > 0 &&
                                "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400 hover:bg-slate-100",
                              )}
                            >
                              {brand.active
                                ? stats.active > 0
                                  ? "In use"
                                  : "Deactivate"
                                : "Activate"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="space-y-3 p-5 sm:hidden">
              {pagedBrands.map((brand) => {
                const stats = brandStats[brand.id] || {
                  total: 0,
                  active: 0,
                  low: 0,
                };
                return (
                  <div
                    key={brand.id}
                    className="rounded-[8px] border border-slate-200 bg-white p-4"
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="font-extrabold">{brand.name}</div>
                        <div className="text-[13px] text-slate-500">
                          {stats.total} items | {stats.active} active
                        </div>
                      </div>
                      <Pill tone={brand.active ? "success" : "neutral"}>
                        {brand.active ? "Active" : "Inactive"}
                      </Pill>
                    </div>
                    <div className="mt-4 flex items-center justify-end gap-2 border-t border-slate-100 pt-3">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingBrand(brand);
                          setBrandName(brand.name);
                          setBrandActive(brand.active);
                          setBrandError("");
                          setShowBrandForm(true);
                        }}
                        className="inline-flex h-9 items-center justify-center rounded-[8px] border border-slate-300 bg-white px-3 text-[12px] font-extrabold text-slate-700"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => requestToggleBrandStatus(brand)}
                        disabled={brand.active && stats.active > 0}
                        className={cn(
                          "inline-flex h-9 items-center justify-center rounded-[8px] border px-3 text-[12px] font-extrabold",
                          brand.active
                            ? "border-rose-200 bg-rose-50 text-rose-700"
                            : "border-emerald-200 bg-emerald-50 text-emerald-700",
                          brand.active && stats.active > 0 &&
                          "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400",
                        )}
                      >
                        {brand.active
                          ? stats.active > 0
                            ? "In use"
                            : "Deactivate"
                          : "Activate"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <PaginationBar
              variant="classic"
              page={brandPageClamped}
              totalPages={brandTotalPages}
              total={filteredBrands.length}
              start={brandPageStart}
              end={brandPageEnd}
              label="brands"
              pageSize={brandPageSize}
              onPageChange={setBrandPage}
              onPageSizeChange={(nextPageSize) => {
                setBrandPageSize(nextPageSize);
                setBrandPage(1);
              }}
              className="rounded-none border-x-0 border-b-0 border-slate-200"
            />
          </section>
        ) : null}

        {tab === "audit" ? (
          <section className="overflow-hidden rounded-[14px] border border-[#D8DBE0] bg-white shadow-2xs">
            {/* Sub-Tab Navigation Header with Segmented Buttons & Mobile Filter Trigger */}
            <div className="flex items-center justify-between border-b border-[#E5E7EB] bg-white p-3 sm:p-4">
              <div className="inline-flex w-full sm:w-auto rounded-[10px] border border-[#D4D7DC] bg-[#F1F3F5] p-1 shadow-2xs">
                <button
                  type="button"
                  onClick={() => setSecuritySubTab("audit")}
                  className={cn(
                    "flex flex-1 sm:flex-initial items-center justify-center gap-2 rounded-[7px] px-4 py-2 text-[13px] font-extrabold transition-all",
                    securitySubTab === "audit"
                      ? "bg-white text-[#11120D] shadow-xs"
                      : "text-[#64748B] hover:text-[#11120D]",
                  )}
                >
                  <span>Audit Logs</span>
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-0.2 text-[10.5px] font-black",
                      securitySubTab === "audit"
                        ? "bg-[#11120D] text-white"
                        : "bg-[#E2E8F0] text-[#64748B]",
                    )}
                  >
                    {auditTotal}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setSecuritySubTab("login")}
                  className={cn(
                    "flex flex-1 sm:flex-initial items-center justify-center gap-2 rounded-[7px] px-4 py-2 text-[13px] font-extrabold transition-all",
                    securitySubTab === "login"
                      ? "bg-white text-[#11120D] shadow-xs"
                      : "text-[#64748B] hover:text-[#11120D]",
                  )}
                >
                  <span>Login Activity</span>
                  {failedLoginCount > 0 ? (
                    <span className="rounded-full bg-rose-100 px-1.5 py-0.2 text-[10.5px] font-black text-rose-700">
                      {failedLoginCount} failed
                    </span>
                  ) : (
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.2 text-[10.5px] font-black",
                        securitySubTab === "login"
                          ? "bg-[#11120D] text-white"
                          : "bg-[#E2E8F0] text-[#64748B]",
                      )}
                    >
                      {loginTotal}
                    </span>
                  )}
                </button>
              </div>

              {/* Mobile Filter Button (opens bottom sheet) */}
              <div className="hidden sm:block lg:hidden ml-3">
                <MobileFilterButton
                  activeCount={mobileSecurityFilterCount}
                  onClick={openMobileSecurityFilters}
                />
              </div>
            </div>

            {/* Mobile Filter Bar Row (Mobile only) */}
            <div className="flex items-center justify-between gap-2.5 border-b border-[#E5E7EB] bg-[#F8FAFC] px-3.5 py-2.5 sm:hidden">
              <span className="text-[12px] font-bold text-[#64748B]">
                {securitySubTab === "audit"
                  ? `${auditTotal} audit events`
                  : `${loginTotal} login attempts`}
              </span>
              <MobileFilterButton
                activeCount={mobileSecurityFilterCount}
                onClick={openMobileSecurityFilters}
              />
            </div>

            {/* Desktop Inline Filter Toolbar */}
            <div className="hidden border-b border-[#E5E7EB] bg-[#F8FAFC] p-4 lg:block">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                {securitySubTab === "audit" ? (
                  <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <label className="space-y-1">
                      <span className="text-[10.5px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
                        From Date
                      </span>
                      <ProjectDateInput
                        value={securityDateDraft.from}
                        onChange={(event) =>
                          setSecurityDateDraft((current) => ({
                            ...current,
                            from: event.target.value,
                          }))
                        }
                        className="h-9.5 w-full rounded-[8px] border border-[#D4D7DC] bg-white px-3 text-[12.5px] font-semibold text-[#11120D] outline-none focus:border-[#11120D]"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10.5px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
                        To Date
                      </span>
                      <ProjectDateInput
                        value={securityDateDraft.to}
                        onChange={(event) =>
                          setSecurityDateDraft((current) => ({
                            ...current,
                            to: event.target.value,
                          }))
                        }
                        className="h-9.5 w-full rounded-[8px] border border-[#D4D7DC] bg-white px-3 text-[12.5px] font-semibold text-[#11120D] outline-none focus:border-[#11120D]"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10.5px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
                        Audit Action
                      </span>
                      <input
                        value={securityAuditActionDraft}
                        onChange={(event) =>
                          setSecurityAuditActionDraft(event.target.value)
                        }
                        placeholder="e.g. INVOICE, PRODUCT"
                        className="h-9.5 w-full rounded-[8px] border border-[#D4D7DC] bg-white px-3 text-[12.5px] font-semibold text-[#11120D] outline-none focus:border-[#11120D]"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10.5px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
                        Entity Type
                      </span>
                      <input
                        value={securityEntityDraft}
                        onChange={(event) =>
                          setSecurityEntityDraft(event.target.value)
                        }
                        placeholder="Invoice, Product, Brand..."
                        className="h-9.5 w-full rounded-[8px] border border-[#D4D7DC] bg-white px-3 text-[12.5px] font-semibold text-[#11120D] outline-none focus:border-[#11120D]"
                      />
                    </label>
                  </div>
                ) : (
                  <div className="grid flex-1 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <label className="space-y-1">
                      <span className="text-[10.5px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
                        Date Range
                      </span>
                      <div className="grid grid-cols-2 gap-2">
                        <ProjectDateInput
                          value={securityDateDraft.from}
                          onChange={(event) =>
                            setSecurityDateDraft((current) => ({
                              ...current,
                              from: event.target.value,
                            }))
                          }
                          className="h-9.5 w-full rounded-[8px] border border-[#D4D7DC] bg-white px-2.5 text-[12px] font-semibold text-[#11120D] outline-none focus:border-[#11120D]"
                        />
                        <ProjectDateInput
                          value={securityDateDraft.to}
                          onChange={(event) =>
                            setSecurityDateDraft((current) => ({
                              ...current,
                              to: event.target.value,
                            }))
                          }
                          className="h-9.5 w-full rounded-[8px] border border-[#D4D7DC] bg-white px-2.5 text-[12px] font-semibold text-[#11120D] outline-none focus:border-[#11120D]"
                        />
                      </div>
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10.5px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
                        Login Account
                      </span>
                      <input
                        type="text"
                        value={securityLoginEmailDraft}
                        onChange={(event) =>
                          setSecurityLoginEmailDraft(event.target.value)
                        }
                        placeholder="Phone or email"
                        className="h-9.5 w-full rounded-[8px] border border-[#D4D7DC] bg-white px-3 text-[12.5px] font-semibold text-[#11120D] outline-none focus:border-[#11120D]"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10.5px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
                        Login Status
                      </span>
                      <ProjectSelect
                        value={securityLoginStatusDraft}
                        onChange={(event) =>
                          setSecurityLoginStatusDraft(
                            event.target.value as "ALL" | "SUCCESS" | "FAILED",
                          )
                        }
                        className="h-9.5 w-full rounded-[8px] border border-[#D4D7DC] bg-white px-3 text-[12.5px] font-semibold text-[#11120D] outline-none focus:border-[#11120D]"
                      >
                        <option value="ALL">All attempts</option>
                        <option value="SUCCESS">Successful</option>
                        <option value="FAILED">Failed</option>
                      </ProjectSelect>
                    </label>
                  </div>
                )}

                <div className="flex items-center gap-2 self-end sm:self-auto shrink-0 pt-1 lg:pt-5">
                  <button
                    type="button"
                    onClick={clearSecurityFilters}
                    className="inline-flex h-9.5 items-center justify-center rounded-[8px] border border-[#D4D7DC] bg-white px-3.5 text-[12px] font-bold text-[#374151] transition hover:bg-[#F3F4F6]"
                  >
                    Reset
                  </button>
                  <button
                    type="button"
                    onClick={applySecurityFilters}
                    className="inline-flex h-9.5 items-center justify-center gap-1.5 rounded-[8px] bg-[#11120D] px-4 text-[12px] font-extrabold text-white shadow-2xs transition hover:bg-[#2A2C27]"
                  >
                    <Icon name="filter_alt" sizePx={15} />
                    <span>Apply Filters</span>
                  </button>
                </div>
              </div>

              {securityFilterError ? (
                <div className="mt-3 rounded-[8px] border border-rose-200 bg-rose-50 px-3.5 py-2 text-[12px] font-bold text-rose-700">
                  {securityFilterError}
                </div>
              ) : null}
            </div>

            {/* Active Chips Bar */}
            {mobileSecurityFilterChips.length > 0 ? (
              <div className="border-b border-[#E5E7EB] bg-white px-4 py-2.5">
                <ActiveFilterChips
                  items={mobileSecurityFilterChips}
                />
              </div>
            ) : null}

            {/* Mobile Filter Drawer */}
            <MobileFilterSheet
              open={mobileSecurityFiltersOpen}
              onClose={closeMobileSecurityFilters}
              onClear={() => {
                setSecurityDateDraft(INITIAL_SECURITY_RANGE);
                setSecurityAuditActionDraft("");
                setSecurityEntityDraft("");
                setSecurityLoginEmailDraft("");
                setSecurityLoginStatusDraft("ALL");
                setSecurityFilterError("");
              }}
              onApply={() => {
                if (applySecurityFilters()) setMobileSecurityFiltersOpen(false);
              }}
              footerMessage={securityFilterError}
            >
              <div className="space-y-4">
                <div className="space-y-2">
                  <span className="text-[11.5px] font-extrabold uppercase tracking-wide text-slate-500">
                    Quick Date Presets
                  </span>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {[
                      { key: "today" as const, label: "Today" },
                      { key: "7d" as const, label: "Last 7 Days" },
                      { key: "30d" as const, label: "Last 30 Days" },
                      { key: "thisMonth" as const, label: "This Month" },
                    ].map((preset) => (
                      <button
                        key={preset.key}
                        type="button"
                        onClick={() => {
                          setSecurityDateDraft(getPresetDateRange(preset.key));
                          setSecurityFilterError("");
                        }}
                        className="rounded-[8px] border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] font-extrabold text-slate-700 transition hover:bg-slate-100 active:scale-95"
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="space-y-1.5">
                    <span className="text-[12px] font-bold text-slate-700">From date</span>
                    <ProjectDateInput
                      value={securityDateDraft.from}
                      max={securityDateDraft.to || undefined}
                      onChange={(event) =>
                        setSecurityDateDraft((current) => ({
                          ...current,
                          from: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label className="space-y-1.5">
                    <span className="text-[12px] font-bold text-slate-700">To date</span>
                    <ProjectDateInput
                      value={securityDateDraft.to}
                      min={securityDateDraft.from || undefined}
                      onChange={(event) =>
                        setSecurityDateDraft((current) => ({
                          ...current,
                          to: event.target.value,
                        }))
                      }
                    />
                  </label>
                </div>

                {securitySubTab === "audit" ? (
                  <>
                    <label className="block space-y-1.5">
                      <span className="text-[12px] font-bold text-slate-700">Audit action</span>
                      <input
                        value={securityAuditActionDraft}
                        onChange={(event) =>
                          setSecurityAuditActionDraft(event.target.value)
                        }
                        placeholder="e.g. INVOICE, PRODUCT"
                        className="h-10 w-full rounded-[10px] border border-slate-200 px-3 text-[13px] font-semibold outline-none focus:border-slate-900"
                      />
                    </label>
                    <label className="block space-y-1.5">
                      <span className="text-[12px] font-bold text-slate-700">Entity type</span>
                      <input
                        value={securityEntityDraft}
                        onChange={(event) =>
                          setSecurityEntityDraft(event.target.value)
                        }
                        placeholder="Invoice, Product, Brand..."
                        className="h-10 w-full rounded-[10px] border border-slate-200 px-3 text-[13px] font-semibold outline-none focus:border-slate-900"
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <label className="block space-y-1.5">
                      <span className="text-[12px] font-bold text-slate-700">Login account</span>
                      <input
                        type="text"
                        value={securityLoginEmailDraft}
                        onChange={(event) =>
                          setSecurityLoginEmailDraft(event.target.value)
                        }
                        placeholder="Phone or email"
                        className="h-10 w-full rounded-[10px] border border-slate-200 px-3 text-[13px] font-semibold outline-none focus:border-slate-900"
                      />
                    </label>
                    <label className="block space-y-1.5">
                      <span className="text-[12px] font-bold text-slate-700">Login status</span>
                      <ProjectSelect
                        value={securityLoginStatusDraft}
                        onChange={(event) =>
                          setSecurityLoginStatusDraft(
                            event.target.value as "ALL" | "SUCCESS" | "FAILED",
                          )
                        }
                      >
                        <option value="ALL">All attempts</option>
                        <option value="SUCCESS">Successful</option>
                        <option value="FAILED">Failed</option>
                      </ProjectSelect>
                    </label>
                  </>
                )}
              </div>
            </MobileFilterSheet>

            {/* Tab 1: Full-Width Audit Logs Table */}
            {securitySubTab === "audit" ? (
              <div>
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full min-w-[700px] border-collapse text-left">
                    <thead className="bg-[#F8FAFC] text-[11px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
                      <tr>
                        <th className="px-5 py-3">Action</th>
                        <th className="px-5 py-3">Entity</th>
                        <th className="px-5 py-3">Entity Type</th>
                        <th className="px-5 py-3">Actor</th>
                        <th className="px-5 py-3 text-right">Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditLogs.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="px-5 py-14 text-center">
                            <Icon
                              name="history"
                              sizePx={24}
                              className="mx-auto text-slate-300"
                            />
                            <div className="mt-2 text-[13px] font-extrabold text-[#11120D]">
                              No audit activity matches these filters
                            </div>
                            <div className="mt-0.5 text-[12px] font-medium text-[#64748B]">
                              Change or clear your filter criteria to inspect earlier events.
                            </div>
                          </td>
                        </tr>
                      ) : null}
                      {auditLogs.map((log) => (
                        <tr
                          key={log.id}
                          className="border-b border-[#E5E7EB] transition-colors hover:bg-[#ECEFF3] last:border-0"
                        >
                          <td className="px-5 py-3.5 text-[13px] font-black text-[#11120D]">
                            {log.action}
                          </td>
                          <td className="px-5 py-3.5">
                            <div className="text-[13px] font-bold text-[#11120D]">
                              {String(log.meta?.invoiceNo || log.entityType)}
                            </div>
                            <div className="mt-0.5 font-mono text-[11px] text-[#64748B]">
                              ID: {log.entityId}
                            </div>
                          </td>
                          <td className="px-5 py-3.5">
                            <span className="rounded-[6px] border border-[#D4D7DC] bg-[#F8FAFC] px-2 py-0.5 text-[11px] font-bold text-[#374151]">
                              {log.entityType}
                            </span>
                          </td>
                          <td className="px-5 py-3.5 text-[13px] font-semibold text-[#11120D]">
                            {log.actor?.name || "System"}
                          </td>
                          <td className="px-5 py-3.5 text-right">
                            <div className="text-[12.5px] font-bold text-[#11120D]">
                              {formatRelativeTime(log.createdAt)}
                            </div>
                            <div className="mt-0.5 text-[11px] font-medium text-[#64748B]">
                              {formatDateTime(log.createdAt)}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Mobile Cards for Audit Logs */}
                <div className="space-y-3 p-4 md:hidden">
                  {auditLogs.length === 0 ? (
                    <div className="py-10 text-center">
                      <Icon
                        name="history"
                        sizePx={22}
                        className="mx-auto text-slate-300"
                      />
                      <div className="mt-2 text-[13px] font-extrabold text-[#11120D]">
                        No audit activity matches these filters
                      </div>
                    </div>
                  ) : null}
                  {auditLogs.map((log) => (
                    <div
                      key={log.id}
                      className="rounded-[12px] border border-[#E5E7EB] bg-white p-3.5 shadow-2xs"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="text-[13.5px] font-black text-[#11120D]">
                            {log.action}
                          </div>
                          <div className="mt-1 text-[12px] font-semibold text-[#64748B]">
                            {String(log.meta?.invoiceNo || log.entityType)}
                          </div>
                        </div>
                        <span className="shrink-0 text-right text-[11px] font-extrabold text-[#64748B]">
                          {formatRelativeTime(log.createdAt)}
                        </span>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#F1F3F5] pt-2.5 text-[11.5px] font-semibold text-[#64748B]">
                        <span>Actor: <strong className="text-[#11120D]">{log.actor?.name || "System"}</strong></span>
                        <span className="font-mono text-[10.5px]">ID: {log.entityId.slice(0, 12)}…</span>
                      </div>
                    </div>
                  ))}
                </div>

                <PaginationBar
                  variant="classic"
                  page={auditPageClamped}
                  totalPages={auditTotalPages}
                  total={auditTotal}
                  start={auditPageStart}
                  end={auditPageEnd}
                  label="audit logs"
                  pageSize={auditPageSize}
                  onPageChange={setAuditPage}
                  onPageSizeChange={(nextPageSize) => {
                    setAuditPageSize(nextPageSize);
                    setAuditPage(1);
                  }}
                  className="rounded-none border-x-0 border-b-0 border-[#E5E7EB]"
                />
              </div>
            ) : (
              /* Tab 2: Full-Width Login Activity Table */
              <div>
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full min-w-[700px] border-collapse text-left">
                    <thead className="bg-[#F8FAFC] text-[11px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
                      <tr>
                        <th className="px-5 py-3">Account / User</th>
                        <th className="px-5 py-3">Status</th>
                        <th className="px-5 py-3">IP Address</th>
                        <th className="px-5 py-3 text-right">Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {loginAttempts.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-5 py-14 text-center">
                            <Icon
                              name="login"
                              sizePx={24}
                              className="mx-auto text-slate-300"
                            />
                            <div className="mt-2 text-[13px] font-extrabold text-[#11120D]">
                              No login activity matches these filters
                            </div>
                            <div className="mt-0.5 text-[12px] font-medium text-[#64748B]">
                              Try adjusting your account search or date parameters.
                            </div>
                          </td>
                        </tr>
                      ) : null}
                      {loginAttempts.map((attempt) => (
                        <tr
                          key={attempt.id}
                          className="border-b border-[#E5E7EB] transition-colors hover:bg-[#ECEFF3] last:border-0"
                        >
                          <td className="px-5 py-3.5 text-[13px] font-bold text-[#11120D]">
                            {attempt.email}
                          </td>
                          <td className="px-5 py-3.5">
                            <span
                              className={cn(
                                "inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-extrabold",
                                attempt.success
                                  ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
                                  : "bg-rose-50 text-rose-800 border border-rose-200",
                              )}
                            >
                              {attempt.success ? "Success" : "Failed"}
                            </span>
                          </td>
                          <td className="px-5 py-3.5 font-mono text-[12px] text-[#64748B]">
                            {attempt.ip || "127.0.0.1"}
                          </td>
                          <td className="px-5 py-3.5 text-right">
                            <div className="text-[12.5px] font-bold text-[#11120D]">
                              {formatRelativeTime(attempt.createdAt)}
                            </div>
                            <div className="mt-0.5 text-[11px] font-medium text-[#64748B]">
                              {formatDateTime(attempt.createdAt)}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Mobile Cards for Login Activity */}
                <div className="space-y-3 p-4 md:hidden">
                  {loginAttempts.length === 0 ? (
                    <div className="py-10 text-center">
                      <Icon
                        name="login"
                        sizePx={22}
                        className="mx-auto text-slate-300"
                      />
                      <div className="mt-2 text-[13px] font-extrabold text-[#11120D]">
                        No login activity matches these filters
                      </div>
                    </div>
                  ) : null}
                  {loginAttempts.map((attempt) => (
                    <div
                      key={attempt.id}
                      className="rounded-[12px] border border-[#E5E7EB] bg-white p-3.5 shadow-2xs"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-[13.5px] font-bold text-[#11120D]">
                            {attempt.email}
                          </div>
                          <div className="mt-0.5 font-mono text-[11px] text-[#64748B]">
                            {attempt.ip || "127.0.0.1"}
                          </div>
                        </div>
                        <span
                          className={cn(
                            "inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-extrabold",
                            attempt.success
                              ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
                              : "bg-rose-50 text-rose-800 border border-rose-200",
                          )}
                        >
                          {attempt.success ? "Success" : "Failed"}
                        </span>
                      </div>
                      <div className="mt-2.5 border-t border-[#F1F3F5] pt-2 text-[11.5px] font-semibold text-[#64748B]">
                        {formatRelativeTime(attempt.createdAt)} ({formatDateTime(attempt.createdAt)})
                      </div>
                    </div>
                  ))}
                </div>

                <PaginationBar
                  variant="classic"
                  page={loginPageClamped}
                  totalPages={loginTotalPages}
                  total={loginTotal}
                  start={loginPageStart}
                  end={loginPageEnd}
                  label="login attempts"
                  pageSize={loginPageSize}
                  onPageChange={setLoginPage}
                  onPageSizeChange={(nextPageSize) => {
                    setLoginPageSize(nextPageSize);
                    setLoginPage(1);
                  }}
                  className="rounded-none border-x-0 border-b-0 border-[#E5E7EB]"
                />
              </div>
            )}
          </section>
        ) : null}

        {tab === "backup" ? (
          <section className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
            <RecoveryBackupPanel
              status={recoveryBackupStatus}
              busy={recoveryBackupStatusBusy}
              onRefresh={refreshRecoveryBackupStatus}
            />
            <StorageIntegrityPanel
              report={storageIntegrityReport}
              busy={storageIntegrityBusy}
              error={storageIntegrityError}
              onRun={handleStorageIntegrityCheck}
            />
            <div className="space-y-5">
              <div className="rounded-[8px] border border-slate-200 bg-white p-5 shadow-sm">
                <div className="mb-4 flex items-center gap-3">
                  <Icon
                    name="cloud_download"
                    sizePx={22}
                    className="text-blue-600"
                  />
                  <h2 className="text-[17px] font-extrabold text-slate-800">
                    Database Export
                  </h2>
                </div>
                <p className="text-[13px] font-medium leading-5 text-slate-500">
                  Create a SQL-only export for quick database recovery. Product
                  images and protected documents are included only in the full
                  recovery backup above.
                </p>
                <button
                  type="button"
                  onClick={() => setShowBackupConfirm(true)}
                  disabled={backupBusy}
                  className="mt-5 h-11 w-full rounded-[8px] bg-slate-950 text-[13px] font-extrabold text-white transition hover:bg-slate-800 disabled:opacity-50"
                >
                  {backupBusy ? "Exporting..." : "Create Database Export"}
                </button>
              </div>

              <div className="rounded-[8px] border border-slate-200 bg-white p-5 shadow-sm">
                <div className="mb-5 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Icon
                      name="calendar_month"
                      sizePx={22}
                      className="text-violet-500"
                    />
                    <h2 className="text-[17px] font-extrabold text-slate-800">
                      Database Export Schedule
                    </h2>
                  </div>
                  <label className="relative inline-flex h-[30px] w-[58px] cursor-pointer items-center">
                    <input
                      type="checkbox"
                      checked={backupScheduleDraft.enabled}
                      onChange={(event) =>
                        setBackupScheduleDraft((current) => ({
                          ...current,
                          enabled: event.target.checked,
                        }))
                      }
                      className="peer sr-only"
                    />
                    <span className="h-full w-full rounded-full bg-slate-200 transition peer-checked:bg-blue-600" />
                    <span className="absolute left-1 h-[24px] w-[24px] rounded-full bg-white transition peer-checked:translate-x-[28px]" />
                  </label>
                </div>
                <label className="block">
                  <span className="text-[11px] font-extrabold uppercase tracking-[0.06em] text-slate-500">
                    Frequency
                  </span>
                  <ProjectSelect
                    value={backupScheduleDraft.frequency}
                    onChange={(event) =>
                      setBackupScheduleDraft((current) => ({
                        ...current,
                        frequency: event.target.value as "DAILY" | "WEEKLY",
                      }))
                    }
                    className="mt-2 h-11 w-full rounded-[8px] border border-slate-200 px-4 text-[14px] outline-none focus:border-blue-600"
                  >
                    <option value="DAILY">Daily</option>
                    <option value="WEEKLY">Weekly</option>
                  </ProjectSelect>
                </label>
                {backupScheduleDraft.frequency === "WEEKLY" ? (
                  <label className="mt-5 block">
                    <span className="text-[11px] font-extrabold uppercase tracking-[0.06em] text-slate-500">
                      Day
                    </span>
                    <ProjectSelect
                      value={backupScheduleDraft.dayOfWeek}
                      onChange={(event) =>
                        setBackupScheduleDraft((current) => ({
                          ...current,
                          dayOfWeek: Number(event.target.value),
                        }))
                      }
                      className="mt-2 h-11 w-full rounded-[8px] border border-slate-200 px-4 text-[14px] outline-none focus:border-blue-600"
                    >
                      {WEEKDAYS.map((day, index) => (
                        <option key={day} value={index}>
                          {day}
                        </option>
                      ))}
                    </ProjectSelect>
                  </label>
                ) : null}
                <label className="mt-5 block">
                  <span className="text-[11px] font-extrabold uppercase tracking-[0.06em] text-slate-500">
                    Time
                  </span>
                  <input
                    type="time"
                    value={backupScheduleDraft.timeOfDay}
                    onChange={(event) =>
                      setBackupScheduleDraft((current) => ({
                        ...current,
                        timeOfDay: event.target.value,
                      }))
                    }
                    className="mt-2 h-11 w-full rounded-[8px] border border-slate-200 px-4 text-[14px] outline-none focus:border-blue-600"
                  />
                </label>
                {backupScheduleError ? (
                  <div className="mt-4 rounded-[8px] border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] font-bold text-rose-700">
                    {backupScheduleError}
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={() => setShowBackupScheduleConfirm(true)}
                  disabled={backupScheduleBusy}
                  className="mt-5 h-11 w-full rounded-[8px] border border-slate-300 bg-white text-[13px] font-extrabold text-slate-800 transition hover:bg-slate-100"
                >
                  {backupScheduleBusy ? "Saving..." : "Update Schedule"}
                </button>
              </div>
            </div>

            <div className="overflow-hidden rounded-[8px] border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
                <h2 className="text-[17px] font-extrabold text-slate-800">
                  Database Export & Restore History
                </h2>
                <span className="rounded-[6px] bg-slate-100 px-3 py-1.5 text-[11px] font-extrabold text-slate-600">
                  {backupHistory.length} records
                </span>
              </div>
              {backupHistory.length === 0 ? (
                <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
                  <span className="flex h-12 w-12 items-center justify-center rounded-[8px] bg-slate-100 text-slate-500">
                    <Icon name="history" sizePx={22} />
                  </span>
                  <div className="mt-4 text-[15px] font-extrabold text-slate-900">
                    No database export activity yet
                  </div>
                  <p className="mt-1 max-w-sm text-[12px] font-medium leading-5 text-slate-500">
                    Database exports and database restore attempts will appear
                    here with their status, size, and completion details.
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowBackupConfirm(true)}
                    disabled={backupBusy}
                    className="mt-5 inline-flex h-10 items-center justify-center gap-2 rounded-[8px] bg-slate-950 px-4 text-[12px] font-extrabold text-white transition hover:bg-slate-800 disabled:opacity-50"
                  >
                    <Icon name="cloud_download" sizePx={17} />
                    Create database export
                  </button>
                </div>
              ) : null}
              <div
                className={cn(
                  "hidden overflow-x-auto md:block",
                  backupHistory.length === 0 && "md:hidden",
                )}
              >
                <table className="w-full min-w-[500px] border-collapse text-left">
                  <thead className="bg-[#F8FAFC] text-[11px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
                    <tr>
                      <th className="px-4 py-3">Type</th>
                      <th className="px-4 py-3">Details</th>
                      <th className="px-4 py-3 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {backupHistory.map((backup) => (
                      <tr
                        key={backup.id}
                        className="border-b border-[#E5E7EB] transition-colors hover:bg-[#ECEFF3] last:border-0"
                      >
                        <td className="px-4 py-3">
                          <span
                            className={cn(
                              "rounded-[8px] px-2 py-1 text-[10px] font-extrabold uppercase",
                              backup.type === "BACKUP"
                                ? "bg-blue-100 text-blue-700"
                                : "bg-violet-100 text-violet-700",
                            )}
                          >
                            {backup.type === "BACKUP" ? "Export" : "Restore"}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="text-[13px] font-extrabold text-slate-900">
                            {backup.filename || backup.message || "-"}
                          </div>
                          <div className="mt-1 text-[12px] font-semibold text-slate-500">
                            {formatDateTime(backup.createdAt)} |{" "}
                            {formatFileSize(backup.sizeBytes)} | {backup.status}
                          </div>
                          {backup.detail ? (
                            <div className="mt-1 text-[11px] font-semibold text-rose-600">
                              {backup.detail}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {backup.type === "BACKUP" &&
                            backup.status === "SUCCESS" ? (
                            <button
                              type="button"
                              onClick={() => requestRestoreBackup(backup)}
                              className="inline-flex h-9 items-center justify-center rounded-[8px] border border-rose-200 bg-rose-50 px-3 text-[12px] font-extrabold text-rose-700 transition hover:bg-rose-100"
                            >
                              Restore
                            </button>
                          ) : (
                            <span className="text-[11px] font-extrabold uppercase text-emerald-600">
                              {backup.status}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div
                className={cn(
                  "space-y-3 p-4 md:hidden",
                  backupHistory.length === 0 && "hidden",
                )}
              >
                {backupHistory.map((backup) => (
                  <div
                    key={backup.id}
                    className="rounded-[8px] border border-slate-200 bg-white p-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span
                        className={cn(
                          "rounded-[12px] border px-3 py-1 text-[11px] font-extrabold uppercase",
                          backup.type === "BACKUP"
                            ? "border-blue-100 bg-blue-50 text-blue-700"
                            : "border-violet-100 bg-violet-50 text-violet-700",
                        )}
                      >
                        {backup.type === "BACKUP" ? "Export" : "Restore"}
                      </span>
                      {backup.type === "BACKUP" &&
                        backup.status === "SUCCESS" ? (
                        <button
                          type="button"
                          onClick={() => requestRestoreBackup(backup)}
                          className="inline-flex h-9 items-center justify-center rounded-[8px] border border-rose-200 bg-rose-50 px-3 text-[12px] font-extrabold text-rose-700"
                        >
                          Restore
                        </button>
                      ) : (
                        <span className="text-[12px] font-extrabold uppercase text-emerald-600">
                          {backup.status}
                        </span>
                      )}
                    </div>
                    <div className="mt-3 text-[15px] font-extrabold text-slate-950">
                      {backup.filename || backup.message || "-"}
                    </div>
                    <div className="mt-1 text-[12px] font-semibold text-slate-500">
                      {formatDateTime(backup.createdAt)} |{" "}
                      {formatFileSize(backup.sizeBytes)} | {backup.status}
                    </div>
                    {backup.detail ? (
                      <div className="mt-2 text-[12px] font-semibold text-rose-600">
                        {backup.detail}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </section>
        ) : null}
      </main>

      {drawerAction ? (
        <ModalFrame
          open={!!drawerAction}
          onClose={() => {
            if (drawerBusy) return;
            setDrawerAction(null);
            setDrawerAmount("");
            setDrawerActualTotal("");
            setDrawerNote("");
          }}
          title={
            drawerAction === "open"
              ? "Open Drawer"
              : drawerAction === "cash-in"
                ? "Cash In"
                : drawerAction === "cash-out"
                  ? "Cash Out"
                  : "Close Drawer"
          }
          description={
            drawerAction === "close"
              ? `Expected balance is Rs. ${Number(
                currentDrawer?.expectedTotal || 0,
              ).toLocaleString()}. Enter counted cash.`
              : "Enter the required cash drawer details."
          }
          maxWidthClass="max-w-[560px]"
        >
          <div className="space-y-4">
            {drawerAction === "open" ? (
              <label className="block">
                <span className="text-[12px] font-extrabold uppercase text-slate-500">
                  Opening float
                </span>
                <input
                  value={drawerOpeningFloat}
                  onChange={(event) =>
                    setDrawerOpeningFloat(
                      event.target.value.replace(/[^\d.]/g, ""),
                    )
                  }
                  className="mt-2 h-[48px] w-full rounded-[14px] border border-slate-200 px-4 font-bold outline-none"
                />
              </label>
            ) : null}
            {drawerAction === "cash-in" || drawerAction === "cash-out" ? (
              <label className="block">
                <span className="text-[12px] font-extrabold uppercase text-slate-500">
                  Amount
                </span>
                <input
                  value={drawerAmount}
                  onChange={(event) =>
                    setDrawerAmount(event.target.value.replace(/[^\d.]/g, ""))
                  }
                  className="mt-2 h-[48px] w-full rounded-[14px] border border-slate-200 px-4 font-bold outline-none"
                />
              </label>
            ) : null}
            {drawerAction === "close" ? (
              <label className="block">
                <span className="text-[12px] font-extrabold uppercase text-slate-500">
                  Actual cash total
                </span>
                <input
                  value={drawerActualTotal}
                  onChange={(event) =>
                    setDrawerActualTotal(
                      event.target.value.replace(/[^\d.]/g, ""),
                    )
                  }
                  className="mt-2 h-[48px] w-full rounded-[14px] border border-slate-200 px-4 font-bold outline-none"
                />
              </label>
            ) : null}
            <label className="block">
              <span className="text-[12px] font-extrabold uppercase text-slate-500">
                Note
              </span>
              <input
                value={drawerNote}
                onChange={(event) => setDrawerNote(event.target.value)}
                className="mt-2 h-[48px] w-full rounded-[14px] border border-slate-200 px-4 font-bold outline-none"
                placeholder="Optional"
              />
            </label>
            <div className="flex justify-end gap-3">
              <DialogButton onClick={() => setDrawerAction(null)}>
                Cancel
              </DialogButton>
              <DialogButton
                variant={
                  drawerAction === "cash-out" || drawerAction === "close"
                    ? "danger"
                    : "primary"
                }
                onClick={async () => {
                  if (drawerAction === "open") await handleOpenDrawer();
                  if (drawerAction === "cash-in")
                    await handleDrawerEvent("CASH_IN");
                  if (drawerAction === "cash-out")
                    await handleDrawerEvent("CASH_OUT");
                  if (drawerAction === "close") await handleCloseDrawer();
                  setDrawerAction(null);
                }}
                disabled={drawerBusy}
              >
                {drawerBusy ? "Saving..." : "Confirm"}
              </DialogButton>
            </div>
          </div>
        </ModalFrame>
      ) : null}

      {editingCashier && cashierPrivilegeDraft ? (
        <ModalFrame
          open={!!editingCashier}
          onClose={closeCashierEdit}
          title={`Edit ${editingCashier.name}`}
          description={`${roleLabel(editingCashier.role)} permission controls and discount caps.`}
          maxWidthClass="max-w-[720px]"
          mobileBottomSheet
          footer={(
            <div className="grid w-full grid-cols-2 gap-3 sm:flex sm:justify-end">
              <DialogButton onClick={closeCashierEdit}>Cancel</DialogButton>
              <DialogButton
                variant="primary"
                onClick={() => setShowCashierSaveConfirm(true)}
              >
                Save Permissions
              </DialogButton>
            </div>
          )}
        >
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2">
              {permissionDisplay.map(([key, label]) => (
                <label
                  key={key}
                  className="flex min-h-[64px] items-center justify-between gap-3 rounded-[16px] border border-slate-200 bg-slate-50 px-3 py-3 sm:px-4 sm:py-4"
                >
                  <span className="min-w-0 text-[12px] font-extrabold leading-5 text-slate-700 min-[360px]:text-[13px]">
                    {label}
                  </span>
                  <SwitchControl
                    label={label}
                    checked={Boolean((cashierPrivilegeDraft as any)[key])}
                    onChange={(checked) =>
                      updateCashierDraft({ [key]: checked } as any)
                    }
                  />
                </label>
              ))}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label>
                <span className="text-[12px] font-extrabold uppercase text-slate-500">
                  Max loyalty %
                </span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={cashierPrivilegeDraft.maxCustomerLoyaltyPercent}
                  onChange={(event) =>
                    updateCashierDraft({
                      maxCustomerLoyaltyPercent: Number(event.target.value),
                    })
                  }
                  className="mt-2 h-[48px] w-full rounded-[14px] border border-slate-200 px-4 font-bold outline-none"
                />
              </label>
              <label>
                <span className="text-[12px] font-extrabold uppercase text-slate-500">
                  Max wholesale %
                </span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={cashierPrivilegeDraft.maxCustomerWholesalePercent}
                  onChange={(event) =>
                    updateCashierDraft({
                      maxCustomerWholesalePercent: Number(event.target.value),
                    })
                  }
                  className="mt-2 h-[48px] w-full rounded-[14px] border border-slate-200 px-4 font-bold outline-none"
                />
              </label>
            </div>
          </div>
        </ModalFrame>
      ) : null}

      <ConfirmDialog
        open={showCashierSaveConfirm}
        title="Save user permissions?"
        message="These permission changes affect what this user can see or do in role-specific workflows."
        confirmLabel="Save Permissions"
        onConfirm={confirmCashierPrivilegeSave}
        onClose={() => setShowCashierSaveConfirm(false)}
        tone="primary"
        icon="admin_panel_settings"
      />

      <ConfirmDialog
        open={showOverridePinConfirm}
        title="Change override PIN?"
        message="This PIN is required for sensitive billing overrides and void actions. Confirm only if this new PIN should become active immediately."
        confirmLabel="Update PIN"
        onConfirm={saveOverridePin}
        onClose={() => setShowOverridePinConfirm(false)}
        tone="primary"
        icon="key"
        busy={savingOverridePin}
      />

      {showBrandForm ? (
        <ModalFrame
          open={showBrandForm}
          onClose={closeBrandForm}
          title={editingBrand ? "Edit Brand" : "Add Brand"}
          description="Enter the brand details."
          maxWidthClass="max-w-[620px]"
        >
          <div className="space-y-5">
            <label className="block">
              <span className="text-[12px] font-extrabold uppercase text-slate-500">
                Brand name
              </span>
              <input
                value={brandName}
                onChange={(event) => {
                  setBrandName(event.target.value);
                  setBrandError("");
                }}
                placeholder="e.g. CG Foods"
                className="mt-2 h-[48px] w-full rounded-[14px] border border-slate-200 px-4 font-bold outline-none"
              />
            </label>
            <label className="flex items-center justify-between rounded-[16px] border border-slate-200 bg-slate-50 p-4">
              <span className="font-extrabold">Brand active</span>
              <SwitchControl
                label="Brand active"
                checked={brandActive}
                onChange={setBrandActive}
              />
            </label>
            {brandError ? (
              <div className="text-[13px] font-extrabold text-rose-600">
                {brandError}
              </div>
            ) : null}
            <div className="flex justify-end gap-3">
              <DialogButton onClick={closeBrandForm}>Cancel</DialogButton>
              <DialogButton variant="primary" onClick={saveBrand}>
                Save Brand
              </DialogButton>
            </div>
          </div>
        </ModalFrame>
      ) : null}

      <ConfirmDialog
        open={!!pendingBrandDeactivation}
        title="Deactivate this unused brand?"
        message="This only hides the brand from active choices. It does not change any products. Brands with active products cannot be deactivated."
        confirmLabel="Deactivate Brand"
        onConfirm={confirmBrandDeactivation}
        onClose={() => {
          setPendingBrandDeactivation(null);
          setPendingBrandSave(false);
        }}
        details={
          pendingBrandDeactivation ? (
            <div className="space-y-2">
              <div className="font-semibold text-slate-700">
                {pendingBrandDeactivation.activeProductCount} active product(s)
                currently use this brand.
              </div>
            </div>
          ) : null
        }
      />

      <ModalFrame
        open={showModeConfirm}
        onClose={() => {
          if (!modeBusy) setShowModeConfirm(false);
        }}
        title="Confirm shop access change"
        description="This applies to every user immediately. Historical records remain preserved."
        maxWidthClass="max-w-[620px]"
        mobileBottomSheet
        footer={
          <div className="flex w-full justify-end gap-3">
            <DialogButton
              onClick={() => setShowModeConfirm(false)}
              disabled={modeBusy}
            >
              Cancel
            </DialogButton>
            <DialogButton
              variant="primary"
              onClick={() => void confirmBusinessModeChange()}
              disabled={modeBusy}
            >
              {modeBusy ? "Applying…" : "Apply access change"}
            </DialogButton>
          </div>
        }
      >
        <div className="space-y-3.5">
          <div className="rounded-[14px] border border-[#D8DBE0] bg-[#F8FAFC] p-4 shadow-2xs">
            <div className="text-[10.5px] font-black uppercase tracking-[0.06em] text-[#64748B]">
              Capability Mode Transition
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2.5 text-[15px] font-black text-[#11120D]">
              <span className="rounded-[8px] bg-white px-2.5 py-1 border border-[#D8DBE0]">{formatBusinessMode(capabilities.businessMode)}</span>
              <Icon name="arrow_forward" sizePx={16} className="text-[#64748B]" />
              <span className="rounded-[8px] bg-[#11120D] text-white px-2.5 py-1">{formatBusinessMode(modeDraft)}</span>
            </div>
            <div className="mt-3 flex items-center gap-2 text-[12px] font-bold text-[#64748B]">
              <span>Staff billing draft requests:</span>
              <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-extrabold", effectiveStaffDraftsDraft ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-700")}>
                {effectiveStaffDraftsDraft ? "Enabled" : "Disabled"}
              </span>
            </div>
          </div>
          <div className="rounded-[14px] border border-[#D8DBE0] bg-white p-4 shadow-2xs">
            <div className="text-[10.5px] font-black uppercase tracking-[0.06em] text-[#64748B]">
              Audit Trail Reason
            </div>
            <div className="mt-1.5 text-[13px] font-bold leading-relaxed text-[#11120D]">
              "{modeReason.trim()}"
            </div>
          </div>
          <div className="rounded-[14px] border border-blue-200 bg-blue-50/80 p-4 text-[12px] font-semibold leading-relaxed text-blue-950">
            {modeDraft === "CATALOG_ONLY"
              ? "Product, import, price and lookup workflows remain available. Inventory and all POS workflows turn off."
              : modeDraft === "INVENTORY_ONLY"
                ? "Catalog and counted-inventory workflows remain available. Billing, payments and staff billing requests turn off."
                : "Inventory and POS workflows become available according to each user's role permissions."}
          </div>
        </div>
      </ModalFrame>

      <ConfirmDialog
        open={showDefaultsConfirm}
        title="Save business defaults?"
        message={`${defaultChanges.length} business default${defaultChanges.length === 1 ? "" : "s"} will change. Review the old and new values before saving.`}
        confirmLabel="Save changes"
        onConfirm={saveBusinessDefaults}
        onClose={() => {
          if (!defaultsBusy) {
            setShowDefaultsConfirm(false);
            setDefaultsSaveError("");
          }
        }}
        tone="primary"
        icon="save"
        busy={defaultsBusy}
        details={
          <div className="space-y-3">
            {defaultChanges.map((change) => (
              <div key={change.key} className="flex items-start justify-between gap-4 border-b border-slate-200 pb-3 last:border-0 last:pb-0">
                <span className="font-semibold text-slate-700">{change.label}</span>
                <span className="shrink-0 text-right font-extrabold text-slate-900">
                  <span className="text-slate-500">{change.before}</span>
                  <span className="px-2 text-slate-400">→</span>
                  {change.after} {change.unit}
                </span>
              </div>
            ))}
            {defaultsSaveError ? (
              <div className="rounded-[10px] border border-rose-200 bg-rose-50 p-3 font-bold text-rose-700" role="alert">
                {defaultsSaveError}
              </div>
            ) : null}
          </div>
        }
      />

      <ConfirmDialog
        open={showBackupConfirm}
        title="Create database export?"
        message="This creates a SQL-only database export. Product images and protected documents are covered by the separate full recovery backup."
        confirmLabel="Create Export"
        onConfirm={handleBackup}
        onClose={() => setShowBackupConfirm(false)}
        tone="primary"
        icon="cloud_upload"
        busy={backupBusy}
      />

      <ConfirmDialog
        open={showBackupScheduleConfirm}
        title="Save backup schedule?"
        message="The backend will check this schedule every minute and create SQL-only database exports when due. The VPS full recovery schedule is managed separately."
        confirmLabel="Save Schedule"
        onConfirm={saveBackupSchedule}
        onClose={() => setShowBackupScheduleConfirm(false)}
        tone="primary"
        icon="schedule"
        busy={backupScheduleBusy}
        details={
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span>Status</span>
              <span className="font-extrabold text-slate-900">
                {backupScheduleDraft.enabled ? "Enabled" : "Disabled"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Frequency</span>
              <span className="font-extrabold text-slate-900">
                {backupScheduleDraft.frequency}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Time</span>
              <span className="font-extrabold text-slate-900">
                {backupScheduleDraft.timeOfDay}
              </span>
            </div>
            {backupScheduleDraft.frequency === "WEEKLY" ? (
              <div className="flex items-center justify-between gap-3">
                <span>Day</span>
                <span className="font-extrabold text-slate-900">
                  {WEEKDAYS[backupScheduleDraft.dayOfWeek]}
                </span>
              </div>
            ) : null}
          </div>
        }
      />

      {restoreTarget ? (
        <ModalFrame
          open={!!restoreTarget}
          onClose={() => {
            if (restoreBusy) return;
            setRestoreTarget(null);
            setRestoreConfirmation("");
            setRestoreError("");
          }}
          title="Restore Data?"
          description={`WARNING: Overwriting current data with "${restoreTarget.filename}". This is permanent.`}
          maxWidthClass="max-w-[620px]"
        >
          <div className="space-y-5">
            <div className="rounded-[16px] border border-rose-200 bg-rose-50 p-4 text-[13px] font-semibold text-rose-700">
              Type the exact confirmation before restoring:
              <div className="mt-2 font-extrabold">
                RESTORE {restoreTarget.filename}
              </div>
            </div>
            <input
              value={restoreConfirmation}
              onChange={(event) => {
                setRestoreConfirmation(event.target.value);
                setRestoreError("");
              }}
              placeholder={`RESTORE ${restoreTarget.filename}`}
              className="h-[48px] w-full rounded-[14px] border border-slate-200 px-4 font-bold outline-none"
            />
            {restoreError ? (
              <div className="text-[13px] font-extrabold text-rose-600">
                {restoreError}
              </div>
            ) : null}
            <div className="flex justify-end gap-3">
              <DialogButton
                onClick={() => {
                  setRestoreTarget(null);
                  setRestoreConfirmation("");
                  setRestoreError("");
                }}
              >
                Cancel
              </DialogButton>
              <DialogButton
                variant="danger"
                onClick={handleRestoreBackup}
                disabled={
                  restoreBusy ||
                  restoreConfirmation.trim() !==
                  `RESTORE ${restoreTarget.filename}`
                }
              >
                {restoreBusy ? "Restoring..." : "Restore Now"}
              </DialogButton>
            </div>
          </div>
        </ModalFrame>
      ) : null}

      <SuccessDialog
        open={showBackupSuccess}
        title="Database export created"
        message="The SQL database export was generated successfully."
        onClose={() => setShowBackupSuccess(false)}
        secondaryAction={
          backupResult?.filename ? (
            <div className="rounded-[14px] border border-slate-200 bg-white px-4 py-2 text-[12px] font-semibold text-slate-600">
              {backupResult.filename}
            </div>
          ) : null
        }
      />
    </div>
  );
}
