import React, { useMemo, useState, useEffect } from "react";
import Icon from "~/components/ui/Icon";
import {
  listBrandsApi,
  createBrandApi,
  updateBrandApi,
  listProductsApi,
  triggerBackupApi,
} from "~/lib/api/endpoints";

type TabKey = "general" | "brands" | "security" | "backup";

type Brand = {
  id: string;
  name: string;
  active: boolean;
};

type ProductLite = {
  id: string;
  name: string;
  sku: string;
  brand: string;
  stock: number;
  lowStockThreshold: number;
  active: boolean;
};

const LS_KEYS = {
  wholesaleQtyThreshold: "ks_wholesaleQtyThreshold",
  loyaltyDiscountPercent: "ks_loyaltyDiscountPercent",
};

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function clampPercent(v: number) {
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

function readNumber(key: string, fallback: number) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[14px] bg-white border border-slate-200/70 shadow-sm">
      {children}
    </div>
  );
}

function Button({
  children,
  variant = "secondary",
  onClick,
  disabled,
  icon,
}: {
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "danger";
  onClick?: () => void;
  disabled?: boolean;
  icon?: string;
}) {
  const base =
    "inline-flex items-center justify-center gap-[8px] rounded-[12px] px-[14px] py-[10px] text-[13px] font-semibold border active:scale-[0.98] transition";
  const styles =
    variant === "primary"
      ? "bg-orange-600 text-white border-orange-600 hover:bg-orange-700"
      : variant === "danger"
        ? "bg-white text-rose-600 border-rose-200 hover:bg-rose-50"
        : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(base, styles, disabled && "opacity-50 pointer-events-none")}
    >
      {icon ? <Icon name={icon} className="text-inherit" /> : null}
      {children}
    </button>
  );
}

function Input({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-[12px] border border-slate-200 bg-white px-[12px] py-[10px] text-[14px] outline-none placeholder:text-slate-400"
    />
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <input
      type="number"
      value={Number.isFinite(value) ? value : 0}
      min={min}
      max={max}
      onChange={(e) => {
        const next = Number(e.target.value);
        if (!Number.isFinite(next)) return;

        if (typeof min === "number" && next < min) return onChange(min);
        if (typeof max === "number" && next > max) return onChange(max);

        onChange(next);
      }}
      className="w-full rounded-[12px] border border-slate-200 bg-white px-[12px] py-[10px] text-[14px] outline-none"
    />
  );
}

function ModalShell({
  open,
  title,
  children,
  footer,
  onClose,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
        aria-label="Close overlay"
      />
      <div className="absolute inset-0 flex items-center justify-center p-[14px]">
        <div className="w-full max-w-[820px] rounded-[16px] bg-white border border-slate-200 shadow-xl overflow-hidden">
          <div className="flex items-center justify-between px-[18px] py-[14px] border-b border-slate-100">
            <div className="text-[15px] font-semibold text-slate-900">
              {title}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="h-[36px] w-[36px] rounded-[12px] border border-slate-200 hover:bg-slate-50 inline-flex items-center justify-center"
              aria-label="Close modal"
            >
              <Icon name="close" className="text-slate-700" />
            </button>
          </div>

          <div className="px-[18px] py-[16px]">{children}</div>

          {footer ? (
            <div className="px-[18px] py-[14px] border-t border-slate-100 bg-slate-50/40">
              {footer}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-[12px] rounded-[14px] border border-slate-200 p-[12px]">
      <div>
        <div className="text-[14px] font-semibold text-slate-900">{label}</div>
        {hint ? (
          <div className="text-[12px] text-slate-600 mt-[2px]">{hint}</div>
        ) : null}
      </div>

      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={cn(
          "w-[46px] h-[26px] rounded-full border transition flex items-center px-[3px]",
          checked
            ? "bg-orange-600 border-orange-600 justify-end"
            : "bg-slate-100 border-slate-200 justify-start",
        )}
        aria-label={label}
      >
        <div className="h-[20px] w-[20px] rounded-full bg-white shadow-sm" />
      </button>
    </div>
  );
}

export default function SettingsPage() {
  const [tab, setTab] = useState<TabKey>("general");

  const [brands, setBrands] = useState<Brand[]>([]);
  const [products, setProducts] = useState<ProductLite[]>([]);

  useEffect(() => {
    async function load() {
      const [brandData, productData] = await Promise.allSettled([
        listBrandsApi(),
        listProductsApi({ pageSize: 200 }),
      ]);

      if (brandData.status === "fulfilled" && brandData.value) {
        const raw = Array.isArray(brandData.value) ? brandData.value : [];
        setBrands(
          raw.map((b: any) => ({
            id: b.id,
            name: b.name || "Unknown",
            active: b.isActive !== false,
          })),
        );
      }

      if (productData.status === "fulfilled" && productData.value) {
        const raw = productData.value.products || [];
        setProducts(
          raw.map((p: any) => ({
            id: p.id,
            name: p.name || "Unknown",
            sku: p.sku || "",
            brand: p.brand?.name || "",
            stock: p.stock ?? 0,
            lowStockThreshold: p.lowStockThreshold ?? 10,
            active: p.isActive !== false,
          })),
        );
      }
    }
    load();
  }, []);

  // General settings
  const [sandboxPayments, setSandboxPayments] = useState(true);
  const [enableAuditLogs, setEnableAuditLogs] = useState(true);

  // used when creating new products
  const [defaultLowStock, setDefaultLowStock] = useState(10);

  // used during billing to decide when wholesale price applies
  const [wholesaleQtyThreshold, setWholesaleQtyThreshold] = useState(10);

  // loyalty % used during billing only when customer has NO customer wholesale %
  const [loyaltyDiscountPercent, setLoyaltyDiscountPercent] = useState(2);

  // Load persisted values (client-side)
  useEffect(() => {
    const savedThreshold = readNumber(LS_KEYS.wholesaleQtyThreshold, 10);
    const savedLoyalty = readNumber(LS_KEYS.loyaltyDiscountPercent, 2);

    setWholesaleQtyThreshold(Math.max(1, Math.floor(savedThreshold)));
    setLoyaltyDiscountPercent(clampPercent(savedLoyalty));
  }, []);

  // Persist values
  useEffect(() => {
    try {
      localStorage.setItem(
        LS_KEYS.wholesaleQtyThreshold,
        String(Math.max(1, Math.floor(wholesaleQtyThreshold))),
      );
    } catch { }
  }, [wholesaleQtyThreshold]);

  useEffect(() => {
    try {
      localStorage.setItem(
        LS_KEYS.loyaltyDiscountPercent,
        String(clampPercent(loyaltyDiscountPercent)),
      );
    } catch { }
  }, [loyaltyDiscountPercent]);

  // Brand modals
  const [openBrandForm, setOpenBrandForm] = useState(false);
  const [openBrandDetails, setOpenBrandDetails] = useState(false);
  const [activeBrandId, setActiveBrandId] = useState<string | null>(null);

  // Brand form fields
  const [brandName, setBrandName] = useState("");
  const [brandActive, setBrandActive] = useState(true);

  const activeBrand = useMemo(
    () => brands.find((b) => b.id === activeBrandId) || null,
    [brands, activeBrandId],
  );

  const brandStats = useMemo(() => {
    const map: Record<string, { total: number; low: number; active: number }> =
      {};
    brands.forEach((b) => {
      const prods = products.filter((p) => p.brand === b.name);
      const low = prods.filter(
        (p) => p.stock > 0 && p.stock <= p.lowStockThreshold,
      ).length;
      const activeCount = prods.filter((p) => p.active).length;
      map[b.id] = { total: prods.length, low, active: activeCount };
    });
    return map;
  }, [brands, products]);

  function openAddBrand() {
    setActiveBrandId(null);
    setBrandName("");
    setBrandActive(true);
    setOpenBrandForm(true);
  }

  function openEditBrand(b: Brand) {
    setActiveBrandId(b.id);
    setBrandName(b.name);
    setBrandActive(b.active);
    setOpenBrandForm(true);
  }

  async function saveBrand() {
    const name = brandName.trim();
    if (!name) return;

    try {
      if (activeBrandId) {
        await updateBrandApi(activeBrandId, { name, isActive: brandActive });
        setBrands((prev) =>
          prev.map((b) =>
            b.id === activeBrandId ? { ...b, name, active: brandActive } : b,
          ),
        );
      } else {
        const newBrand = await createBrandApi(name);
        if (!brandActive) {
          // New brand created as inactive (backend default is likely active)
          await updateBrandApi(newBrand.id, { isActive: false });
        }
        setBrands((prev) => [
          { id: newBrand.id, name, active: brandActive },
          ...prev,
        ]);
      }
      setOpenBrandForm(false);
    } catch {
      // silently fail inside UI flow if it errors out
    }
  }

  function viewBrandDetails(b: Brand) {
    setActiveBrandId(b.id);
    setOpenBrandDetails(true);
  }

  const brandProducts = useMemo(() => {
    if (!activeBrand) return [];
    return products.filter((p) => p.brand === activeBrand.name);
  }, [products, activeBrand]);

  return (
    <div className="space-y-[14px]">
      <Card>
        <div className="p-[12px] flex items-center gap-[8px] flex-wrap">
          {(
            [
              { key: "general", label: "General" },
              { key: "brands", label: "Brands" },
              { key: "security", label: "Security" },
              { key: "backup", label: "Backup" },
            ] as Array<{ key: TabKey; label: string }>
          ).map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                "px-[12px] py-[8px] rounded-[12px] border text-[13px] font-semibold transition",
                tab === t.key
                  ? "bg-orange-600 text-white border-orange-600"
                  : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </Card>

      {tab === "general" ? (
        <Card>
          <div className="p-[16px] space-y-[12px]">
            <Toggle
              checked={sandboxPayments}
              onChange={setSandboxPayments}
              label="Sandbox payment records"
              hint="Keeps eSewa/Khalti as recorded entries only (no real gateway callback)."
            />

            <Toggle
              checked={enableAuditLogs}
              onChange={setEnableAuditLogs}
              label="Enable audit logs"
              hint="Tracks key actions like login attempts, product updates, invoice status changes."
            />

            <div className="rounded-[14px] border border-slate-200 p-[12px]">
              <div className="text-[14px] font-semibold text-slate-900">
                Default low stock threshold
              </div>
              <div className="text-[12px] text-slate-600 mt-[2px]">
                Used as default value when adding new products. Per-product
                threshold can override it.
              </div>

              <div className="mt-[10px] max-w-[240px]">
                <NumberInput
                  value={defaultLowStock}
                  onChange={setDefaultLowStock}
                  min={0}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-[12px]">
              <div className="rounded-[14px] border border-slate-200 p-[12px]">
                <div className="text-[14px] font-semibold text-slate-900">
                  Wholesale quantity threshold
                </div>
                <div className="text-[12px] text-slate-600 mt-[2px]">
                  If item quantity reaches this number, billing can use the
                  product wholesale price instead of retail price.
                </div>

                <div className="mt-[10px] max-w-[240px]">
                  <NumberInput
                    value={wholesaleQtyThreshold}
                    onChange={(v) =>
                      setWholesaleQtyThreshold(Math.max(1, Math.floor(v)))
                    }
                    min={1}
                  />
                </div>

                <div className="mt-[8px] text-[12px] text-slate-500">
                  Saved automatically (used by billing + discounts pages).
                </div>
              </div>

              <div className="rounded-[14px] border border-slate-200 p-[12px]">
                <div className="text-[14px] font-semibold text-slate-900">
                  Loyalty discount percentage
                </div>
                <div className="text-[12px] text-slate-600 mt-[2px]">
                  Applied on subtotal only when customer is marked loyalty
                  eligible AND the customer has no customer wholesale % set.
                </div>

                <div className="mt-[10px] max-w-[240px]">
                  <NumberInput
                    value={loyaltyDiscountPercent}
                    onChange={(v) => setLoyaltyDiscountPercent(clampPercent(v))}
                    min={0}
                    max={100}
                  />
                </div>

                <div className="mt-[8px] text-[12px] text-slate-500">
                  Saved automatically (used by billing + discounts pages).
                </div>
              </div>
            </div>
          </div>
        </Card>
      ) : null}

      {/* rest of your file below is unchanged (brands/security/backup + modals) */}
      {tab === "brands" ? (
        <Card>
          <div className="p-[16px] space-y-[12px]">
            <div className="flex items-center justify-between gap-[10px] flex-wrap">
              <div>
                <div className="text-[15px] font-semibold text-slate-900">
                  Brands
                </div>
                <div className="text-[12px] text-slate-600 mt-[2px]">
                  Manage brands here. View how many products each brand has and
                  low stock count.
                </div>
              </div>

              <Button variant="primary" icon="add" onClick={openAddBrand}>
                Add Brand
              </Button>
            </div>

            <div className="overflow-x-auto rounded-[14px] border border-slate-200">
              <table className="w-full min-w-[780px] text-left">
                <thead>
                  <tr className="text-[12px] font-semibold text-slate-500 border-b border-slate-100 bg-slate-50/60">
                    <th className="px-[12px] py-[12px]">Brand</th>
                    <th className="px-[12px] py-[12px]">Products</th>
                    <th className="px-[12px] py-[12px]">Active Products</th>
                    <th className="px-[12px] py-[12px]">Low Stock</th>
                    <th className="px-[12px] py-[12px]">Status</th>
                    <th className="px-[12px] py-[12px] text-right">Action</th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-slate-100">
                  {brands.map((b) => {
                    const st = brandStats[b.id] || {
                      total: 0,
                      low: 0,
                      active: 0,
                    };
                    return (
                      <tr
                        key={b.id}
                        className="text-[14px] hover:bg-slate-50/60"
                      >
                        <td className="px-[12px] py-[14px] font-semibold text-slate-900">
                          {b.name}
                        </td>
                        <td className="px-[12px] py-[14px] text-slate-700">
                          {st.total}
                        </td>
                        <td className="px-[12px] py-[14px] text-slate-700">
                          {st.active}
                        </td>
                        <td className="px-[12px] py-[14px] text-slate-700">
                          {st.low}
                        </td>
                        <td className="px-[12px] py-[14px]">
                          <span
                            className={cn(
                              "inline-flex items-center rounded-full px-[10px] py-[4px] text-[12px] font-semibold border",
                              b.active
                                ? "bg-emerald-50 text-emerald-700 border-emerald-100"
                                : "bg-slate-50 text-slate-600 border-slate-200",
                            )}
                          >
                            {b.active ? "Active" : "Inactive"}
                          </span>
                        </td>
                        <td className="px-[12px] py-[14px]">
                          <div className="flex items-center justify-end gap-[8px]">
                            <button
                              type="button"
                              onClick={() => viewBrandDetails(b)}
                              className="h-[36px] w-[36px] rounded-[10px] border border-slate-200 bg-white hover:bg-slate-50 inline-flex items-center justify-center"
                              aria-label="View brand"
                            >
                              <Icon
                                name="visibility"
                                className="text-slate-700"
                              />
                            </button>

                            <button
                              type="button"
                              onClick={() => openEditBrand(b)}
                              className="h-[36px] w-[36px] rounded-[10px] border border-slate-200 bg-white hover:bg-slate-50 inline-flex items-center justify-center"
                              aria-label="Edit brand"
                            >
                              <Icon
                                name="edit"
                                className="text-slate-700"
                              />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}

                  {brands.length === 0 ? (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-[12px] py-[22px] text-[14px] text-slate-600"
                      >
                        No brands created yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </Card>
      ) : null}

      {tab === "security" ? (
        <Card>
          <div className="p-[16px] space-y-[12px]">
            <div className="rounded-[14px] border border-slate-200 p-[12px]">
              <div className="text-[14px] font-semibold text-slate-900">
                Login attempt logging
              </div>
              <div className="text-[12px] text-slate-600 mt-[2px]">
                Keep log entries for successful/failed logins (user, time, IP
                later).
              </div>
            </div>

            <div className="rounded-[14px] border border-slate-200 p-[12px]">
              <div className="text-[14px] font-semibold text-slate-900">
                RBAC roles
              </div>
              <div className="text-[12px] text-slate-600 mt-[2px]">
                Admin vs Cashier permissions. Cashier should not access products
                settings.
              </div>
            </div>
          </div>
        </Card>
      ) : null}

      {tab === "backup" ? (
        <Card>
          <div className="p-[16px] space-y-[12px]">
            <div className="rounded-[14px] border border-slate-200 p-[12px]">
              <div className="text-[14px] font-semibold text-slate-900">
                Backup reminder
              </div>
              <div className="text-[12px] text-slate-600 mt-[2px]">
                Simple reminders.
              </div>
              <div className="mt-[10px] flex items-center gap-[10px] flex-wrap">
                <Button icon="schedule" onClick={() => { }}>
                  Set reminder
                </Button>
                <Button icon="history" onClick={() => { }}>
                  View history
                </Button>
              </div>
            </div>

            <div className="rounded-[14px] border border-slate-200 p-[12px]">
              <div className="text-[14px] font-semibold text-slate-900">
                Export database
              </div>
              <div className="text-[12px] text-slate-600 mt-[2px]">
                Downloadable database backup.
              </div>
            </div>
          </div>
        </Card>
      ) : null}

      <ModalShell
        open={openBrandForm}
        title={activeBrandId ? "Edit Brand" : "Add Brand"}
        onClose={() => setOpenBrandForm(false)}
        footer={
          <div className="flex items-center justify-end gap-[10px]">
            <Button onClick={() => setOpenBrandForm(false)}>Cancel</Button>
            <Button variant="primary" icon="save" onClick={saveBrand}>
              Save
            </Button>
          </div>
        }
      >
        <div className="space-y-[12px]">
          <div className="space-y-[6px]">
            <div className="text-[12px] font-semibold text-slate-600">
              Brand Name
            </div>
            <Input
              value={brandName}
              onChange={setBrandName}
              placeholder="e.g. CG Foods"
            />
          </div>

          <label className="inline-flex items-center gap-[8px] text-[13px] font-semibold text-slate-700 select-none">
            <input
              type="checkbox"
              checked={brandActive}
              onChange={(e) => setBrandActive(e.target.checked)}
              className="h-[16px] w-[16px]"
            />
            Active
          </label>

          <div className="text-[12px] text-slate-500">
            Inactive brands can remain for history/audit but won’t be selectable
            in product creation later.
          </div>
        </div>
      </ModalShell>

      <ModalShell
        open={openBrandDetails}
        title="Brand Details"
        onClose={() => setOpenBrandDetails(false)}
        footer={
          <div className="flex items-center justify-end gap-[10px]">
            <Button onClick={() => setOpenBrandDetails(false)}>Close</Button>
            {activeBrand ? (
              <Button
                variant="primary"
                icon="edit"
                onClick={() => (
                  setOpenBrandDetails(false),
                  openEditBrand(activeBrand)
                )}
              >
                Edit Brand
              </Button>
            ) : null}
          </div>
        }
      >
        {activeBrand ? (
          <div className="space-y-[12px]">
            <div className="rounded-[14px] border border-slate-200 p-[12px]">
              <div className="text-[14px] font-semibold text-slate-900">
                {activeBrand.name}
              </div>
              <div className="text-[12px] text-slate-600 mt-[2px]">
                Status: {activeBrand.active ? "Active" : "Inactive"}
              </div>
            </div>

            <div className="rounded-[14px] border border-slate-200 overflow-hidden">
              <div className="px-[12px] py-[10px] bg-slate-50 text-[13px] font-semibold text-slate-700">
                Products under this brand
              </div>

              <div className="p-[12px] overflow-x-auto">
                <table className="w-full min-w-[620px] text-left">
                  <thead>
                    <tr className="text-[12px] font-semibold text-slate-500 border-b border-slate-100">
                      <th className="py-[10px]">Product</th>
                      <th className="py-[10px]">SKU</th>
                      <th className="py-[10px]">Stock</th>
                      <th className="py-[10px]">Low Threshold</th>
                      <th className="py-[10px]">Status</th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-slate-100">
                    {brandProducts.map((p) => {
                      const low = p.stock > 0 && p.stock <= p.lowStockThreshold;
                      const out = p.stock <= 0;

                      return (
                        <tr key={p.id} className="text-[13px]">
                          <td className="py-[10px] font-semibold text-slate-900">
                            {p.name}
                          </td>
                          <td className="py-[10px] text-slate-700">{p.sku}</td>
                          <td className="py-[10px] text-slate-900 font-semibold">
                            <span className="inline-flex items-center gap-[8px]">
                              <span
                                className={cn(
                                  "h-[8px] w-[8px] rounded-full",
                                  out
                                    ? "bg-rose-500"
                                    : low
                                      ? "bg-orange-500"
                                      : "bg-emerald-500",
                                )}
                              />
                              {p.stock}
                            </span>
                          </td>
                          <td className="py-[10px] text-slate-700">
                            {p.lowStockThreshold}
                          </td>
                          <td className="py-[10px]">
                            <span
                              className={cn(
                                "inline-flex items-center rounded-full px-[10px] py-[4px] text-[12px] font-semibold border",
                                p.active
                                  ? "bg-emerald-50 text-emerald-700 border-emerald-100"
                                  : "bg-slate-50 text-slate-600 border-slate-200",
                              )}
                            >
                              {p.active ? "Active" : "Inactive"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}

                    {brandProducts.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-[14px] text-slate-600">
                          No products under this brand yet.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="text-[12px] text-slate-500">
              Later: brand sales summary + top products once reports are
              connected.
            </div>
          </div>
        ) : (
          <div className="text-[14px] text-slate-600">No brand selected.</div>
        )}
      </ModalShell>
    </div>
  );
}
