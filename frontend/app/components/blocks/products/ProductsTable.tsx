import React from "react";
import GoogleIcon from "~/components/ui/GIcon";
import type { Product } from "~/lib/domain/products/products.types";
import {
  cn,
  formatNpr,
  getStockFlag,
} from "~/lib/domain/products/products.helpers";

const API_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";

type ProductStatus = "Active" | "Inactive";
type StockFlag = "In Stock" | "Low Stock" | "Out of Stock";

function resolveImageUrl(imageUrl?: string) {
  if (!imageUrl) return "";
  if (imageUrl.startsWith("http")) return imageUrl;
  return `${API_URL}${imageUrl}`;
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[14px] border border-[var(--app-border)] bg-white shadow-[0_18px_45px_-38px_rgba(17,18,13,0.45)]">
      {children}
    </div>
  );
}

function StatusPill({ status }: { status: ProductStatus }) {
  const cls =
    status === "Active"
      ? "bg-[var(--app-success-bg)] text-[var(--app-success-text)] border-[var(--app-success-border)]"
      : "bg-[var(--app-surface-muted)] text-[var(--app-text-soft)] border-[var(--app-border)]";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-[10px] py-[4px] text-[12px] font-semibold border",
        cls,
      )}
    >
      {status}
    </span>
  );
}

function StockPill({ flag }: { flag: StockFlag }) {
  const cls =
    flag === "In Stock"
      ? "bg-[var(--app-success-bg)] text-[var(--app-success-text)] border-[var(--app-success-border)]"
      : flag === "Low Stock"
        ? "bg-[var(--app-warning-bg)] text-[var(--app-warning-text)] border-[var(--app-warning-border)]"
        : "bg-[var(--app-danger-bg)] text-[var(--app-danger-text)] border-[var(--app-danger-border)]";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-[10px] py-[4px] text-[12px] font-semibold border",
        cls,
      )}
    >
      {flag}
    </span>
  );
}

function IconButton({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="inline-flex h-[40px] w-[40px] items-center justify-center rounded-[12px] border border-[var(--app-border)] bg-white hover:bg-[var(--app-surface-muted)] active:scale-[0.98]"
    >
      <GoogleIcon name={icon} className="text-[var(--app-text-soft)]" />
    </button>
  );
}

export default function ProductsTableCard({
  rows,
  selected,
  toggleAllOnPage,
  toggleOne,
  onView,
  onEdit,
  onDelete,
  total,
  start,
  end,
}: {
  rows: Product[];
  selected: Record<string, boolean>;
  toggleAllOnPage: (checked: boolean) => void;
  toggleOne: (id: string, checked: boolean) => void;
  onView: (p: Product) => void;
  onEdit: (p: Product) => void;
  onDelete: (p: Product) => void;
  total: number;
  start: number;
  end: number;
}) {
  return (
    <Card>
      <div className="p-[10px]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1040px] text-left">
            <thead>
              <tr className="border-b border-[var(--app-border)] text-[12px] font-semibold text-[var(--app-text-muted)]">
                <th className="w-[44px] px-[10px] py-[12px]">
                  <input
                    type="checkbox"
                    checked={rows.length > 0 && rows.every((product) => selected[product.id])}
                    onChange={(event) => toggleAllOnPage(event.target.checked)}
                    aria-label="Select all rows on this page"
                    className="h-[16px] w-[16px]"
                  />
                </th>
                <th className="px-[10px] py-[12px]">Product</th>
                <th className="px-[10px] py-[12px]">Brand</th>
                <th className="px-[10px] py-[12px]">Category</th>
                <th className="px-[10px] py-[12px]">Retail (NPR)</th>
                <th className="px-[10px] py-[12px]">Wholesale (NPR)</th>
                <th className="px-[10px] py-[12px]">Threshold</th>
                <th className="px-[10px] py-[12px]">Stock</th>
                <th className="px-[10px] py-[12px]">Status</th>
                <th className="w-[120px] px-[10px] py-[12px] text-right">Action</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-[var(--app-border)]">
              {rows.map((product) => {
                const flag = getStockFlag(product);
                const isSelected = !!selected[product.id];

                return (
                  <tr
                    key={product.id}
                    className={cn(
                      "text-[14px]",
                      isSelected && "bg-[var(--app-surface-muted)]/80",
                    )}
                  >
                    <td className="px-[10px] py-[14px]">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={(event) => toggleOne(product.id, event.target.checked)}
                        aria-label={`Select ${product.name}`}
                        className="h-[16px] w-[16px]"
                      />
                    </td>

                    <td className="px-[10px] py-[14px]">
                      <div className="flex items-center gap-[12px]">
                        <div className="flex h-[48px] w-[48px] items-center justify-center overflow-hidden rounded-[12px] border border-[var(--app-border)] bg-[var(--app-surface-muted)]">
                          {product.imageUrl ? (
                            <img
                              src={resolveImageUrl(product.imageUrl)}
                              alt={product.name}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <GoogleIcon
                              name="inventory_2"
                              className="text-[var(--app-text-muted)]"
                            />
                          )}
                        </div>

                        <div className="min-w-0">
                          <div className="max-w-[340px] truncate font-semibold text-[var(--app-text)]">
                            {product.name}
                          </div>
                          <div className="text-[12px] text-[var(--app-text-muted)]">
                            SKU: {product.sku}
                            {product.barcode ? (
                              <span className="ml-[10px]">Barcode: {product.barcode}</span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </td>

                    <td className="px-[10px] py-[14px] text-[var(--app-text-soft)]">{product.brand}</td>
                    <td className="px-[10px] py-[14px] text-[var(--app-text-soft)]">{product.category}</td>
                    <td className="px-[10px] py-[14px] font-semibold text-[var(--app-text)]">
                      {formatNpr(product.retailPrice)}
                    </td>
                    <td className="px-[10px] py-[14px] font-semibold text-[var(--app-text)]">
                      {formatNpr(product.wholesalePrice)}
                    </td>
                    <td className="px-[10px] py-[14px] text-[var(--app-text-soft)]">{product.thresholdQty}</td>

                    <td className="px-[10px] py-[14px]">
                      <div className="flex items-center gap-[10px]">
                        <span
                          className={cn(
                            "h-[8px] w-[8px] rounded-full",
                            flag === "In Stock"
                              ? "bg-emerald-500"
                              : flag === "Low Stock"
                                ? "bg-orange-500"
                                : "bg-rose-500",
                          )}
                          title={`Low stock threshold: ${product.lowStockThreshold}`}
                        />
                        <div className="font-semibold text-[var(--app-text)]">
                          {product.stock.toLocaleString()}
                        </div>
                        <StockPill flag={flag} />
                      </div>
                    </td>

                    <td className="px-[10px] py-[14px]">
                      <StatusPill status={product.status} />
                    </td>

                    <td className="px-[10px] py-[14px]">
                      <div className="flex items-center justify-end gap-[8px]">
                        <IconButton
                          icon="visibility"
                          label="View product"
                          onClick={() => onView(product)}
                        />
                        <IconButton
                          icon="edit"
                          label="Edit product"
                          onClick={() => onEdit(product)}
                        />
                        <IconButton
                          icon="delete"
                          label="Delete product"
                          onClick={() => onDelete(product)}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}

              {rows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-[14px] py-[22px] text-[14px] text-[var(--app-text-muted)]">
                    No products match your filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-[10px] px-[10px] py-[12px] text-[13px] text-[var(--app-text-soft)] md:flex-row md:items-center md:justify-between">
          <div>
            Showing <span className="font-semibold text-[var(--app-text)]">{total === 0 ? 0 : start + 1}</span>
            -<span className="font-semibold text-[var(--app-text)]">{end}</span> of{" "}
            <span className="font-semibold text-[var(--app-text)]">{total}</span> products
          </div>
        </div>
      </div>
    </Card>
  );
}
