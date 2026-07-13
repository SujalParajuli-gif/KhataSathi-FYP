import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import Icon from "~/components/ui/Icon";
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

type TabKey = "overview" | "cashier-controls" | "brands" | "audit" | "backup";
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
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
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
    draftRequestExpiryMinutes: Math.max(1, Math.floor(draftRequestExpiryMinutes)),
  };
}

// this is the shared card shell used across the settings dashboard sections
function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-[18px] border border-slate-200 bg-white",
        className,
      )}
    >
      {children}
    </div>
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

// this is the shared button component used across settings actions and confirmations
function Button({
  children,
  variant = "secondary",
  onClick,
  disabled,
  icon,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger";
  onClick?: () => void;
  disabled?: boolean;
  icon?: string;
}) {
  const styles =
    variant === "primary"
      ? "bg-slate-900 text-white border-slate-900 hover:bg-slate-800"
      : variant === "danger"
        ? "bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100"
        : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-[14px] border px-4 py-2.5 text-[13px] font-extrabold transition active:scale-[0.98]",
        styles,
        disabled && "pointer-events-none opacity-50",
      )}
    >
      {icon ? <Icon name={icon} className="text-inherit" /> : null}
      {children}
    </button>
  );
}

// this metric card is used for the high-level counts at the top of the settings page
function Stat({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  hint: string;
  tone?: "neutral" | "danger" | "success" | "info";
}) {
  const valueTone =
    tone === "danger"
      ? "text-rose-600"
      : tone === "success"
        ? "text-emerald-700"
        : tone === "info"
          ? "text-blue-700"
          : "text-slate-900";
  return (
    <Card>
      <div className="p-5">
        <div className="text-[11px] font-extrabold uppercase  text-slate-400">
          {label}
        </div>
        <div className={cn("mt-2 text-[28px] font-extrabold ", valueTone)}>
          {value}
        </div>
        <div className="mt-2 text-[12px] text-slate-500">{hint}</div>
      </div>
    </Card>
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
  const [loading, setLoading] = useState(true); // tracks whether the initial data fetch is still running
  const [refreshing, setRefreshing] = useState(false); // lighter refresh state used after saves without showing the full page loader
  const [brands, setBrands] = useState<Brand[]>([]); // brand records shown in brand management
  const [products, setProducts] = useState<ProductLite[]>([]); // lightweight product list used for brand stats and low stock stats
  const [users, setUsers] = useState<UserLite[]>([]); // lightweight staff list used for overview counts
  const [cashierPrivileges, setCashierPrivileges] = useState<CashierPrivilegeRow[]>([]);
  const [savingCashierPrivilegeId, setSavingCashierPrivilegeId] = useState<string | null>(null);
  const [overridePolicy, setOverridePolicy] = useState<OverridePolicy>({
    pinConfigured: false,
    pinUpdatedAt: null,
  });
  const [overridePinDraft, setOverridePinDraft] = useState("");
  const [savingOverridePin, setSavingOverridePin] = useState(false);
  const [overridePinError, setOverridePinError] = useState("");
  const [auditLogs, setAuditLogs] = useState<AuditLogRow[]>([]); // recent audit log rows
  const [loginAttempts, setLoginAttempts] = useState<LoginAttemptRow[]>([]); // recent login attempts for security review
  const [securityDateDraft, setSecurityDateDraft] = useState<SecurityDateRange>(
    INITIAL_SECURITY_RANGE,
  ); // editable date inputs for the audit tab before the user applies them
  const [securityDateFilter, setSecurityDateFilter] =
    useState<SecurityDateRange>(INITIAL_SECURITY_RANGE); // the active date range sent to both audit endpoints
  const [securityFilterError, setSecurityFilterError] = useState(""); // validation message when the chosen date range is invalid
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
  const [backupSchedule, setBackupSchedule] =
    useState<BackupScheduleDraft>(INITIAL_BACKUP_SCHEDULE);
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

  // the security lists share one date range filter, so these helpers keep both API payloads consistent
  function buildSecurityDateParams() {
    return {
      ...(securityDateFilter.from ? { from: securityDateFilter.from } : {}),
      ...(securityDateFilter.to ? { to: securityDateFilter.to } : {}),
    };
  }

  async function loadSecurityData() {
    setSecurityLoading(true);

    try {
      const dateParams = buildSecurityDateParams();
      const [auditData, loginData, failedData] = await Promise.allSettled([
        listAuditLogsApi({
          ...dateParams,
          page: auditPage,
          pageSize: auditPageSize,
        }),
        listLoginAttemptsApi({
          ...dateParams,
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
    } finally {
      setSecurityLoading(false);
    }
  }

  async function refreshSettingsData() {
    await Promise.all([loadData(false), loadSecurityData()]);
  }

  // fetching all setting data tabs (business rules, users, brands, audits, logs, products)
  // at the same time using promise.allSettled so individual failures don't cause the entire panel to crash
  async function loadData(showLoader = true) {
    if (showLoader) setLoading(true);
    else setRefreshing(true);
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
      ] =
        await Promise.allSettled([
          listBrandsApi(),
          listProductsApi({ pageSize: 300 }),
          listUsersApi(),
          getBusinessSettingsApi(),
          listBackupHistoryApi(),
          getBackupScheduleApi(),
          getCurrentCashDrawerApi(),
          listCashDrawersApi(),
          listCashierPrivilegesApi(),
          getOverridePolicyApi(),
        ]);

      if (brandData.status === "fulfilled") {
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
      if (productData.status === "fulfilled") {
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
      if (userData.status === "fulfilled") {
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
      if (cashierPrivilegeData.status === "fulfilled") {
        setCashierPrivileges(
          Array.isArray(cashierPrivilegeData.value.cashiers)
            ? cashierPrivilegeData.value.cashiers
            : [],
        );
      }
      if (overridePolicyData.status === "fulfilled") {
        setOverridePolicy(overridePolicyData.value);
      }
      if (settingsData.status === "fulfilled") {
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
        setDraftRequestExpiryMinutes(normalizedSettings.draftRequestExpiryMinutes);
        setSavedDefaults(normalizedSettings);
      }
      if (currentDrawerData.status === "fulfilled") {
        setCurrentDrawer(currentDrawerData.value.drawer || null);
      }
      if (drawerHistoryData.status === "fulfilled") {
        setDrawerHistory(
          Array.isArray(drawerHistoryData.value.drawers)
            ? drawerHistoryData.value.drawers
            : [],
        );
      }
      if (backupData.status === "fulfilled") {
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
      if (scheduleData.status === "fulfilled") {
        const nextSchedule = normalizeBackupSchedule(scheduleData.value);
        setBackupSchedule(nextSchedule);
        setBackupScheduleDraft(nextSchedule);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    loadData(true);
  }, []);

  useEffect(() => {
    loadSecurityData();
  }, [
    auditPage,
    auditPageSize,
    loginPage,
    loginPageSize,
    securityDateFilter.from,
    securityDateFilter.to,
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
  const auditTotalPages = Math.max(
    1,
    Math.ceil(auditTotal / auditPageSize),
  );
  const loginTotalPages = Math.max(
    1,
    Math.ceil(loginTotal / loginPageSize),
  );
  const brandTotalPages = Math.max(
    1,
    Math.ceil(filteredBrands.length / brandPageSize),
  );
  const auditPageClamped = clampPage(auditPage, 1, auditTotalPages);
  const loginPageClamped = clampPage(loginPage, 1, loginTotalPages);
  const brandPageClamped = clampPage(brandPage, 1, brandTotalPages);
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
  const auditPageEnd =
    auditTotal === 0 ? 0 : auditPageStart + auditLogs.length;
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
          "Failed to update cashier permissions.",
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
      showToast("success", "Cashier override PIN updated.");
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
      setDrawerError(error?.response?.data?.error || error?.message || "Failed to open cash drawer.");
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
      showToast("success", type === "CASH_IN" ? "Cash added." : "Cash removed.");
      await refreshDrawerData();
    } catch (error: any) {
      setDrawerError(error?.response?.data?.error || error?.message || "Failed to update cash drawer.");
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
      setDrawerHistory((current) => [result.drawer, ...current.filter((item) => item.id !== result.drawer.id)]);
      setDrawerActualTotal("");
      setDrawerNote("");
      showToast("success", "Cash drawer closed.");
      await refreshDrawerData();
    } catch (error: any) {
      setDrawerError(error?.response?.data?.error || error?.message || "Failed to close cash drawer.");
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
      return;
    }

    setSecurityFilterError("");
    setAuditPage(1);
    setLoginPage(1);
    setSecurityDateFilter({ ...securityDateDraft });
  }

  // clearing the filter returns both lists to their latest records without touching the rest of the page
  function clearSecurityFilters() {
    setSecurityFilterError("");
    setSecurityDateDraft(INITIAL_SECURITY_RANGE);
    setSecurityDateFilter(INITIAL_SECURITY_RANGE);
    setAuditPage(1);
    setLoginPage(1);
  }

  if (loading) {
    return (
      <div className="flex h-[60vh] items-center justify-center font-semibold text-slate-400">
        Loading settings...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4">
        <div>
          <div className="text-[11px] font-extrabold uppercase  text-slate-400">
            Admin Settings
          </div>
          <div className="mt-1 text-[24px] font-extrabold  text-slate-900">
            Operational settings and controls
          </div>
          <div className="mt-1 text-[13px] text-slate-500">
            Brands, billing defaults, audit visibility, and backup actions in
            one admin workspace.
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Active Brands"
          value={brands.filter((brand) => brand.active).length}
          hint={`${brands.length} total brands configured`}
          tone="info"
        />
        <Stat
          label="Low / Out Stock"
          value={`${lowStockProducts.length} / ${outOfStockProducts.length}`}
          hint="Active products currently below threshold or out of stock"
          tone={
            lowStockProducts.length + outOfStockProducts.length > 0
              ? "danger"
              : "neutral"
          }
        />
        <Stat
          label="Staff Accounts"
          value={activeUsers.length}
          hint={`${adminUsers.length} admins, ${managerUsers.length} managers, ${cashierUsers.length} cashiers, ${staffUsers.length} staff active`}
          tone="success"
        />
        <Stat
          label="Failed Logins"
          value={failedLoginCount}
          hint="Recent failed login attempts for admin review"
          tone={failedLoginCount > 0 ? "danger" : "neutral"}
        />
      </div>

      {/* these tabs keep the admin tools separated so the page does not feel overloaded all at once */}
      <div className="flex flex-wrap gap-2">
        {(
          [
            { key: "overview", label: "Business Rules" },
            { key: "cashier-controls", label: "Cashier Controls" },
            { key: "brands", label: "Brand Management" },
            { key: "audit", label: "Audit & Security" },
            { key: "backup", label: "Backup" },
          ] as Array<{ key: TabKey; label: string }>
        ).map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={cn(
              "rounded-full border px-4 py-2 text-[12px] font-extrabold transition",
              tab === item.key
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          {/* the overview tab starts with two wider cards because these settings need explanation text as much as input fields */}
          <Card>
            <div className="flex flex-col gap-3 border-b border-[#CFCFD3] px-5 py-4 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="text-[18px] font-extrabold text-[#000000]">
                  Business defaults
                </div>
              </div>
              <div className="flex items-center gap-3">
                {defaultsDirty ? (
                  <Pill tone="warning">Unsaved changes</Pill>
                ) : (
                  <Pill tone="success">Saved</Pill>
                )}
                <Button
                  variant="primary"
                  icon="save"
                  onClick={() => setShowDefaultsConfirm(true)}
                  disabled={!defaultsDirty}
                >
                  Update
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 p-5 lg:grid-cols-3">
              <div className="rounded-[16px] border border-[#CFCFD3] bg-[#F3F4F6]/70 p-4">
                <div className="text-[13px] font-extrabold text-[#000000]">
                  Stock alert threshold
                </div>
                <div className="mt-1 text-[12px] text-[#8C8889]">
                  Applied automatically when a product uses the business default
                  stock alert threshold.
                </div>
                <input
                  type="number"
                  min={0}
                  value={defaultLowStock}
                  onChange={(e) =>
                    setDefaultLowStock(Math.max(0, Number(e.target.value || 0)))
                  }
                  aria-label="Stock alert threshold"
                  className="mt-4 w-full rounded-[14px] border border-[#CFCFD3] bg-white px-3 py-2 text-[14px] text-[#000000] outline-none focus:border-[#11120d]"
                />
              </div>
              <div className="rounded-[16px] border border-[#CFCFD3] bg-[#F3F4F6]/70 p-4">
                <div className="text-[13px] font-extrabold text-[#000000]">
                  Wholesale quantity default
                </div>
                <div className="mt-1 text-[12px] text-[#8C8889]">
                  Applied automatically when a product uses the business default
                  wholesale threshold.
                </div>
                <input
                  type="number"
                  min={1}
                  value={wholesaleQtyThreshold}
                  onChange={(e) =>
                    setWholesaleQtyThreshold(
                      Math.max(1, Number(e.target.value || 1)),
                    )
                  }
                  aria-label="Wholesale quantity default"
                  className="mt-4 w-full rounded-[14px] border border-[#CFCFD3] bg-white px-3 py-2 text-[14px] text-[#000000] outline-none focus:border-[#11120d]"
                />
              </div>
              <div className="rounded-[16px] border border-[#CFCFD3] bg-[#F3F4F6]/70 p-4">
                <div className="text-[13px] font-extrabold text-[#000000]">
                  Loyalty discount percentage
                </div>
                <div className="mt-1 text-[12px] text-[#8C8889]">
                  Used as the admin default in the Customer Discounts flow.
                </div>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={loyaltyDiscountPercent}
                  onChange={(e) =>
                    setLoyaltyDiscountPercent(
                      clampPercent(Number(e.target.value || 0)),
                    )
                  }
                  aria-label="Loyalty discount percentage"
                  className="mt-4 w-full rounded-[14px] border border-[#CFCFD3] bg-white px-3 py-2 text-[14px] text-[#000000] outline-none focus:border-[#11120d]"
                />
              </div>
              <div className="rounded-[16px] border border-[#CFCFD3] bg-[#F3F4F6]/70 p-4">
                <div className="text-[13px] font-extrabold text-[#000000]">
                  Return window days
                </div>
                <div className="mt-1 text-[12px] text-[#8C8889]">
                  Default number of days after billing where returns should be accepted.
                </div>
                <input
                  type="number"
                  min={0}
                  value={returnWindowDays}
                  onChange={(e) =>
                    setReturnWindowDays(Math.max(0, Number(e.target.value || 0)))
                  }
                  aria-label="Return window days"
                  className="mt-4 w-full rounded-[14px] border border-[#CFCFD3] bg-white px-3 py-2 text-[14px] text-[#000000] outline-none focus:border-[#11120d]"
                />
              </div>
              <div className="rounded-[16px] border border-[#CFCFD3] bg-[#F3F4F6]/70 p-4">
                <div className="text-[13px] font-extrabold text-[#000000]">
                  Held bill expiry hours
                </div>
                <div className="mt-1 text-[12px] text-[#8C8889]">
                  Guides how long parked bills should stay before cleanup or review.
                </div>
                <input
                  type="number"
                  min={1}
                  value={parkedBillExpiryHours}
                  onChange={(e) =>
                    setParkedBillExpiryHours(Math.max(1, Number(e.target.value || 1)))
                  }
                  aria-label="Held bill expiry hours"
                  className="mt-4 w-full rounded-[14px] border border-[#CFCFD3] bg-white px-3 py-2 text-[14px] text-[#000000] outline-none focus:border-[#11120d]"
                />
              </div>
              <div className="rounded-[16px] border border-[#CFCFD3] bg-[#F3F4F6]/70 p-4">
                <div className="text-[13px] font-extrabold text-[#000000]">
                  Draft request expiry minutes
                </div>
                <div className="mt-1 text-[12px] text-[#8C8889]">
                  Future staff draft requests can use this timeout.
                </div>
                <input
                  type="number"
                  min={1}
                  value={draftRequestExpiryMinutes}
                  onChange={(e) =>
                    setDraftRequestExpiryMinutes(
                      Math.max(1, Number(e.target.value || 1)),
                    )
                  }
                  aria-label="Draft request expiry minutes"
                  className="mt-4 w-full rounded-[14px] border border-[#CFCFD3] bg-white px-3 py-2 text-[14px] text-[#000000] outline-none focus:border-[#11120d]"
                />
              </div>
            </div>
          </Card>

          <Card>
            <div className="flex flex-col gap-3 border-b border-[#CFCFD3] px-5 py-4 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="text-[18px] font-extrabold text-[#000000]">
                  Cash drawer
                </div>
                <div className="mt-1 text-[12px] font-semibold text-[#8C8889]">
                  Track opening float, cash sales, cash in/out, and closing difference.
                </div>
              </div>
              <Pill tone={currentDrawer ? "success" : "neutral"}>
                {currentDrawer ? "Open" : "Closed"}
              </Pill>
            </div>
            <div className="space-y-4 p-5">
              {currentDrawer ? (
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  {[
                    ["Opening", currentDrawer.openingFloat],
                    ["Cash sales", currentDrawer.cashSalesTotal],
                    ["Cash in", currentDrawer.cashInTotal],
                    ["Cash out", currentDrawer.cashOutTotal],
                    ["Expected", currentDrawer.expectedTotal],
                    ["Actual", currentDrawer.actualTotal ?? 0],
                    ["Difference", currentDrawer.difference ?? 0],
                  ].map(([label, value]) => (
                    <div
                      key={String(label)}
                      className="rounded-[14px] border border-[#CFCFD3] bg-[#F3F4F6]/70 p-3"
                    >
                      <div className="text-[11px] font-extrabold uppercase text-[#8C8889]">
                        {label}
                      </div>
                      <div className="mt-1 font-mono text-[15px] font-extrabold text-[#000000]">
                        {formatNpr(Number(value || 0))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="grid gap-3 md:grid-cols-3">
                {!currentDrawer ? (
                  <input
                    value={drawerOpeningFloat}
                    onChange={(e) => setDrawerOpeningFloat(e.target.value.replace(/[^\d.]/g, ""))}
                    placeholder="Opening float"
                    className="h-[42px] rounded-[14px] border border-[#CFCFD3] px-3 text-[13px] font-bold outline-none"
                  />
                ) : (
                  <>
                    <input
                      value={drawerAmount}
                      onChange={(e) => setDrawerAmount(e.target.value.replace(/[^\d.]/g, ""))}
                      placeholder="Cash in/out amount"
                      className="h-[42px] rounded-[14px] border border-[#CFCFD3] px-3 text-[13px] font-bold outline-none"
                    />
                    <input
                      value={drawerActualTotal}
                      onChange={(e) => setDrawerActualTotal(e.target.value.replace(/[^\d.]/g, ""))}
                      placeholder="Actual cash when closing"
                      className="h-[42px] rounded-[14px] border border-[#CFCFD3] px-3 text-[13px] font-bold outline-none"
                    />
                  </>
                )}
                <input
                  value={drawerNote}
                  onChange={(e) => setDrawerNote(e.target.value)}
                  placeholder="Optional note"
                  className="h-[42px] rounded-[14px] border border-[#CFCFD3] px-3 text-[13px] font-bold outline-none"
                />
              </div>

              <div className="flex flex-wrap gap-2">
                {!currentDrawer ? (
                  <Button
                    variant="primary"
                    icon="point_of_sale"
                    onClick={handleOpenDrawer}
                    disabled={drawerBusy}
                  >
                    Open Drawer
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="secondary"
                      icon="add"
                      onClick={() => handleDrawerEvent("CASH_IN")}
                      disabled={drawerBusy}
                    >
                      Cash In
                    </Button>
                    <Button
                      variant="secondary"
                      icon="remove"
                      onClick={() => handleDrawerEvent("CASH_OUT")}
                      disabled={drawerBusy}
                    >
                      Cash Out
                    </Button>
                    <Button
                      variant="primary"
                      icon="lock"
                      onClick={handleCloseDrawer}
                      disabled={drawerBusy}
                    >
                      Close Drawer
                    </Button>
                  </>
                )}
                <Button
                  variant="secondary"
                  icon="sync"
                  onClick={refreshDrawerData}
                  disabled={drawerBusy}
                >
                  Refresh
                </Button>
              </div>

              {drawerError ? (
                <div className="rounded-[14px] border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-semibold text-rose-700">
                  {drawerError}
                </div>
              ) : null}

              <div className="rounded-[14px] border border-[#CFCFD3] bg-[#F8F9FA] p-3">
                <div className="text-[12px] font-extrabold text-[#000000]">
                  Recent drawer sessions
                </div>
                <div className="mt-2 space-y-2">
                  {drawerHistory.slice(0, 4).map((drawer) => (
                    <div
                      key={drawer.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] bg-white px-3 py-2 text-[12px] font-semibold text-[#565449]"
                    >
                      <span>{drawer.cashier?.name || "Cashier"} | {drawer.status}</span>
                      <span>{formatDateTime(drawer.openedAt)}</span>
                      <span className="font-mono font-extrabold">
                        Expected {formatNpr(drawer.expectedTotal)}
                      </span>
                    </div>
                  ))}
                  {drawerHistory.length === 0 ? (
                    <div className="text-[12px] font-semibold text-[#8C8889]">
                      No drawer sessions recorded yet.
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </Card>

          <Card>
            <div className="border-b border-slate-100 px-5 py-5">
              <div className="text-[19px] font-extrabold text-slate-900">
                With Great Power Comes Great Responsibility!
              </div>
              <div className="mt-1 text-[12px] text-slate-500">
                What Admin can Control/ View
              </div>
            </div>

            <div className="space-y-3 p-5 text-[13px] text-slate-600">
              <div className="rounded-[16px] border border-slate-200 bg-slate-50/60 p-4">
                View Audit Logs related to updates inside the database through
                the app
              </div>
              <div className="rounded-[16px] border border-slate-200 bg-slate-50/60 p-4">
                Login attempts of both roles: email, success or failure, IP, and
                exact timestamp.
              </div>
              <div className="rounded-[16px] border border-slate-200 bg-slate-50/60 p-4">
                Brand management, stock threshold update, loyalty, and backup
                actions.
              </div>
            </div>
          </Card>
        </div>
      ) : null}

      {tab === "cashier-controls" ? (
        <Card>
          <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-5 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-[18px] font-extrabold text-slate-900">
                Cashier controls
              </div>
              <div className="mt-1 text-[12px] font-semibold text-slate-500">
                Allow selected cashiers to create discounted customers. Sensitive actions are prepared here for the PIN phase.
              </div>
            </div>
            <Pill tone="info">
              {cashierPrivileges.filter((row) => row.privilege.canCreateDiscountedCustomer).length} authorized
            </Pill>
          </div>

          <div className="border-b border-slate-100 px-5 py-5">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
              <div className="rounded-[16px] border border-slate-200 bg-slate-50/70 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Icon name="pin" className="text-slate-500" />
                  <div className="text-[14px] font-extrabold text-slate-900">
                    4-digit override PIN
                  </div>
                  <Pill tone={overridePolicy.pinConfigured ? "success" : "warning"}>
                    {overridePolicy.pinConfigured ? "Configured" : "Not set"}
                  </Pill>
                </div>
                <div className="mt-2 text-[12px] font-semibold leading-5 text-slate-500">
                  Cashiers with permission must enter this PIN for manual bill discounts,
                  payment voids, and future billing price overrides. Admin actions do not
                  require the PIN.
                </div>
                {overridePolicy.pinUpdatedAt ? (
                  <div className="mt-2 text-[11px] font-bold text-slate-400">
                    Last updated {new Date(overridePolicy.pinUpdatedAt).toLocaleString()}
                  </div>
                ) : null}
              </div>

              <div className="rounded-[16px] border border-slate-200 bg-white p-4">
                <label className="text-[12px] font-extrabold text-slate-600">
                  Set / replace PIN
                </label>
                <div className="mt-2 flex gap-2">
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={4}
                    value={overridePinDraft}
                    onChange={(event) => {
                      setOverridePinDraft(event.target.value.replace(/\D/g, "").slice(0, 4));
                      setOverridePinError("");
                    }}
                    placeholder="1234"
                    className="h-[42px] min-w-0 flex-1 rounded-[12px] border border-slate-200 px-3 text-[15px] font-extrabold tracking-[4px] outline-none focus:border-slate-900"
                  />
                  <button
                    type="button"
                    disabled={savingOverridePin || overridePinDraft.length !== 4}
                    onClick={() => void saveOverridePin()}
                    className="h-[42px] rounded-[12px] bg-slate-950 px-4 text-[12px] font-extrabold text-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {savingOverridePin ? "Saving" : "Save"}
                  </button>
                </div>
                {overridePinError ? (
                  <div className="mt-2 text-[12px] font-bold text-rose-600">
                    {overridePinError}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[1180px] text-left">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-[11px] font-extrabold uppercase text-slate-500">
                  <th className="px-5 py-3">Cashier</th>
                  <th className="px-5 py-3">Discounted Customer</th>
                  <th className="px-5 py-3">Max Loyalty</th>
                  <th className="px-5 py-3">Max Wholesale</th>
                  <th className="px-5 py-3">Future PIN Actions</th>
                  <th className="px-5 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {cashierPrivileges.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-12 text-center text-[13px] font-semibold text-slate-400">
                      No cashier accounts found.
                    </td>
                  </tr>
                ) : (
                  cashierPrivileges.map((cashier) => {
                    const privilege = cashier.privilege;
                    const saving = savingCashierPrivilegeId === cashier.id;

                    return (
                      <tr key={cashier.id} className="align-top text-[13px]">
                        <td className="px-5 py-4">
                          <div className="font-extrabold text-slate-900">{cashier.name}</div>
                          <div className="mt-1 text-[12px] font-semibold text-slate-500">{cashier.email}</div>
                        </td>
                        <td className="px-5 py-4">
                          <div className="space-y-3">
                            <div>
                              <label className="inline-flex cursor-pointer items-center gap-3">
                                <input
                                  type="checkbox"
                                  checked={privilege.canCreateDiscountedCustomer}
                                  disabled={saving || !cashier.isActive}
                                  onChange={(event) =>
                                    saveCashierPrivilege(cashier, {
                                      canCreateDiscountedCustomer: event.target.checked,
                                    })
                                  }
                                  className="h-4 w-4 accent-slate-900"
                                />
                                <span className="font-bold text-slate-700">
                                  Can create customer discount
                                </span>
                              </label>
                              <div className="mt-1 max-w-[280px] text-[12px] font-semibold text-slate-500">
                                Creates discounted customers immediately and logs admin history.
                              </div>
                            </div>

                            <div>
                              <label className="inline-flex cursor-pointer items-center gap-3">
                                <input
                                  type="checkbox"
                                  checked={privilege.canRequestCustomerDiscount !== false}
                                  disabled={saving || !cashier.isActive}
                                  onChange={(event) =>
                                    saveCashierPrivilege(cashier, {
                                      canRequestCustomerDiscount: event.target.checked,
                                    })
                                  }
                                  className="h-4 w-4 accent-slate-900"
                                />
                                <span className="font-bold text-slate-700">
                                  Can request admin approval
                                </span>
                              </label>
                              <div className="mt-1 max-w-[280px] text-[12px] font-semibold text-slate-500">
                                Lets cashier submit new customer discount requests for admin review.
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-4">
                          <input
                            type="number"
                            min={0}
                            max={100}
                            value={privilege.maxCustomerLoyaltyPercent}
                            disabled={saving}
                            onChange={(event) =>
                              saveCashierPrivilege(cashier, {
                                maxCustomerLoyaltyPercent: Number(event.target.value),
                              })
                            }
                            className="h-[38px] w-[110px] rounded-[12px] border border-slate-200 px-3 font-bold outline-none focus:border-slate-900"
                          />
                          <span className="ml-2 font-bold text-slate-500">%</span>
                        </td>
                        <td className="px-5 py-4">
                          <input
                            type="number"
                            min={0}
                            max={100}
                            value={privilege.maxCustomerWholesalePercent}
                            disabled={saving}
                            onChange={(event) =>
                              saveCashierPrivilege(cashier, {
                                maxCustomerWholesalePercent: Number(event.target.value),
                              })
                            }
                            className="h-[38px] w-[110px] rounded-[12px] border border-slate-200 px-3 font-bold outline-none focus:border-slate-900"
                          />
                          <span className="ml-2 font-bold text-slate-500">%</span>
                        </td>
                        <td className="px-5 py-4">
                          <div className="grid grid-cols-1 gap-2">
                            {[
                              ["canOverrideBillingPrice", "Price override"],
                              ["canApplyManualDiscount", "Manual discount"],
                              ["canVoidPayment", "Void payment"],
                            ].map(([key, label]) => (
                              <label key={key} className="inline-flex cursor-pointer items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={Boolean((privilege as any)[key])}
                                  disabled={saving || !cashier.isActive}
                                  onChange={(event) =>
                                    saveCashierPrivilege(cashier, {
                                      [key]: event.target.checked,
                                    } as Partial<CashierPrivilegeRow["privilege"]>)
                                  }
                                  className="h-4 w-4 accent-slate-900"
                                />
                                <span className="text-[12px] font-bold text-slate-600">{label}</span>
                              </label>
                            ))}
                          </div>
                        </td>
                        <td className="px-5 py-4">
                          <div className="space-y-2">
                            <Pill tone={cashier.isActive ? "success" : "danger"}>
                              {cashier.isActive ? "Active" : "Inactive"}
                            </Pill>
                            {saving ? <Pill tone="warning">Saving</Pill> : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {tab === "brands" ? (
        <Card>
          {/* the brands tab uses one large management surface because search, filters, and the table all belong to the same task */}
          <div className="flex flex-col gap-4 border-b border-slate-100 px-5 py-4 md:flex-row md:items-end md:justify-between">
            <div>
              <div className="text-[15px] font-extrabold text-slate-900">
                Brand management
              </div>
              <div className="mt-1 text-[12px] text-slate-500">
                Add brands, review linked products, and deactivate brands with a
                clear view of what will be affected.
              </div>
            </div>
            <div className="flex items-center gap-3">
              <select
                value={brandSelection}
                onChange={(e) => setBrandSelection(e.target.value)}
                aria-label="Brand selection"
                className="w-[220px] rounded-[14px] border border-slate-200 bg-white px-3 py-2 text-[14px] font-semibold outline-none"
              >
                <option value="all">All Brands</option>
                {brandOptions.map((brand) => (
                  <option key={brand.id} value={brand.id}>
                    {brand.name}
                  </option>
                ))}
              </select>
              <input
                value={brandQuery}
                onChange={(e) => setBrandQuery(e.target.value)}
                placeholder="Search brand..."
                aria-label="Search brand"
                className="w-[220px] rounded-[14px] border border-slate-200 bg-white px-3 py-2 text-[14px] outline-none"
              />
              <Button
                variant="primary"
                icon="add"
                onClick={() => {
                  resetBrandForm();
                  setShowBrandForm(true);
                }}
              >
                Add Brand
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 px-5 pt-4">
            {(["all", "active", "inactive"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setBrandFilter(value)}
                className={cn(
                  "rounded-full border px-4 py-2 text-[12px] font-extrabold transition",
                  brandFilter === value
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
                )}
              >
                {value === "all"
                  ? "All brands"
                  : value.charAt(0).toUpperCase() + value.slice(1)}
              </button>
            ))}
          </div>
          <div className="overflow-x-auto p-5">
            <table className="w-full min-w-[760px] border-collapse text-left">
              <thead>
                <tr className="border-b border-slate-100 text-[11px] font-extrabold uppercase  text-slate-400">
                  <th className="px-3 py-3">Brand</th>
                  <th className="px-3 py-3">Products</th>
                  <th className="px-3 py-3">Active Products</th>
                  <th className="px-3 py-3">Low Stock</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {pagedBrands.map((brand) => {
                  const stats = brandStats[brand.id] || {
                    total: 0,
                    active: 0,
                    low: 0,
                  };
                  return (
                    <tr key={brand.id} className="hover:bg-slate-50/70">
                      <td className="px-3 py-4 font-extrabold text-slate-900">
                        {brand.name}
                      </td>
                      <td className="px-3 py-4 text-[13px] font-semibold text-slate-700">
                        {stats.total}
                      </td>
                      <td className="px-3 py-4 text-[13px] font-semibold text-slate-700">
                        {stats.active}
                      </td>
                      <td className="px-3 py-4 text-[13px] font-semibold text-slate-700">
                        {stats.low}
                      </td>
                      <td className="px-3 py-4">
                        <Pill tone={brand.active ? "success" : "neutral"}>
                          {brand.active ? "Active" : "Inactive"}
                        </Pill>
                      </td>
                      <td className="px-3 py-4">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="secondary"
                            icon="edit"
                            onClick={() => {
                              setEditingBrand(brand);
                              setBrandName(brand.name);
                              setBrandActive(brand.active);
                              setBrandError("");
                              setShowBrandForm(true);
                            }}
                          >
                            Edit
                          </Button>
                          <Button
                            variant={brand.active ? "danger" : "secondary"}
                            icon={brand.active ? "block" : "check_circle"}
                            onClick={() => requestToggleBrandStatus(brand)}
                          >
                            {brand.active ? "Deactivate" : "Activate"}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filteredBrands.length === 0 ? (
              <div className="flex min-h-[180px] items-center justify-center rounded-[18px] border border-dashed border-slate-200 bg-slate-50/60 text-[13px] font-semibold text-slate-400">
                No brands match the current filters.
              </div>
            ) : null}
            <PaginationBar
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
              className="mt-4 rounded-[18px] border border-[#E5E7EB]"
            />
          </div>
        </Card>
      ) : null}

      {tab === "audit" ? (
        <div className="space-y-6">
          {/* shared date range filter for both audit lists */}
          <div className="rounded-[18px] border border-[#E5E7EB] bg-white p-5">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="text-[16px] font-extrabold">
                  Security Filters
                </div>
                <div className="mt-1 text-[13px] font-medium text-[#8C8889]">
                  Filter both audit logs and login attempts by the same created
                  date range.
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  type="date"
                  aria-label="From date"
                  value={securityDateDraft.from}
                  onChange={(e) =>
                    setSecurityDateDraft((current) => ({
                      ...current,
                      from: e.target.value,
                    }))
                  }
                  className="h-[42px] rounded-[14px] border border-[#CFCFD3] px-4 text-[13px] font-semibold outline-none focus:border-[#11120d] xl:w-[200px]"
                />
                <input
                  type="date"
                  aria-label="To date"
                  value={securityDateDraft.to}
                  onChange={(e) =>
                    setSecurityDateDraft((current) => ({
                      ...current,
                      to: e.target.value,
                    }))
                  }
                  className="h-[42px] rounded-[14px] border border-[#CFCFD3] px-4 text-[13px] font-semibold outline-none focus:border-[#11120d] xl:w-[200px]"
                />
                <Button
                  variant="primary"
                  icon="filter_alt"
                  onClick={applySecurityFilters}
                >
                  Apply
                </Button>
                <Button icon="restart_alt" onClick={clearSecurityFilters}>
                  Clear
                </Button>
              </div>
            </div>

            {securityFilterError ? (
              <div className="mt-4 rounded-[14px] border border-[#FECDD3] bg-[#FFF1F2] px-4 py-3 text-[13px] font-semibold text-[#BE123C]">
                {securityFilterError}
              </div>
            ) : null}
          </div>

          {/* audit logs — full width */}
          <Card>
            <div className="border-b border-slate-100 px-6 py-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-[17px] font-extrabold text-slate-900">
                    Audit Logs
                  </div>
                  <div className="mt-1 text-[13px] text-slate-500">
                    Actor, action, entity, invoice reference, and timestamp for
                    every tracked operation.
                  </div>
                </div>
                <Pill tone="neutral">{auditTotal} total</Pill>
              </div>
            </div>
            <div className="p-6">
              {securityLoading ? (
                <div className="flex items-center justify-center py-12 text-[13px] font-semibold text-slate-400">
                  Loading audit logs…
                </div>
              ) : auditLogs.length === 0 ? (
                <div className="rounded-[16px] border border-dashed border-slate-200 bg-slate-50/60 px-4 py-10 text-center text-[13px] font-semibold text-slate-500">
                  No audit logs matched the selected date range.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] border-collapse text-left">
                    <thead>
                      <tr className="border-b border-slate-100 text-[11px] font-extrabold uppercase tracking-wide text-slate-400">
                        <th className="px-4 py-3">Actor</th>
                        <th className="px-4 py-3">Action</th>
                        <th className="px-4 py-3">Reference</th>
                        <th className="px-4 py-3 text-right">Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {auditLogs.map((log) => (
                        <tr key={log.id} className="hover:bg-slate-50/70">
                          <td className="px-4 py-3.5">
                            <div className="text-[14px] font-extrabold text-slate-900">
                              {log.actor?.name || "System"}
                            </div>
                          </td>
                          <td className="px-4 py-3.5">
                            <Pill tone="info">{log.action}</Pill>
                          </td>
                          <td className="px-4 py-3.5">
                            <div className="text-[13px] font-semibold text-slate-600">
                              {String(log.meta?.invoiceNo || log.entityType)} /{" "}
                              {log.entityId}
                            </div>
                          </td>
                          <td className="px-4 py-3.5 text-right">
                            <div className="text-[12px] font-semibold text-slate-500">
                              {formatDateTime(log.createdAt)}
                            </div>
                            <div className="mt-0.5 text-[11px] text-slate-400">
                              {formatRelativeTime(log.createdAt)}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <PaginationBar
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
                className="mt-4 rounded-[18px] border border-[#E5E7EB]"
              />
            </div>
          </Card>

          {/* login attempts — full width */}
          <Card>
            <div className="border-b border-slate-100 px-6 py-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-[17px] font-extrabold text-slate-900">
                    Login Attempts
                  </div>
                  <div className="mt-1 text-[13px] text-slate-500">
                    Email, success or failure status, IP address, and exact
                    timestamp for every login.
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {failedLoginCount > 0 ? (
                    <Pill tone="danger">{failedLoginCount} failed</Pill>
                  ) : null}
                  <Pill tone="neutral">{loginTotal} total</Pill>
                </div>
              </div>
            </div>
            <div className="p-6">
              {securityLoading ? (
                <div className="flex items-center justify-center py-12 text-[13px] font-semibold text-slate-400">
                  Loading login attempts…
                </div>
              ) : loginAttempts.length === 0 ? (
                <div className="rounded-[16px] border border-dashed border-slate-200 bg-slate-50/60 px-4 py-10 text-center text-[13px] font-semibold text-slate-500">
                  No login attempts matched the selected date range.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] border-collapse text-left">
                    <thead>
                      <tr className="border-b border-slate-100 text-[11px] font-extrabold uppercase tracking-wide text-slate-400">
                        <th className="px-4 py-3">Email</th>
                        <th className="px-4 py-3">IP Address</th>
                        <th className="px-4 py-3">Status</th>
                        <th className="px-4 py-3 text-right">Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {loginAttempts.map((attempt) => (
                        <tr key={attempt.id} className="hover:bg-slate-50/70">
                          <td className="px-4 py-3.5">
                            <div className="text-[14px] font-extrabold text-slate-900">
                              {attempt.email}
                            </div>
                          </td>
                          <td className="px-4 py-3.5">
                            <div className="text-[13px] font-semibold text-slate-500">
                              {attempt.ip || "Unavailable"}
                            </div>
                          </td>
                          <td className="px-4 py-3.5">
                            <Pill tone={attempt.success ? "success" : "danger"}>
                              {attempt.success ? "Success" : "Failed"}
                            </Pill>
                          </td>
                          <td className="px-4 py-3.5 text-right">
                            <div className="text-[12px] font-semibold text-slate-500">
                              {formatDateTime(attempt.createdAt)}
                            </div>
                            <div className="mt-0.5 text-[11px] text-slate-400">
                              {formatRelativeTime(attempt.createdAt)}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <PaginationBar
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
                className="mt-4 rounded-[18px] border border-[#E5E7EB]"
              />
            </div>
          </Card>

          {/* staff snapshot — separate standalone card */}
          <Card>
            <div className="border-b border-slate-100 px-6 py-5">
              <div className="text-[17px] font-extrabold text-slate-900">
                Staff Snapshot
              </div>
              <div className="mt-1 text-[13px] text-slate-500">
                Quick overview of registered staff accounts and their last login
                activity.
              </div>
            </div>
            <div className="p-6">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {users.map((user) => (
                  <div
                    key={user.id}
                    className="flex items-center justify-between gap-3 rounded-[14px] border border-slate-200 bg-slate-50/60 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[14px] font-extrabold text-slate-900">
                        {user.name}
                      </div>
                      <div className="truncate text-[12px] text-slate-500">
                        {user.email}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <Pill tone={user.role === "ADMIN" ? "info" : "neutral"}>
                        {user.role}
                      </Pill>
                      <div className="mt-1 text-[11px] font-semibold text-slate-500">
                        {formatRelativeTime(user.lastLogin)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {users.length === 0 ? (
                <div className="rounded-[16px] border border-dashed border-slate-200 bg-slate-50/60 px-4 py-8 text-center text-[13px] font-semibold text-slate-500">
                  No staff accounts found.
                </div>
              ) : null}
            </div>
          </Card>
        </div>
      ) : null}

      {tab === "backup" ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card>
            <div className="border-b border-slate-100 px-5 py-4">
              <div className="text-[15px] font-extrabold text-slate-900">
                Manual database backup
              </div>
              <div className="mt-1 text-[12px] text-slate-500">
                Create an admin-only backup file whenever you need a current
                recovery snapshot.
              </div>
            </div>
            <div className="space-y-4 p-5">
              <div className="rounded-[16px] border border-slate-200 bg-slate-50/60 p-4 text-[13px] text-slate-600">
                Generate a point-in-time backup of the current KhataSathi
                database and store it on the server for recovery and reference.
              </div>
              <Button
                variant="primary"
                icon="cloud_upload"
                onClick={() => setShowBackupConfirm(true)}
                disabled={backupBusy}
              >
                {backupBusy ? "Creating backup..." : "Backup Database"}
              </Button>
            </div>
          </Card>
          <Card>
            <div className="border-b border-slate-100 px-5 py-4">
              <div className="text-[15px] font-extrabold text-slate-900">
                Recommended backup details
              </div>
              <div className="mt-1 text-[12px] text-slate-500">
                What this backup includes and how admins should use it.
              </div>
            </div>
            <div className="space-y-3 p-5 text-[13px] text-slate-600">
              <div className="rounded-[16px] border border-slate-200 bg-slate-50/60 p-4">
                Backup files include product, invoice, payment, customer,
                inventory, and user-related database records.
              </div>
              <div className="rounded-[16px] border border-slate-200 bg-slate-50/60 p-4">
                Use manual backups for recovery and reference before major
                operational changes or maintenance work.
              </div>
              <div className="rounded-[16px] border border-slate-200 bg-slate-50/60 p-4">
                Only admins can trigger this action, and successful backup
                requests should remain visible through audit review.
              </div>
            </div>
          </Card>

          <Card className="lg:col-span-2">
            <div className="border-b border-slate-100 px-5 py-4">
              <div className="text-[15px] font-extrabold text-slate-900">
                Scheduled automatic backups
              </div>
              <div className="mt-1 text-[12px] text-slate-500">
                Run backups automatically using the backend scheduler.
              </div>
            </div>
            <div className="grid gap-4 p-5 lg:grid-cols-[220px_1fr_180px_180px] lg:items-end">
              <label className="flex items-center justify-between rounded-[16px] border border-slate-200 bg-slate-50/60 px-4 py-3">
                <div>
                  <div className="text-[13px] font-extrabold text-slate-900">
                    Enabled
                  </div>
                  <div className="mt-1 text-[11px] text-slate-500">
                    {backupSchedule.enabled ? "Currently active" : "Currently off"}
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={backupScheduleDraft.enabled}
                  onChange={(event) =>
                    setBackupScheduleDraft((current) => ({
                      ...current,
                      enabled: event.target.checked,
                    }))
                  }
                  className="h-4 w-4"
                />
              </label>

              <div>
                <div className="text-[11px] font-extrabold uppercase text-slate-400">
                  Frequency
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {(["DAILY", "WEEKLY"] as const).map((frequency) => (
                    <button
                      key={frequency}
                      type="button"
                      onClick={() =>
                        setBackupScheduleDraft((current) => ({
                          ...current,
                          frequency,
                        }))
                      }
                      className={cn(
                        "h-[42px] rounded-[14px] border text-[12px] font-extrabold transition",
                        backupScheduleDraft.frequency === frequency
                          ? "border-slate-900 bg-slate-900 text-white"
                          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
                      )}
                    >
                      {frequency === "DAILY" ? "Daily" : "Weekly"}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-[11px] font-extrabold uppercase text-slate-400">
                  Time
                </label>
                <input
                  type="time"
                  value={backupScheduleDraft.timeOfDay}
                  onChange={(event) =>
                    setBackupScheduleDraft((current) => ({
                      ...current,
                      timeOfDay: event.target.value,
                    }))
                  }
                  className="mt-2 h-[42px] w-full rounded-[14px] border border-slate-200 bg-white px-3 text-[13px] font-bold text-slate-800 outline-none"
                />
              </div>

              {backupScheduleDraft.frequency === "WEEKLY" ? (
                <div>
                  <label className="text-[11px] font-extrabold uppercase text-slate-400">
                    Day
                  </label>
                  <select
                    value={backupScheduleDraft.dayOfWeek}
                    onChange={(event) =>
                      setBackupScheduleDraft((current) => ({
                        ...current,
                        dayOfWeek: Number(event.target.value),
                      }))
                    }
                    className="mt-2 h-[42px] w-full rounded-[14px] border border-slate-200 bg-white px-3 text-[13px] font-bold text-slate-800 outline-none"
                  >
                    {WEEKDAYS.map((day, index) => (
                      <option key={day} value={index}>
                        {day}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="rounded-[14px] border border-slate-200 bg-slate-50/60 px-4 py-3 text-[12px] font-semibold text-slate-500">
                  Daily at {backupScheduleDraft.timeOfDay}
                </div>
              )}
            </div>
            <div className="flex flex-col gap-3 border-t border-slate-100 px-5 py-4 md:flex-row md:items-center md:justify-between">
              <div className="text-[12px] font-semibold text-slate-500">
                Last scheduled run:{" "}
                <span className="font-extrabold text-slate-700">
                  {backupSchedule.lastRunAt
                    ? formatDateTime(backupSchedule.lastRunAt)
                    : "Never"}
                </span>
              </div>
              <div className="flex items-center gap-3">
                {backupScheduleError ? (
                  <span className="text-[12px] font-extrabold text-rose-600">
                    {backupScheduleError}
                  </span>
                ) : null}
                <Button
                  variant="primary"
                  icon="schedule"
                  onClick={() => setShowBackupScheduleConfirm(true)}
                  disabled={backupScheduleBusy}
                >
                  {backupScheduleBusy ? "Saving..." : "Save Schedule"}
                </Button>
              </div>
            </div>
          </Card>

          <Card className="lg:col-span-2">
            <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-4 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="text-[15px] font-extrabold text-slate-900">
                  Backup and restore history
                </div>
                <div className="mt-1 text-[12px] text-slate-500">
                  Recent backup jobs with status, file size, and admin actor.
                </div>
              </div>
              <Button
                icon="refresh"
                onClick={() => void loadData(false)}
                disabled={refreshing}
              >
                Refresh
              </Button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-left">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50 text-[11px] font-extrabold uppercase text-slate-400">
                    <th className="px-5 py-3">Job</th>
                    <th className="px-5 py-3">Status</th>
                    <th className="px-5 py-3">File</th>
                    <th className="px-5 py-3">Size</th>
                    <th className="px-5 py-3">Admin</th>
                    <th className="px-5 py-3">Completed</th>
                    <th className="px-5 py-3 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {backupHistory.map((backup) => (
                    <tr key={backup.id} className="text-[13px]">
                      <td className="px-5 py-4">
                        <div className="font-extrabold text-slate-900">
                          {backup.type === "RESTORE" ? "Restore" : "Backup"}
                        </div>
                        <div className="mt-1 text-[12px] text-slate-500">
                          {formatDateTime(backup.createdAt)}
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <Pill
                          tone={
                            backup.status === "SUCCESS"
                              ? "success"
                              : backup.status === "FAILED"
                                ? "danger"
                                : "warning"
                          }
                        >
                          {backup.status}
                        </Pill>
                        {backup.detail ? (
                          <div className="mt-2 max-w-[220px] truncate text-[11px] font-semibold text-rose-600">
                            {backup.detail}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-5 py-4">
                        <div className="max-w-[220px] truncate font-semibold text-slate-700">
                          {backup.filename || "-"}
                        </div>
                        {backup.message ? (
                          <div className="mt-1 text-[11px] text-slate-500">
                            {backup.message}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-5 py-4 font-mono font-bold text-slate-700">
                        {formatFileSize(backup.sizeBytes)}
                      </td>
                      <td className="px-5 py-4">
                        <div className="font-semibold text-slate-700">
                          {backup.createdBy?.name || "Unknown admin"}
                        </div>
                        <div className="mt-1 text-[11px] text-slate-500">
                          {backup.createdBy?.email || "-"}
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <div className="font-semibold text-slate-700">
                          {backup.completedAt
                            ? formatRelativeTime(backup.completedAt)
                            : "Running"}
                        </div>
                        {backup.completedAt ? (
                          <div className="mt-1 text-[11px] text-slate-500">
                            {formatDateTime(backup.completedAt)}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-5 py-4 text-right">
                        {backup.type === "BACKUP" &&
                        backup.status === "SUCCESS" ? (
                          <button
                            type="button"
                            onClick={() => requestRestoreBackup(backup)}
                            className="rounded-[12px] border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-extrabold text-rose-700 transition hover:bg-rose-100"
                          >
                            Restore
                          </button>
                        ) : (
                          <span className="text-[12px] font-semibold text-slate-400">
                            -
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {backupHistory.length === 0 ? (
              <div className="px-5 py-10 text-center text-[13px] font-semibold text-slate-500">
                No backup or restore jobs recorded yet.
              </div>
            ) : null}
          </Card>
        </div>
      ) : null}

      {showBrandForm ? (
        <ModalFrame
          open={showBrandForm}
          onClose={closeBrandForm}
          title={editingBrand ? "Edit brand" : "Add brand"}
          maxWidthClass="max-w-[620px]"
        >
          <div className="space-y-4">
            <div>
              <div className="text-[12px] font-extrabold uppercase  text-slate-400">
                Brand name
              </div>
              <input
                value={brandName}
                onChange={(e) => {
                  setBrandName(e.target.value);
                  setBrandError("");
                }}
                placeholder="e.g. CG Foods"
                className="mt-2 w-full rounded-[14px] border border-slate-200 bg-white px-3 py-2 text-[14px] outline-none"
              />
              {brandError ? (
                <div className="mt-2 text-[12px] font-extrabold text-rose-600">
                  {brandError}
                </div>
              ) : null}
            </div>
            <label className="flex items-center justify-between rounded-[16px] border border-slate-200 bg-slate-50/60 px-4 py-3">
              <div>
                <div className="text-[13px] font-extrabold text-slate-900">
                  Brand active
                </div>
                <div className="mt-1 text-[12px] text-slate-500">
                  If this brand is deactivated, linked products are also marked
                  inactive and removed from active selling flows.
                </div>
              </div>
              <input
                type="checkbox"
                checked={brandActive}
                onChange={(e) => setBrandActive(e.target.checked)}
                className="h-4 w-4"
              />
            </label>

            {editingBrand ? (
              <div className="rounded-[16px] border border-slate-200 bg-white">
                <div className="border-b border-slate-100 px-4 py-3">
                  <div className="text-[13px] font-extrabold text-slate-900">
                    Affiliated products
                  </div>
                  <div className="mt-1 text-[12px] text-slate-500">
                    Review the products linked to this brand before making
                    changes.
                  </div>
                </div>
                <div className="max-h-[240px] space-y-2 overflow-y-auto p-4">
                  {editingBrandProducts.map((product) => (
                    <div
                      key={product.id}
                      className="flex items-center justify-between gap-3 rounded-[14px] border border-slate-200 bg-slate-50/60 px-3 py-3"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-extrabold text-slate-900">
                          {product.name}
                        </div>
                        <div className="mt-1 text-[12px] text-slate-500">
                          SKU: {product.sku}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <Pill tone={product.active ? "success" : "neutral"}>
                          {product.active ? "Active" : "Inactive"}
                        </Pill>
                        <div className="mt-1 text-[11px] font-semibold text-slate-500">
                          Stock {product.stock}
                        </div>
                      </div>
                    </div>
                  ))}
                  {editingBrandProducts.length === 0 ? (
                    <div className="rounded-[14px] border border-dashed border-slate-200 bg-slate-50/60 px-4 py-6 text-center text-[12px] font-semibold text-slate-500">
                      No products are linked to this brand yet.
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className="flex items-center justify-end gap-3">
              <DialogButton onClick={closeBrandForm}>Cancel</DialogButton>
              <DialogButton variant="primary" icon="save" onClick={saveBrand}>
                Save Brand
              </DialogButton>
            </div>
          </div>
        </ModalFrame>
      ) : null}

      <ConfirmDialog
        open={!!pendingBrandDeactivation}
        title="Deactivate this brand?"
        message="This brand will be marked inactive. Products linked to this brand will also be deactivated and will no longer appear in active selling flows."
        confirmLabel={
          pendingBrandSave ? "Deactivate Brand" : "Deactivate Brand"
        }
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
              <div className="flex flex-wrap gap-2">
                {products
                  .filter(
                    (product) =>
                      product.brandId === pendingBrandDeactivation.id,
                  )
                  .slice(0, 8)
                  .map((product) => (
                    <Pill
                      key={product.id}
                      tone={product.active ? "warning" : "neutral"}
                    >
                      {product.name}
                    </Pill>
                  ))}
                {products.filter(
                  (product) => product.brandId === pendingBrandDeactivation.id,
                ).length > 8 ? (
                  <Pill tone="neutral">
                    +
                    {products.filter(
                      (product) =>
                        product.brandId === pendingBrandDeactivation.id,
                    ).length - 8}{" "}
                    more
                  </Pill>
                ) : null}
              </div>
            </div>
          ) : null
        }
      />

      <ConfirmDialog
        open={showDefaultsConfirm}
        title="Save business defaults?"
        message="These values will become the saved business defaults for products that follow admin defaults and for loyalty setup."
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
          title="Restore database backup"
          maxWidthClass="max-w-[620px]"
        >
          <div className="space-y-4">
            <div className="rounded-[16px] border border-rose-200 bg-rose-50 p-4 text-[13px] font-semibold text-rose-700">
              Restoring replaces the current database with the selected SQL
              backup. Create a fresh manual backup first if you need a rollback
              point.
            </div>

            <div className="rounded-[16px] border border-slate-200 bg-slate-50/60 p-4">
              <div className="text-[12px] font-extrabold uppercase text-slate-400">
                Selected backup
              </div>
              <div className="mt-2 font-extrabold text-slate-900">
                {restoreTarget.filename}
              </div>
              <div className="mt-1 text-[12px] font-semibold text-slate-500">
                {formatFileSize(restoreTarget.sizeBytes)} |{" "}
                {formatDateTime(restoreTarget.completedAt || restoreTarget.createdAt)}
              </div>
            </div>

            <div>
              <label className="text-[12px] font-extrabold uppercase text-slate-400">
                Type confirmation
              </label>
              <div className="mt-1 text-[12px] font-semibold text-slate-500">
                RESTORE {restoreTarget.filename}
              </div>
              <input
                value={restoreConfirmation}
                onChange={(event) => {
                  setRestoreConfirmation(event.target.value);
                  setRestoreError("");
                }}
                className="mt-2 w-full rounded-[14px] border border-slate-200 bg-white px-3 py-2 text-[14px] font-semibold text-slate-900 outline-none focus:border-slate-900"
                placeholder={`RESTORE ${restoreTarget.filename}`}
              />
              {restoreError ? (
                <div className="mt-2 text-[12px] font-extrabold text-rose-600">
                  {restoreError}
                </div>
              ) : null}
            </div>

            <div className="flex items-center justify-end gap-3">
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
                icon="restore"
                onClick={handleRestoreBackup}
                disabled={
                  restoreBusy ||
                  restoreConfirmation.trim() !==
                    `RESTORE ${restoreTarget.filename}`
                }
              >
                {restoreBusy ? "Restoring..." : "Restore Backup"}
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
