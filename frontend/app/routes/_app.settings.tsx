import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import Icon from "~/components/ui/Icon";
import {
  ConfirmDialog,
  DialogButton,
  ModalFrame,
  SuccessDialog,
} from "~/components/ui/Modal";
import {
  createBrandApi,
  listAuditLogsApi,
  listBrandsApi,
  listLoginAttemptsApi,
  listProductsApi,
  listUsersApi,
  triggerBackupApi,
  updateBrandApi,
} from "~/lib/api/endpoints";
import {
  LOCAL_SETTINGS_KEYS,
  readStoredNumber,
  writeStoredNumber,
} from "~/lib/settings/localSettings";

type TabKey = "overview" | "brands" | "audit" | "backup";
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
  role: "ADMIN" | "CASHIER";
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
type BackupResult = { filename?: string; filepath?: string; message?: string };

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

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

function clampPercent(v: number) {
  return Math.max(0, Math.min(100, v));
}

function buildBusinessDefaults(
  defaultLowStock: number,
  wholesaleQtyThreshold: number,
  loyaltyDiscountPercent: number,
) {
  return {
    defaultLowStock: Math.max(0, Math.floor(defaultLowStock)),
    wholesaleQtyThreshold: Math.max(1, Math.floor(wholesaleQtyThreshold)),
    loyaltyDiscountPercent: clampPercent(loyaltyDiscountPercent),
  };
}

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
        "rounded-[18px] border border-slate-200 bg-white shadow-sm",
        className,
      )}
    >
      {children}
    </div>
  );
}

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
        <div className="text-[11px] font-extrabold uppercase tracking-wider text-slate-400">
          {label}
        </div>
        <div
          className={cn(
            "mt-2 text-[28px] font-extrabold tracking-tight",
            valueTone,
          )}
        >
          {value}
        </div>
        <div className="mt-2 text-[12px] text-slate-500">{hint}</div>
      </div>
    </Card>
  );
}

export default function SettingsPage() {
  const [tab, setTab] = useState<TabKey>("overview");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [products, setProducts] = useState<ProductLite[]>([]);
  const [users, setUsers] = useState<UserLite[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogRow[]>([]);
  const [loginAttempts, setLoginAttempts] = useState<LoginAttemptRow[]>([]);
  const [brandQuery, setBrandQuery] = useState("");
  const [brandFilter, setBrandFilter] = useState<"all" | "active" | "inactive">(
    "all",
  );
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupMessage, setBackupMessage] = useState("");
  const [backupResult, setBackupResult] = useState<BackupResult | null>(null);
  const [showBackupConfirm, setShowBackupConfirm] = useState(false);
  const [showBackupSuccess, setShowBackupSuccess] = useState(false);
  const [showBrandForm, setShowBrandForm] = useState(false);
  const [editingBrand, setEditingBrand] = useState<Brand | null>(null);
  const [brandName, setBrandName] = useState("");
  const [brandActive, setBrandActive] = useState(true);
  const [brandError, setBrandError] = useState("");
  const [pendingBrandDeactivation, setPendingBrandDeactivation] =
    useState<Brand | null>(null);
  const [pendingBrandSave, setPendingBrandSave] = useState(false);
  const [defaultLowStock, setDefaultLowStock] = useState(() =>
    Math.max(
      0,
      Math.floor(
        readStoredNumber(LOCAL_SETTINGS_KEYS.defaultLowStockThreshold, 5),
      ),
    ),
  );
  const [wholesaleQtyThreshold, setWholesaleQtyThreshold] = useState(() =>
    Math.max(
      1,
      Math.floor(
        readStoredNumber(LOCAL_SETTINGS_KEYS.wholesaleQtyThreshold, 1),
      ),
    ),
  );
  const [loyaltyDiscountPercent, setLoyaltyDiscountPercent] = useState(() =>
    clampPercent(
      readStoredNumber(LOCAL_SETTINGS_KEYS.loyaltyDiscountPercent, 2),
    ),
  );
  const [savedDefaults, setSavedDefaults] = useState(() =>
    buildBusinessDefaults(
      readStoredNumber(LOCAL_SETTINGS_KEYS.defaultLowStockThreshold, 5),
      readStoredNumber(LOCAL_SETTINGS_KEYS.wholesaleQtyThreshold, 1),
      readStoredNumber(LOCAL_SETTINGS_KEYS.loyaltyDiscountPercent, 2),
    ),
  );
  const [showDefaultsConfirm, setShowDefaultsConfirm] = useState(false);

  async function loadData(showLoader = true) {
    if (showLoader) setLoading(true);
    else setRefreshing(true);
    try {
      const [brandData, productData, userData, auditData, loginData] =
        await Promise.allSettled([
          listBrandsApi(),
          listProductsApi({ pageSize: 300 }),
          listUsersApi(),
          listAuditLogsApi({ pageSize: 20 }),
          listLoginAttemptsApi({ pageSize: 12 }),
        ]);

      if (brandData.status === "fulfilled") {
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
      if (auditData.status === "fulfilled") {
        setAuditLogs(
          Array.isArray(auditData.value?.logs) ? auditData.value.logs : [],
        );
      }
      if (loginData.status === "fulfilled") {
        setLoginAttempts(
          Array.isArray(loginData.value?.attempts)
            ? loginData.value.attempts
            : [],
        );
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    loadData(true);
  }, []);

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
        brandFilter === "all"
          ? true
          : brandFilter === "active"
            ? brand.active
            : !brand.active,
      )
      .filter((brand) =>
        query ? brand.name.toLowerCase().includes(query) : true,
      );
  }, [brandFilter, brandQuery, brands]);

  const editingBrandProducts = useMemo(() => {
    if (!editingBrand) return [];
    return products.filter((product) => product.brandId === editingBrand.id);
  }, [editingBrand, products]);

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
  const cashierUsers = activeUsers.filter((user) => user.role === "CASHIER");
  const failedLoginAttempts = loginAttempts.filter(
    (attempt) => !attempt.success,
  );
  const normalizedDefaults = buildBusinessDefaults(
    defaultLowStock,
    wholesaleQtyThreshold,
    loyaltyDiscountPercent,
  );
  const defaultsDirty =
    normalizedDefaults.defaultLowStock !== savedDefaults.defaultLowStock ||
    normalizedDefaults.wholesaleQtyThreshold !==
      savedDefaults.wholesaleQtyThreshold ||
    normalizedDefaults.loyaltyDiscountPercent !==
      savedDefaults.loyaltyDiscountPercent;

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
    await loadData(false);
  }

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
      if (pendingBrandSave) {
        await saveBrandCore(true);
      } else {
        await updateBrandApi(brand.id, { isActive: false });
        await loadData(false);
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
    if (brand.active) {
      setPendingBrandSave(false);
      setPendingBrandDeactivation(brand);
      return;
    }

    try {
      await updateBrandApi(brand.id, { isActive: true });
      await loadData(false);
    } catch (error: any) {
      setBrandError(
        error?.response?.data?.error ||
          error?.message ||
          "Failed to reactivate the brand.",
      );
    }
  }

  async function handleBackup() {
    try {
      setBackupBusy(true);
      const result = await triggerBackupApi();
      setBackupResult(result);
      setBackupMessage(
        result?.filename || result?.message || "Backup created successfully.",
      );
      setShowBackupConfirm(false);
      setShowBackupSuccess(true);
    } catch (error: any) {
      setBackupMessage(
        error?.response?.data?.error || "Failed to trigger backup.",
      );
    } finally {
      setBackupBusy(false);
    }
  }

  function saveBusinessDefaults() {
    writeStoredNumber(
      LOCAL_SETTINGS_KEYS.defaultLowStockThreshold,
      normalizedDefaults.defaultLowStock,
    );
    writeStoredNumber(
      LOCAL_SETTINGS_KEYS.wholesaleQtyThreshold,
      normalizedDefaults.wholesaleQtyThreshold,
    );
    writeStoredNumber(
      LOCAL_SETTINGS_KEYS.loyaltyDiscountPercent,
      normalizedDefaults.loyaltyDiscountPercent,
    );
    setSavedDefaults(normalizedDefaults);
    setShowDefaultsConfirm(false);
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
          <div className="text-[11px] font-extrabold uppercase tracking-[0.22em] text-slate-400">
            Admin Settings
          </div>
          <div className="mt-1 text-[24px] font-extrabold tracking-tight text-slate-900">
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
          hint={`${adminUsers.length} admins, ${cashierUsers.length} cashiers active`}
          tone="success"
        />
        <Stat
          label="Failed Logins"
          value={failedLoginAttempts.length}
          hint="Recent failed login attempts for admin review"
          tone={failedLoginAttempts.length > 0 ? "danger" : "neutral"}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {(
          [
            { key: "overview", label: "Business Rules" },
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
          <Card>
            <div className="flex flex-col gap-3 border-b border-[var(--app-border)] px-5 py-4 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="text-[18px] font-extrabold text-[var(--app-text)]">
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
              <div className="rounded-[16px] border border-[var(--app-border)] bg-[var(--app-surface-muted)]/70 p-4">
                <div className="text-[13px] font-extrabold text-[var(--app-text)]">
                  Stock alert threshold
                </div>
                <div className="mt-1 text-[12px] text-[var(--app-text-muted)]">
                  Used as the default when opening the add-product form.
                </div>
                <input
                  type="number"
                  min={0}
                  value={defaultLowStock}
                  onChange={(e) =>
                    setDefaultLowStock(Math.max(0, Number(e.target.value || 0)))
                  }
                  className="mt-4 w-full rounded-[14px] border border-[var(--app-border)] bg-white px-3 py-2 text-[14px] text-[var(--app-text)] outline-none focus:border-[#11120d]"
                />
              </div>
              <div className="rounded-[16px] border border-[var(--app-border)] bg-[var(--app-surface-muted)]/70 p-4">
                <div className="text-[13px] font-extrabold text-[var(--app-text)]">
                  Wholesale quantity default
                </div>
                <div className="mt-1 text-[12px] text-[var(--app-text-muted)]">
                  Used as the default threshold when adding a new product.
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
                  className="mt-4 w-full rounded-[14px] border border-[var(--app-border)] bg-white px-3 py-2 text-[14px] text-[var(--app-text)] outline-none focus:border-[#11120d]"
                />
              </div>
              <div className="rounded-[16px] border border-[var(--app-border)] bg-[var(--app-surface-muted)]/70 p-4">
                <div className="text-[13px] font-extrabold text-[var(--app-text)]">
                  Loyalty discount percentage
                </div>
                <div className="mt-1 text-[12px] text-[var(--app-text-muted)]">
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
                  className="mt-4 w-full rounded-[14px] border border-[var(--app-border)] bg-white px-3 py-2 text-[14px] text-[var(--app-text)] outline-none focus:border-[#11120d]"
                />
              </div>
            </div>
          </Card>

          <Card>
            <div className="border-b border-slate-100 px-5 py-5">
              <div className="text-[19px] font-extrabold text-slate-900">
                With Great Power Comes Great Responsibility!
              </div>
              <div className="mt-1 text-[12px] text-slate-500">
                What Admin can control
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

      {tab === "brands" ? (
        <Card>
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
              <input
                value={brandQuery}
                onChange={(e) => setBrandQuery(e.target.value)}
                placeholder="Search brand..."
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
                <tr className="border-b border-slate-100 text-[11px] font-extrabold uppercase tracking-wider text-slate-400">
                  <th className="px-3 py-3">Brand</th>
                  <th className="px-3 py-3">Products</th>
                  <th className="px-3 py-3">Active Products</th>
                  <th className="px-3 py-3">Low Stock</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredBrands.map((brand) => {
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
          </div>
        </Card>
      ) : null}

      {tab === "audit" ? (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <Card>
            <div className="border-b border-slate-100 px-5 py-4">
              <div className="text-[15px] font-extrabold text-slate-900">
                Audit logs
              </div>
              <div className="mt-1 text-[12px] text-slate-500">
                Best shown here with actor, action, entity, invoice reference,
                and when it happened.
              </div>
            </div>
            <div className="space-y-3 p-5">
              {auditLogs.map((log) => (
                <div
                  key={log.id}
                  className="rounded-[16px] border border-slate-200 bg-slate-50/60 p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-[13px] font-extrabold text-slate-900">
                        {log.actor?.name || "System"}
                      </div>
                      <div className="mt-1 text-[12px] text-slate-500">
                        {formatDateTime(log.createdAt)}
                      </div>
                    </div>
                    <Pill tone="info">{log.action}</Pill>
                  </div>
                  <div className="mt-3 text-[13px] text-slate-600">
                    {String(log.meta?.invoiceNo || log.entityType)} /{" "}
                    {log.entityId}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <div className="border-b border-slate-100 px-5 py-4">
              <div className="text-[15px] font-extrabold text-slate-900">
                Login attempts
              </div>
              <div className="mt-1 text-[12px] text-slate-500">
                Recommended data: email, success or failure, IP, and exact
                timestamp.
              </div>
            </div>
            <div className="space-y-3 p-5">
              {loginAttempts.map((attempt) => (
                <div
                  key={attempt.id}
                  className="rounded-[16px] border border-slate-200 bg-slate-50/60 p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-[13px] font-extrabold text-slate-900">
                        {attempt.email}
                      </div>
                      <div className="mt-1 text-[12px] text-slate-500">
                        IP: {attempt.ip || "Unavailable"}
                      </div>
                    </div>
                    <Pill tone={attempt.success ? "success" : "danger"}>
                      {attempt.success ? "Success" : "Failed"}
                    </Pill>
                  </div>
                  <div className="mt-3 text-[12px] font-semibold text-slate-500">
                    {formatDateTime(attempt.createdAt)}
                  </div>
                </div>
              ))}
              <div className="rounded-[16px] border border-slate-200 bg-white p-4">
                <div className="text-[13px] font-extrabold text-slate-900">
                  Staff snapshot
                </div>
                <div className="mt-3 space-y-2">
                  {users.slice(0, 6).map((user) => (
                    <div
                      key={user.id}
                      className="flex items-center justify-between gap-3 rounded-[14px] border border-slate-200 bg-slate-50/60 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-extrabold text-slate-900">
                          {user.name}
                        </div>
                        <div className="truncate text-[12px] text-slate-500">
                          {user.email}
                        </div>
                      </div>
                      <div className="text-right">
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
              </div>
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
              {backupMessage ? (
                <div className="rounded-[14px] border border-slate-200 bg-white px-4 py-3 text-[13px] font-semibold text-slate-700">
                  {backupMessage}
                </div>
              ) : null}
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
              <div className="text-[12px] font-extrabold uppercase tracking-wider text-slate-400">
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
        message="These threshold values will become the saved admin defaults for new products and customer discount setup."
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
