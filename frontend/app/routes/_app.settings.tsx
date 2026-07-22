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
  getBackupScheduleApi,
  getCurrentCashDrawerApi,
  getOverridePolicyApi,
  listCashDrawersApi,
  listBackupHistoryApi,
  listAuditLogsApi,
  listBrandsApi,
  listCashierPrivilegesApi,
  listLoginAttemptsApi,
  listProductsApi,
  listUsersApi,
  openCashDrawerApi,
  restoreBackupApi,
  triggerBackupApi,
  updateBackupScheduleApi,
  updateBusinessSettingsApi,
  updateCashierPrivilegeApi,
  updateOverridePinApi,
  updateBrandApi,
  type BusinessSettings,
  type CashierPrivilegeRow,
  type CashDrawer,
  type OverridePolicy,
} from "~/lib/api/endpoints";
import { isRateLimitError } from "~/lib/api/client";
import { useRateLimitRecovery } from "~/lib/api/useRateLimitRecovery";

type TabKey =
  | "overview"
  | "drawer"
  | "cashier-controls"
  | "brands"
  | "audit"
  | "backup";

const SETTINGS_TAB_CACHE_MS = 30_000;
type Brand = { id: string; name: string; active: boolean };
type ProductLite = {
  id: string;
  name: string;
  sku: string;
  brandId: string;
  brand: string;
  stock: number;
  lowStockThreshold: number;
  active: boolean;
};
type UserLite = {
  id: string;
  name: string;
  email: string;
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

function formatFileSize(value?: number | null) {
  const bytes = Number(value || 0);
  if (bytes <= 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
) {
  return {
    defaultLowStock: Math.max(0, Math.floor(defaultLowStock)),
    wholesaleQtyThreshold: Math.max(1, Math.floor(wholesaleQtyThreshold)),
    loyaltyDiscountPercent: clampPercent(loyaltyDiscountPercent),
    returnWindowDays: Math.max(0, Math.floor(returnWindowDays)),
    parkedBillExpiryHours: Math.max(1, Math.floor(parkedBillExpiryHours)),
    draftRequestExpiryMinutes: Math.max(
      1,
      Math.floor(draftRequestExpiryMinutes),
    ),
  };
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
  const { showToast } = useToast();
  const [tab, setTab] = useState<TabKey>("overview"); // active settings section tab
  const [rateLimitRecoveryKey, setRateLimitRecoveryKey] = useState(0);
  const settingsTabLoadedAtRef = useRef(new Map<TabKey, number>());
  const securityQueryLoadedAtRef = useRef(new Map<string, number>());
  const requestRateLimitRecovery = useRateLimitRecovery(() => {
    setRateLimitRecoveryKey((current) => current + 1);
  });
  const [loading, setLoading] = useState(true); // tracks whether the initial data fetch is still running
  const [refreshing, setRefreshing] = useState(false); // lighter refresh state used after saves without showing the full page loader
  const [brands, setBrands] = useState<Brand[]>([]); // brand records shown in brand management
  const [products, setProducts] = useState<ProductLite[]>([]); // lightweight product list used for brand stats and low stock stats
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
  const [securityAuditActionFilter, setSecurityAuditActionFilter] = useState("");
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
  const [mobileSecurityFiltersOpen, setMobileSecurityFiltersOpen] = useState(false);
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
    INITIAL_DEFAULTS.defaultLowStock,
  );
  const [wholesaleQtyThreshold, setWholesaleQtyThreshold] = useState(
    INITIAL_DEFAULTS.wholesaleQtyThreshold,
  );
  const [loyaltyDiscountPercent, setLoyaltyDiscountPercent] = useState(
    INITIAL_DEFAULTS.loyaltyDiscountPercent,
  );
  const [returnWindowDays, setReturnWindowDays] = useState(
    INITIAL_DEFAULTS.returnWindowDays,
  );
  const [parkedBillExpiryHours, setParkedBillExpiryHours] = useState(
    INITIAL_DEFAULTS.parkedBillExpiryHours,
  );
  const [draftRequestExpiryMinutes, setDraftRequestExpiryMinutes] = useState(
    INITIAL_DEFAULTS.draftRequestExpiryMinutes,
  );
  const [savedDefaults, setSavedDefaults] = useState(INITIAL_DEFAULTS); // snapshot of the last saved business defaults
  const [showDefaultsConfirm, setShowDefaultsConfirm] = useState(false); // confirmation dialog before saving business defaults
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
          ...(securityEntityFilter
            ? { entityType: securityEntityFilter }
            : {}),
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
        productData,
        userData,
        settingsData,
        backupData,
        scheduleData,
        currentDrawerData,
        drawerHistoryData,
        cashierPrivilegeData,
        overridePolicyData,
      ] = await Promise.allSettled([
        needsBrands ? listBrandsApi() : Promise.resolve(null),
        needsBrands
          ? listProductsApi({ pageSize: 200 })
          : Promise.resolve(null),
        needsUsers ? listUsersApi() : Promise.resolve(null),
        needsBusinessRules ? getBusinessSettingsApi() : Promise.resolve(null),
        needsBackup ? listBackupHistoryApi() : Promise.resolve(null),
        needsBackup ? getBackupScheduleApi() : Promise.resolve(null),
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
          })),
        );
      }
      if (needsBrands && productData.status === "fulfilled") {
        // we only keep the product fields this page actually needs for counts and brand relationships
        const raw = Array.isArray(productData.value?.products)
          ? productData.value.products
          : [];
        setProducts(
          raw.map((product: any) => ({
            id: product.id,
            name: product.name || "Unknown",
            sku: product.sku || "",
            brandId: product.brand?.id || "",
            brand: product.brand?.name || "Unknown",
            stock: Number(product.stock ?? 0),
            lowStockThreshold: Number(product.lowStockThreshold ?? 0),
            active: product.isActive !== false,
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
        );
        setDefaultLowStock(normalizedSettings.defaultLowStock);
        setWholesaleQtyThreshold(normalizedSettings.wholesaleQtyThreshold);
        setLoyaltyDiscountPercent(normalizedSettings.loyaltyDiscountPercent);
        setReturnWindowDays(normalizedSettings.returnWindowDays);
        setParkedBillExpiryHours(normalizedSettings.parkedBillExpiryHours);
        setDraftRequestExpiryMinutes(
          normalizedSettings.draftRequestExpiryMinutes,
        );
        setSavedDefaults(normalizedSettings);
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

      const relevantResults = [
        ...(needsBrands ? [brandData, productData] : []),
        ...(needsUsers
          ? [userData, cashierPrivilegeData, overridePolicyData]
          : []),
        ...(needsBusinessRules ? [settingsData] : []),
        ...(needsBackup ? [backupData, scheduleData] : []),
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
    const loadedAt = securityQueryLoadedAtRef.current.get(securityQueryKey()) ?? 0;
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

  // these brand stats are derived from the current products list so each brand row can show totals without extra API calls
  const brandStats = useMemo(() => {
    const stats: Record<
      string,
      { total: number; active: number; low: number }
    > = {};
    brands.forEach((brand) => {
      const related = products.filter(
        (product) => product.brandId === brand.id,
      );
      stats[brand.id] = {
        total: related.length,
        active: related.filter((product) => product.active).length,
        low: related.filter(
          (product) =>
            product.active &&
            product.stock > 0 &&
            product.stock <= product.lowStockThreshold,
        ).length,
      };
    });
    return stats;
  }, [brands, products]);

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

  const editingBrandProducts = useMemo(() => {
    if (!editingBrand) return [];
    return products.filter((product) => product.brandId === editingBrand.id);
  }, [editingBrand, products]);
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

  const lowStockProducts = products.filter(
    (product) =>
      product.active &&
      product.stock > 0 &&
      product.stock <= product.lowStockThreshold,
  );
  const outOfStockProducts = products.filter(
    (product) => product.active && product.stock <= 0,
  );
  const activeUsers = users.filter((user) => user.isActive);
  const adminUsers = activeUsers.filter((user) => user.role === "ADMIN");
  const managerUsers = activeUsers.filter((user) => user.role === "MANAGER");
  const cashierUsers = activeUsers.filter((user) => user.role === "CASHIER");
  const staffUsers = activeUsers.filter((user) => user.role === "STAFF");
  const normalizedDefaults = buildBusinessDefaults(
    defaultLowStock,
    wholesaleQtyThreshold,
    loyaltyDiscountPercent,
    returnWindowDays,
    parkedBillExpiryHours,
    draftRequestExpiryMinutes,
  ); // clamping the live form state before we compare or save it

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
      showToast("success", result?.message || "Backup created successfully.");
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
      showToast("success", "Backup schedule updated.");
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

  // running the update for business defaults
  async function saveBusinessDefaults() {
    // sending the normalized defaults avoids saving invalid negative thresholds or percentages above 100
    const updated = await updateBusinessSettingsApi({
      defaultLowStockThreshold: normalizedDefaults.defaultLowStock,
      defaultWholesaleQtyThreshold: normalizedDefaults.wholesaleQtyThreshold,
      loyaltyDiscountPercent: normalizedDefaults.loyaltyDiscountPercent,
      returnWindowDays: normalizedDefaults.returnWindowDays,
      parkedBillExpiryHours: normalizedDefaults.parkedBillExpiryHours,
      draftRequestExpiryMinutes: normalizedDefaults.draftRequestExpiryMinutes,
    } satisfies Partial<BusinessSettings>);
    const saved = buildBusinessDefaults(
      Number(
        updated.defaultLowStockThreshold ?? normalizedDefaults.defaultLowStock,
      ),
      Number(
        updated.defaultWholesaleQtyThreshold ??
          normalizedDefaults.wholesaleQtyThreshold,
      ),
      Number(
        updated.loyaltyDiscountPercent ??
          normalizedDefaults.loyaltyDiscountPercent,
      ),
      Number(updated.returnWindowDays ?? normalizedDefaults.returnWindowDays),
      Number(
        updated.parkedBillExpiryHours ??
          normalizedDefaults.parkedBillExpiryHours,
      ),
      Number(
        updated.draftRequestExpiryMinutes ??
          normalizedDefaults.draftRequestExpiryMinutes,
      ),
    );
    setDefaultLowStock(saved.defaultLowStock);
    setWholesaleQtyThreshold(saved.wholesaleQtyThreshold);
    setLoyaltyDiscountPercent(saved.loyaltyDiscountPercent);
    setReturnWindowDays(saved.returnWindowDays);
    setParkedBillExpiryHours(saved.parkedBillExpiryHours);
    setDraftRequestExpiryMinutes(saved.draftRequestExpiryMinutes);
    setSavedDefaults(saved);
    setShowDefaultsConfirm(false);
    await refreshSettingsData();
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
    ...(securityDateFilter.from || securityDateFilter.to ? [{ id: "dates", label: `${securityDateFilter.from || "Any"} – ${securityDateFilter.to || "Any"}`, onRemove: () => { setSecurityDateDraft(INITIAL_SECURITY_RANGE); setSecurityDateFilter(INITIAL_SECURITY_RANGE); setAuditPage(1); setLoginPage(1); } }] : []),
    ...(securityAuditActionFilter ? [{ id: "action", label: `Action: ${securityAuditActionFilter}`, onRemove: () => { setSecurityAuditActionDraft(""); setSecurityAuditActionFilter(""); setAuditPage(1); } }] : []),
    ...(securityEntityFilter ? [{ id: "entity", label: `Entity: ${securityEntityFilter}`, onRemove: () => { setSecurityEntityDraft(""); setSecurityEntityFilter(""); setAuditPage(1); } }] : []),
    ...(securityLoginEmailFilter ? [{ id: "account", label: securityLoginEmailFilter, onRemove: () => { setSecurityLoginEmailDraft(""); setSecurityLoginEmailFilter(""); setLoginPage(1); } }] : []),
    ...(securityLoginStatusFilter !== "ALL" ? [{ id: "login", label: securityLoginStatusFilter === "SUCCESS" ? "Successful" : "Failed", onRemove: () => { setSecurityLoginStatusDraft("ALL"); setSecurityLoginStatusFilter("ALL"); setLoginPage(1); } }] : []),
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

  const settingsTabs = [
    { key: "overview", label: "Business Rules" },
    { key: "drawer", label: "Cash Drawer" },
    { key: "cashier-controls", label: "User Management" },
    { key: "brands", label: "Brands" },
    { key: "audit", label: "Audit & Security" },
    { key: "backup", label: "Backup" },
  ] as Array<{ key: TabKey; label: string }>;

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
    ["canViewWholesalePrice", "VIEW WHOLESALE"],
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
    <div className="-m-[20px] min-h-[calc(100dvh-72px)] bg-white text-slate-900 lg:-m-[24px]">
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto px-5 sm:px-7">
          <div className="flex min-w-max gap-6 sm:gap-8">
            {settingsTabs.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setTab(item.key)}
                className={cn(
                  "border-b-[3px] px-1 py-4 text-[14px] font-extrabold transition sm:text-[15px]",
                  tab === item.key
                    ? "border-slate-950 text-slate-950"
                    : "border-transparent text-slate-500 hover:text-slate-800",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <main className="w-full px-5 py-6 sm:px-7">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-[24px] font-extrabold leading-tight text-slate-950">
              {pageTitle.title}
            </h1>
            <p className="mt-1 text-[13px] font-medium text-slate-500">
              {pageTitle.subtitle}
            </p>
          </div>

          {tab === "overview" && defaultsDirty ? (
            <div className="flex items-center gap-2 rounded-[8px] border border-amber-200 bg-amber-50 p-2">
              <span className="px-2 text-[12px] font-extrabold uppercase text-amber-700">
                Unsaved
              </span>
              <button
                type="button"
                onClick={() => {
                  setDefaultLowStock(savedDefaults.defaultLowStock);
                  setWholesaleQtyThreshold(savedDefaults.wholesaleQtyThreshold);
                  setLoyaltyDiscountPercent(
                    savedDefaults.loyaltyDiscountPercent,
                  );
                  setReturnWindowDays(savedDefaults.returnWindowDays);
                  setParkedBillExpiryHours(savedDefaults.parkedBillExpiryHours);
                  setDraftRequestExpiryMinutes(
                    savedDefaults.draftRequestExpiryMinutes,
                  );
                }}
                className="rounded-[8px] border border-transparent px-4 py-2 text-[13px] font-extrabold text-slate-600 hover:border-slate-200 hover:bg-white"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={() => setShowDefaultsConfirm(true)}
                className="rounded-[8px] bg-slate-900 px-4 py-2 text-[13px] font-extrabold text-white"
              >
                Save Changes
              </button>
            </div>
          ) : null}

          {tab === "brands" ? (
            <button
              type="button"
              onClick={() => {
                resetBrandForm();
                setShowBrandForm(true);
              }}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-[8px] bg-slate-950 px-5 text-[13px] font-extrabold text-white shadow-sm transition hover:bg-slate-800"
            >
              <Icon name="add" sizePx={20} />
              Add Brand
            </button>
          ) : null}
        </div>

        {tab === "overview" ? (
          <section className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <div className="rounded-[8px] border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-5 flex items-center gap-3">
                <Icon
                  name="shopping_cart"
                  sizePx={24}
                  className="text-blue-600"
                />
                <h2 className="text-[17px] font-extrabold text-slate-800">
                  Inventory & Sales
                </h2>
              </div>

              <div className="space-y-4">
                <label className="block">
                  <span className="text-[13px] font-extrabold text-slate-800">
                    Stock Alert Threshold
                  </span>
                  <input
                    type="number"
                    min={0}
                    value={defaultLowStock}
                    onChange={(event) =>
                      setDefaultLowStock(
                        Math.max(0, Number(event.target.value || 0)),
                      )
                    }
                    className="mt-2 h-11 w-full rounded-[8px] border border-slate-200 bg-white px-3 text-[14px] font-medium outline-none focus:border-blue-600"
                  />
                  <span className="mt-2 block text-[12px] font-medium text-slate-400">
                    Affects product stock alert dashboard counts.
                  </span>
                </label>

                <label className="block">
                  <span className="text-[13px] font-extrabold text-slate-800">
                    Wholesale Quantity Threshold
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={wholesaleQtyThreshold}
                    onChange={(event) =>
                      setWholesaleQtyThreshold(
                        Math.max(1, Number(event.target.value || 1)),
                      )
                    }
                    className="mt-2 h-11 w-full rounded-[8px] border border-slate-200 bg-white px-3 text-[14px] font-medium outline-none focus:border-blue-600"
                  />
                  <span className="mt-2 block text-[12px] font-medium text-slate-400">
                    Default minimum quantity for wholesale pricing.
                  </span>
                </label>

                <label className="block">
                  <span className="text-[13px] font-extrabold text-slate-800">
                    Loyalty Discount (%)
                  </span>
                  <div className="relative mt-2">
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={loyaltyDiscountPercent}
                      onChange={(event) =>
                        setLoyaltyDiscountPercent(
                          clampPercent(Number(event.target.value || 0)),
                        )
                      }
                      className="h-11 w-full rounded-[8px] border border-slate-200 bg-white px-3 pr-10 text-[14px] font-medium outline-none focus:border-blue-600"
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[18px] font-medium text-slate-400">
                      %
                    </span>
                  </div>
                  <span className="mt-2 block text-[12px] font-medium text-slate-400">
                    System-wide default for loyalty-eligible customers.
                  </span>
                </label>
              </div>
            </div>

            <div className="rounded-[8px] border border-slate-200 bg-white p-5 shadow-sm">
              <div className="mb-5 flex items-center gap-3">
                <Icon name="schedule" sizePx={24} className="text-violet-500" />
                <h2 className="text-[17px] font-extrabold text-slate-800">
                  Operational Limits
                </h2>
              </div>

              <div className="space-y-4">
                <label className="block">
                  <span className="text-[13px] font-extrabold text-slate-800">
                    Return Window (Days)
                  </span>
                  <input
                    type="number"
                    min={0}
                    value={returnWindowDays}
                    onChange={(event) =>
                      setReturnWindowDays(
                        Math.max(0, Number(event.target.value || 0)),
                      )
                    }
                    className="mt-2 h-11 w-full rounded-[8px] border border-slate-200 bg-white px-3 text-[14px] font-medium outline-none focus:border-blue-600"
                  />
                  <span className="mt-2 block text-[12px] font-medium text-slate-400">
                    Days after purchase a return is permitted.
                  </span>
                </label>

                <label className="block">
                  <span className="text-[13px] font-extrabold text-slate-800">
                    Parked Bill Expiry (Hours)
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={parkedBillExpiryHours}
                    onChange={(event) =>
                      setParkedBillExpiryHours(
                        Math.max(1, Number(event.target.value || 1)),
                      )
                    }
                    className="mt-2 h-11 w-full rounded-[8px] border border-slate-200 bg-white px-3 text-[14px] font-medium outline-none focus:border-blue-600"
                  />
                  <span className="mt-2 block text-[12px] font-medium text-slate-400">
                    Hours before a parked bill is automatically cleared.
                  </span>
                </label>

                <label className="block">
                  <span className="text-[13px] font-extrabold text-slate-800">
                    Draft Request Expiry (Minutes)
                  </span>
                  <input
                    type="number"
                    min={1}
                    value={draftRequestExpiryMinutes}
                    onChange={(event) =>
                      setDraftRequestExpiryMinutes(
                        Math.max(1, Number(event.target.value || 1)),
                      )
                    }
                    className="mt-2 h-11 w-full rounded-[8px] border border-slate-200 bg-white px-3 text-[14px] font-medium outline-none focus:border-blue-600"
                  />
                  <span className="mt-2 block text-[12px] font-medium text-slate-400">
                    Minutes before staff draft requests expire.
                  </span>
                </label>
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
                            {cashier.email}
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
                          {cashier.email}
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
          <section className="overflow-hidden rounded-[8px] border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-col gap-4 bg-white p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="relative w-full sm:max-w-[480px]">
                <Icon
                  name="search"
                  sizePx={20}
                  className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"
                />
                <input
                  value={brandQuery}
                  onChange={(event) => setBrandQuery(event.target.value)}
                  placeholder="Search brands..."
                  className="h-11 w-full rounded-[8px] border border-slate-200 bg-white pl-11 pr-4 text-[14px] font-medium outline-none focus:border-blue-600"
                />
              </div>
              <MobileFilterTabs className="sm:hidden" ariaLabel="Brand status" value={brandFilter} onChange={setBrandFilter} items={(["all", "active", "inactive"] as const).map((value) => ({ value, label: value[0].toUpperCase() + value.slice(1) }))} />
              <div className="hidden rounded-[8px] border border-slate-200 bg-white p-1 sm:inline-flex">
                {(["all", "active", "inactive"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setBrandFilter(value)}
                    className={cn(
                      "rounded-[8px] px-4 py-1.5 text-[13px] font-extrabold capitalize",
                      brandFilter === value
                        ? "bg-slate-900 text-white"
                        : "text-slate-500 hover:text-slate-700",
                    )}
                  >
                    {value}
                  </button>
                ))}
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
                            {stats.low} low
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
                            className={cn(
                              "inline-flex h-9 items-center justify-center rounded-[8px] border px-3 text-[12px] font-extrabold transition",
                              brand.active
                                ? "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
                                : "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100",
                            )}
                          >
                            {brand.active ? "Deactivate" : "Activate"}
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
                          {stats.total} items | {stats.low} low stock
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
                        className={cn(
                          "inline-flex h-9 items-center justify-center rounded-[8px] border px-3 text-[12px] font-extrabold",
                          brand.active
                            ? "border-rose-200 bg-rose-50 text-rose-700"
                            : "border-emerald-200 bg-emerald-50 text-emerald-700",
                        )}
                      >
                        {brand.active ? "Deactivate" : "Activate"}
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
          <section className="space-y-5">
            <div className="rounded-[8px] border border-slate-200 bg-white shadow-sm">
              <div className="flex items-center gap-3 border-b border-slate-200 px-5 py-4">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-slate-100 text-slate-700">
                  <Icon name="filter_alt" sizePx={18} />
                </span>
                <div>
                  <h2 className="text-[17px] font-extrabold text-slate-900">
                    Filter activity
                  </h2>
                  <p className="mt-0.5 text-[12px] font-medium text-slate-500">
                    Narrow audit events and sign-in activity without losing either view.
                  </p>
                </div>
                <MobileFilterButton activeCount={mobileSecurityFilterCount} onClick={openMobileSecurityFilters} className="ml-auto lg:hidden" />
              </div>
              <div className="hidden grid-cols-1 gap-4 p-5 sm:grid-cols-2 lg:grid xl:grid-cols-12">
                <label className="xl:col-span-3">
                  <span className="text-[11px] font-extrabold uppercase tracking-[0.06em] text-slate-500">
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
                    className="mt-2 h-10 w-full rounded-[8px] border border-slate-200 px-3 text-[13px] font-semibold outline-none focus:border-blue-600"
                  />
                </label>
                <label className="xl:col-span-3">
                  <span className="text-[11px] font-extrabold uppercase tracking-[0.06em] text-slate-500">
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
                    className="mt-2 h-10 w-full rounded-[8px] border border-slate-200 px-3 text-[13px] font-semibold outline-none focus:border-blue-600"
                  />
                </label>
                <label className="xl:col-span-3">
                  <span className="text-[11px] font-extrabold uppercase tracking-[0.06em] text-slate-500">
                    Audit action
                  </span>
                  <input
                    value={securityAuditActionDraft}
                    onChange={(event) =>
                      setSecurityAuditActionDraft(event.target.value)
                    }
                    placeholder="e.g. INVOICE"
                    className="mt-2 h-10 w-full rounded-[8px] border border-slate-200 px-3 text-[13px] font-semibold outline-none focus:border-blue-600"
                  />
                </label>
                <label className="xl:col-span-3">
                  <span className="text-[11px] font-extrabold uppercase tracking-[0.06em] text-slate-500">
                    Entity type
                  </span>
                  <input
                    value={securityEntityDraft}
                    onChange={(event) => setSecurityEntityDraft(event.target.value)}
                    placeholder="Invoice, Product..."
                    className="mt-2 h-10 w-full rounded-[8px] border border-slate-200 px-3 text-[13px] font-semibold outline-none focus:border-blue-600"
                  />
                </label>
                <label className="xl:col-span-4">
                  <span className="text-[11px] font-extrabold uppercase tracking-[0.06em] text-slate-500">
                    Login account
                  </span>
                  <input
                    type="email"
                    value={securityLoginEmailDraft}
                    onChange={(event) =>
                      setSecurityLoginEmailDraft(event.target.value)
                    }
                    placeholder="Email address"
                    className="mt-2 h-10 w-full rounded-[8px] border border-slate-200 px-3 text-[13px] font-semibold outline-none focus:border-blue-600"
                  />
                </label>
                <label className="xl:col-span-3">
                  <span className="text-[11px] font-extrabold uppercase tracking-[0.06em] text-slate-500">
                    Login status
                  </span>
                  <ProjectSelect
                    value={securityLoginStatusDraft}
                    onChange={(event) =>
                      setSecurityLoginStatusDraft(
                        event.target.value as "ALL" | "SUCCESS" | "FAILED",
                      )
                    }
                    className="mt-2 h-10 w-full rounded-[8px] border border-slate-200 bg-white px-3 text-[13px] font-semibold outline-none focus:border-blue-600"
                  >
                    <option value="ALL">All attempts</option>
                    <option value="SUCCESS">Successful</option>
                    <option value="FAILED">Failed</option>
                  </ProjectSelect>
                </label>
                <div className="flex gap-2 sm:col-span-2 xl:col-span-5 xl:items-end xl:justify-end">
                  <button
                    type="button"
                    onClick={clearSecurityFilters}
                    className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-[8px] border border-slate-300 bg-white px-4 text-[13px] font-extrabold text-slate-700 transition hover:bg-slate-100 sm:flex-none"
                  >
                    <Icon name="restart_alt" sizePx={17} />
                    Clear filters
                  </button>
                  <button
                    type="button"
                    onClick={applySecurityFilters}
                    className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-[8px] bg-slate-950 px-5 text-[13px] font-extrabold text-white transition hover:bg-slate-800 sm:flex-none"
                  >
                    <Icon name="filter_alt" sizePx={17} />
                    Apply filters
                  </button>
                </div>
              </div>
              {securityFilterError ? (
                <div className="mx-5 mb-5 hidden rounded-[8px] border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] font-bold text-rose-700 lg:block">
                  {securityFilterError}
                </div>
              ) : null}
              <ActiveFilterChips items={mobileSecurityFilterChips} className="px-5 py-4 lg:hidden" />
            </div>

            <MobileFilterSheet
              open={mobileSecurityFiltersOpen}
              onClose={closeMobileSecurityFilters}
              onClear={() => { setSecurityDateDraft(INITIAL_SECURITY_RANGE); setSecurityAuditActionDraft(""); setSecurityEntityDraft(""); setSecurityLoginEmailDraft(""); setSecurityLoginStatusDraft("ALL"); setSecurityFilterError(""); }}
              onApply={() => { if (applySecurityFilters()) setMobileSecurityFiltersOpen(false); }}
              footerMessage={securityFilterError}
            >
              <div className="space-y-5">
                <div className="grid grid-cols-2 gap-3">
                  <label className="space-y-2"><span className="text-[13px] font-bold">From date</span><ProjectDateInput value={securityDateDraft.from} max={securityDateDraft.to || undefined} onChange={(event) => setSecurityDateDraft((current) => ({ ...current, from: event.target.value }))} /></label>
                  <label className="space-y-2"><span className="text-[13px] font-bold">To date</span><ProjectDateInput value={securityDateDraft.to} min={securityDateDraft.from || undefined} onChange={(event) => setSecurityDateDraft((current) => ({ ...current, to: event.target.value }))} /></label>
                </div>
                <label className="block space-y-2"><span className="text-[13px] font-bold">Audit action</span><input value={securityAuditActionDraft} onChange={(event) => setSecurityAuditActionDraft(event.target.value)} placeholder="e.g. INVOICE" className="h-11 w-full rounded-xl border border-slate-200 px-3 text-[13px] font-semibold outline-none focus:border-slate-900" /></label>
                <label className="block space-y-2"><span className="text-[13px] font-bold">Entity type</span><input value={securityEntityDraft} onChange={(event) => setSecurityEntityDraft(event.target.value)} placeholder="Invoice, Product..." className="h-11 w-full rounded-xl border border-slate-200 px-3 text-[13px] font-semibold outline-none focus:border-slate-900" /></label>
                <label className="block space-y-2"><span className="text-[13px] font-bold">Login account</span><input type="email" value={securityLoginEmailDraft} onChange={(event) => setSecurityLoginEmailDraft(event.target.value)} placeholder="Email address" className="h-11 w-full rounded-xl border border-slate-200 px-3 text-[13px] font-semibold outline-none focus:border-slate-900" /></label>
                <label className="block space-y-2"><span className="text-[13px] font-bold">Login status</span><ProjectSelect value={securityLoginStatusDraft} onChange={(event) => setSecurityLoginStatusDraft(event.target.value as "ALL" | "SUCCESS" | "FAILED")}><option value="ALL">All attempts</option><option value="SUCCESS">Successful</option><option value="FAILED">Failed</option></ProjectSelect></label>
              </div>
            </MobileFilterSheet>

            <div className="grid grid-cols-1 items-stretch gap-5 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
              <div className="flex min-h-[400px] flex-col overflow-hidden rounded-[8px] border border-slate-200 bg-white shadow-sm xl:h-[560px]">
                <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
                  <h2 className="text-[17px] font-extrabold">Audit Logs</h2>
                  <span className="rounded-[6px] bg-slate-100 px-3 py-1.5 text-[11px] font-extrabold text-slate-600">
                    {auditTotal} total
                  </span>
                </div>
                <div className="hidden min-h-0 flex-1 overflow-auto md:block">
                  <table className="w-full min-w-[500px] border-collapse text-left">
                    <thead className="bg-[#F8FAFC] text-[11px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
                      <tr>
                        <th className="px-4 py-3">Action</th>
                        <th className="px-4 py-3">Entity</th>
                        <th className="px-4 py-3">Actor</th>
                        <th className="px-4 py-3 text-right">Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditLogs.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-5 py-14 text-center">
                            <Icon name="history" sizePx={22} className="mx-auto text-slate-300" />
                            <div className="mt-3 text-[13px] font-extrabold text-slate-700">
                              No audit activity matches these filters
                            </div>
                            <div className="mt-1 text-[12px] font-medium text-slate-500">
                              Change the filters or clear them to review earlier activity.
                            </div>
                          </td>
                        </tr>
                      ) : null}
                      {auditLogs.map((log) => (
                        <tr
                          key={log.id}
                          className="border-b border-[#E5E7EB] transition-colors hover:bg-[#ECEFF3] last:border-0"
                        >
                          <td className="px-4 py-3 text-[13px] font-extrabold text-slate-900">
                            {log.action}
                          </td>
                          <td className="px-4 py-3">
                            <div className="text-[13px] font-semibold text-slate-900">
                              {String(log.meta?.invoiceNo || log.entityType)}
                            </div>
                            <div className="mt-1 text-[12px] text-slate-500">
                              ID: {log.entityId}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-[13px] font-semibold text-slate-900">
                            {log.actor?.name || "System"}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="text-[13px] font-extrabold text-slate-900">
                              {formatRelativeTime(log.createdAt)}
                            </div>
                            <div className="mt-1 text-[12px] text-slate-500">
                              {formatDateTime(log.createdAt)}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 md:hidden">
                  {auditLogs.length === 0 ? (
                    <div className="py-12 text-center">
                      <Icon name="history" sizePx={22} className="mx-auto text-slate-300" />
                      <div className="mt-3 text-[13px] font-extrabold text-slate-700">
                        No audit activity matches these filters
                      </div>
                    </div>
                  ) : null}
                  {auditLogs.map((log) => (
                    <div
                      key={log.id}
                      className="rounded-[8px] border border-slate-200 bg-white p-4"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="text-[16px] font-extrabold text-slate-950">
                            {log.action}
                          </div>
                          <div className="mt-1 text-[12px] font-semibold text-slate-500">
                            {String(log.meta?.invoiceNo || log.entityType)}
                          </div>
                        </div>
                        <div className="text-right text-[12px] font-extrabold text-slate-500">
                          {formatRelativeTime(log.createdAt)}
                        </div>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2 text-[12px] font-semibold text-slate-500">
                        <span>Actor: {log.actor?.name || "System"}</span>
                        <span className="truncate">ID: {log.entityId}</span>
                        <span className="col-span-2">
                          {formatDateTime(log.createdAt)}
                        </span>
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
                  className="rounded-none border-x-0 border-b-0 border-slate-200"
                />
              </div>

              <div className="flex min-h-[400px] flex-col overflow-hidden rounded-[8px] border border-slate-200 bg-white shadow-sm xl:h-[560px]">
                <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
                  <h2 className="text-[17px] font-extrabold">Login Activity</h2>
                  {failedLoginCount > 0 ? (
                    <span className="rounded-[6px] bg-rose-50 px-3 py-2 text-[12px] font-extrabold uppercase text-rose-600">
                      {failedLoginCount} failed
                    </span>
                  ) : null}
                </div>
                <div className="hidden min-h-0 flex-1 overflow-auto md:block">
                  <table className="w-full min-w-[500px] border-collapse text-left">
                    <thead className="bg-[#F8FAFC] text-[11px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
                      <tr>
                        <th className="px-4 py-3">Account</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3">IP</th>
                        <th className="px-4 py-3 text-right">Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {loginAttempts.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-5 py-14 text-center">
                            <Icon name="login" sizePx={22} className="mx-auto text-slate-300" />
                            <div className="mt-3 text-[13px] font-extrabold text-slate-700">
                              No login activity matches these filters
                            </div>
                            <div className="mt-1 text-[12px] font-medium text-slate-500">
                              Try another account, status, or date range.
                            </div>
                          </td>
                        </tr>
                      ) : null}
                      {loginAttempts.map((attempt) => (
                        <tr
                          key={attempt.id}
                          className="border-b border-[#E5E7EB] transition-colors hover:bg-[#ECEFF3] last:border-0"
                        >
                          <td className="px-4 py-3 text-[13px] font-semibold text-slate-900">
                            {attempt.email}
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={cn(
                                "text-[13px] font-extrabold",
                                attempt.success
                                  ? "text-emerald-600"
                                  : "text-rose-600",
                              )}
                            >
                              {attempt.success ? "Success" : "Failed"}
                            </span>
                          </td>
                          <td className="px-4 py-3 font-mono text-[12px] text-slate-400">
                            {attempt.ip || "Unavailable"}
                          </td>
                          <td className="px-4 py-3 text-right text-[13px] font-extrabold text-slate-900">
                            {formatRelativeTime(attempt.createdAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 md:hidden">
                  {loginAttempts.length === 0 ? (
                    <div className="py-12 text-center">
                      <Icon name="login" sizePx={22} className="mx-auto text-slate-300" />
                      <div className="mt-3 text-[13px] font-extrabold text-slate-700">
                        No login activity matches these filters
                      </div>
                    </div>
                  ) : null}
                  {loginAttempts.map((attempt) => (
                    <div
                      key={attempt.id}
                      className="rounded-[8px] border border-slate-200 bg-white p-4"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="text-[15px] font-extrabold text-slate-950">
                            {attempt.email}
                          </div>
                          <div className="mt-1 font-mono text-[12px] text-slate-400">
                            {attempt.ip || "Unavailable"}
                          </div>
                        </div>
                        <span
                          className={cn(
                            "text-[13px] font-extrabold",
                            attempt.success
                              ? "text-emerald-600"
                              : "text-rose-600",
                          )}
                        >
                          {attempt.success ? "Success" : "Failed"}
                        </span>
                      </div>
                      <div className="mt-3 text-[12px] font-semibold text-slate-500">
                        {formatRelativeTime(attempt.createdAt)} |{" "}
                        {formatDateTime(attempt.createdAt)}
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
                  className="rounded-none border-x-0 border-b-0 border-slate-200"
                />
              </div>
            </div>
          </section>
        ) : null}

        {tab === "backup" ? (
          <section className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
            <div className="space-y-5">
              <div className="rounded-[8px] border border-slate-200 bg-white p-5 shadow-sm">
                <div className="mb-4 flex items-center gap-3">
                  <Icon
                    name="cloud_download"
                    sizePx={22}
                    className="text-blue-600"
                  />
                  <h2 className="text-[17px] font-extrabold text-slate-800">
                    Manual Backup
                  </h2>
                </div>
                <p className="text-[13px] font-medium leading-5 text-slate-500">
                  Snapshot products, users, brands, invoices, payments,
                  inventory, settings, and logs immediately.
                </p>
                <button
                  type="button"
                  onClick={() => setShowBackupConfirm(true)}
                  disabled={backupBusy}
                  className="mt-5 h-11 w-full rounded-[8px] bg-slate-950 text-[13px] font-extrabold text-white transition hover:bg-slate-800 disabled:opacity-50"
                >
                  {backupBusy ? "Backing up..." : "Start Manual Backup"}
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
                      Auto Schedule
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
                  Backup & Restore History
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
                    No backup activity yet
                  </div>
                  <p className="mt-1 max-w-sm text-[12px] font-medium leading-5 text-slate-500">
                    Manual backups and restore attempts will appear here with their status, size, and completion details.
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowBackupConfirm(true)}
                    disabled={backupBusy}
                    className="mt-5 inline-flex h-10 items-center justify-center gap-2 rounded-[8px] bg-slate-950 px-4 text-[12px] font-extrabold text-white transition hover:bg-slate-800 disabled:opacity-50"
                  >
                    <Icon name="cloud_download" sizePx={17} />
                    Create first backup
                  </button>
                </div>
              ) : null}
              <div className={cn("hidden overflow-x-auto md:block", backupHistory.length === 0 && "md:hidden")}>
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
                            {backup.type === "BACKUP" ? "Backup" : "Restore"}
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
              <div className={cn("space-y-3 p-4 md:hidden", backupHistory.length === 0 && "hidden")}>
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
                        {backup.type === "BACKUP" ? "Backup" : "Restore"}
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
        >
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2">
              {permissionDisplay.map(([key, label]) => (
                <label
                  key={key}
                  className="flex items-center justify-between rounded-[16px] border border-slate-200 bg-slate-50 px-4 py-4"
                >
                  <span className="text-[13px] font-extrabold text-slate-700">
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
            <div className="flex justify-end gap-3">
              <DialogButton onClick={closeCashierEdit}>Cancel</DialogButton>
              <DialogButton
                variant="primary"
                onClick={() => setShowCashierSaveConfirm(true)}
              >
                Save Permissions
              </DialogButton>
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
        title="Deactivate this brand?"
        message="This brand will be marked inactive. Products linked to this brand will also be deactivated and removed from active selling flows."
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
                {
                  products.filter(
                    (product) =>
                      product.brandId === pendingBrandDeactivation.id &&
                      product.active,
                  ).length
                }{" "}
                active product(s) will be affected.
              </div>
            </div>
          ) : null
        }
      />

      <ConfirmDialog
        open={showDefaultsConfirm}
        title="Save business defaults?"
        message="These values will become the saved business defaults for products, loyalty, returns, held bills, and staff requests."
        confirmLabel="Save Defaults"
        onConfirm={saveBusinessDefaults}
        onClose={() => setShowDefaultsConfirm(false)}
        tone="primary"
        icon="save"
        details={
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span>Stock alert threshold</span>
              <span className="font-extrabold text-slate-900">
                {normalizedDefaults.defaultLowStock}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Wholesale quantity default</span>
              <span className="font-extrabold text-slate-900">
                {normalizedDefaults.wholesaleQtyThreshold}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Loyalty discount percentage</span>
              <span className="font-extrabold text-slate-900">
                {normalizedDefaults.loyaltyDiscountPercent}%
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Return window</span>
              <span className="font-extrabold text-slate-900">
                {normalizedDefaults.returnWindowDays} day(s)
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Held bill expiry</span>
              <span className="font-extrabold text-slate-900">
                {normalizedDefaults.parkedBillExpiryHours} hour(s)
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Draft request expiry</span>
              <span className="font-extrabold text-slate-900">
                {normalizedDefaults.draftRequestExpiryMinutes} minute(s)
              </span>
            </div>
          </div>
        }
      />

      <ConfirmDialog
        open={showBackupConfirm}
        title="Create database backup?"
        message="This will generate a manual backup of the current KhataSathi database for recovery purposes."
        confirmLabel="Create Backup"
        onConfirm={handleBackup}
        onClose={() => setShowBackupConfirm(false)}
        tone="primary"
        icon="cloud_upload"
        busy={backupBusy}
      />

      <ConfirmDialog
        open={showBackupScheduleConfirm}
        title="Save backup schedule?"
        message="The backend will check this schedule every minute and create backups automatically when due."
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
        title="Backup created successfully"
        message="Your database backup file has been generated."
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
