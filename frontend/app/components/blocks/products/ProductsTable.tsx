// frontend/app/components/blocks/products/ProductsTable.tsx
import React from "react";
import GoogleIcon from "~/components/ui/GIcon";
import type { Product } from "~/lib/domain/products/products.types";
import {
  cn,
  formatNpr,
  getStockFlag,
} from "~/lib/domain/products/products.helpers";

type ProductStatus = "Active" | "Inactive";
type StockFlag = "In Stock" | "Low Stock" | "Out of Stock";

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[14px] bg-white border border-slate-200/70 shadow-sm">
      {children}
    </div>
  );
}

function StatusPill({ status }: { status: ProductStatus }) {
  const cls =
    status === "Active"
      ? "bg-emerald-50 text-emerald-700 border-emerald-100"
      : "bg-slate-50 text-slate-600 border-slate-200";
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
      ? "bg-emerald-50 text-emerald-700 border-emerald-100"
      : flag === "Low Stock"
        ? "bg-orange-50 text-orange-700 border-orange-100"
        : "bg-rose-50 text-rose-700 border-rose-100";
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
      className="inline-flex items-center justify-center h-[40px] w-[40px] rounded-[12px] border border-slate-200 bg-white hover:bg-slate-50 active:scale-[0.98]"
    >
      <GoogleIcon name={icon} className="text-slate-700" />
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
  page,
  totalPages,
  pageSize,
  setPageSize,
  prevPage,
  nextPage,
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

  page: number;
  totalPages: number;

  pageSize: number;
  setPageSize: (n: number) => void;

  prevPage: () => void;
  nextPage: () => void;
}) {
  return (
    <Card>
      <div className="p-[10px]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1040px] text-left">
            <thead>
              <tr className="text-[12px] font-semibold text-slate-500 border-b border-slate-100">
                <th className="px-[10px] py-[12px] w-[44px]">
                  <input
                    type="checkbox"
                    checked={
                      rows.length > 0 && rows.every((p) => selected[p.id])
                    }
                    onChange={(e) => toggleAllOnPage(e.target.checked)}
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
                <th className="px-[10px] py-[12px] w-[120px] text-right">
                  Action
                </th>
              </tr>
            </thead>

            <tbody className="divide-y divide-slate-100">
              {rows.map((p) => {
                const flag = getStockFlag(p);
                const isSelected = !!selected[p.id];

                return (
                  <tr
                    key={p.id}
                    className={cn(
                      "text-[14px]",
                      isSelected && "bg-orange-50/40",
                    )}
                  >
                    <td className="px-[10px] py-[14px]">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={(e) => toggleOne(p.id, e.target.checked)}
                        aria-label={`Select ${p.name}`}
                        className="h-[16px] w-[16px]"
                      />
                    </td>

                    <td className="px-[10px] py-[14px]">
                      <div className="flex items-center gap-[12px]">
                        <div className="h-[40px] w-[40px] rounded-[10px] bg-slate-100 border border-slate-200 overflow-hidden flex items-center justify-center">
                          <GoogleIcon name="image" className="text-slate-400" />
                        </div>

                        <div className="min-w-0">
                          <div className="font-semibold text-slate-900 truncate max-w-[340px]">
                            {p.name}
                          </div>
                          <div className="text-[12px] text-slate-500">
                            SKU: {p.sku}
                            {p.barcode ? (
                              <span className="ml-[10px]">
                                Barcode: {p.barcode}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </td>

                    <td className="px-[10px] py-[14px] text-slate-800">
                      {p.brand}
                    </td>
                    <td className="px-[10px] py-[14px] text-slate-800">
                      {p.category}
                    </td>

                    <td className="px-[10px] py-[14px] font-semibold text-slate-900">
                      {formatNpr(p.retailPrice)}
                    </td>
                    <td className="px-[10px] py-[14px] font-semibold text-slate-900">
                      {formatNpr(p.wholesalePrice)}
                    </td>

                    <td className="px-[10px] py-[14px] text-slate-800">
                      {p.thresholdQty}
                    </td>

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
                          title={`Low stock threshold: ${p.lowStockThreshold}`}
                        />
                        <div className="font-semibold text-slate-900">
                          {p.stock.toLocaleString()}
                        </div>
                        <StockPill flag={flag} />
                      </div>
                    </td>

                    <td className="px-[10px] py-[14px]">
                      <StatusPill status={p.status} />
                    </td>

                    <td className="px-[10px] py-[14px]">
                      <div className="flex items-center justify-end gap-[8px]">
                        <IconButton
                          icon="visibility"
                          label="View product"
                          onClick={() => onView(p)}
                        />
                        <IconButton
                          icon="edit"
                          label="Edit product"
                          onClick={() => onEdit(p)}
                        />
                        <IconButton
                          icon="delete"
                          label="Delete product"
                          onClick={() => onDelete(p)}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}

              {rows.length === 0 ? (
                <tr>
                  <td
                    colSpan={10}
                    className="px-[14px] py-[22px] text-[14px] text-slate-600"
                  >
                    No products match your filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-[10px] px-[10px] py-[12px] text-[13px] text-slate-600">
          <div>
            Showing{" "}
            <span className="font-semibold text-slate-900">
              {total === 0 ? 0 : start + 1}
            </span>
            –<span className="font-semibold text-slate-900">{end}</span> of{" "}
            <span className="font-semibold text-slate-900">{total}</span>{" "}
            products
          </div>

          <div className="flex items-center gap-[10px] justify-end">
            <div className="flex items-center gap-[8px]">
              <span className="text-slate-500 font-semibold">Rows:</span>
              <select
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
                className="rounded-[10px] border border-slate-200 bg-white px-[10px] py-[8px] outline-none"
              >
                {[6, 10, 25, 50].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-[6px]">
              <button
                type="button"
                onClick={prevPage}
                className="h-[36px] w-[36px] rounded-[10px] border border-slate-200 bg-white hover:bg-slate-50 inline-flex items-center justify-center"
                aria-label="Previous page"
              >
                <GoogleIcon name="chevron_left" className="text-slate-700" />
              </button>

              <div className="px-[10px] py-[8px] rounded-[10px] border border-slate-200 bg-white text-slate-700 font-semibold">
                {page} / {totalPages}
              </div>

              <button
                type="button"
                onClick={nextPage}
                className="h-[36px] w-[36px] rounded-[10px] border border-slate-200 bg-white hover:bg-slate-50 inline-flex items-center justify-center"
                aria-label="Next page"
              >
                <GoogleIcon name="chevron_right" className="text-slate-700" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
