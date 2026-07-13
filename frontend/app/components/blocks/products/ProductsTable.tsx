import React from "react";
import GoogleIcon from "~/components/ui/GIcon";
import ProductImage from "~/components/ui/ProductImage";
import type { Product } from "~/lib/domain/products/products.types";
import {
  cn,
  formatNpr,
  getStockFlag,
} from "~/lib/domain/products/products.helpers";

type ProductStatus = "Active" | "Inactive";
type StockFlag = "In Stock" | "Low Stock" | "Out of Stock";

// simple card wrapper for the table section
function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[14px] border border-[#CFCFD3] bg-white ">
      {children}
    </div>
  );
}

function StatusPill({ status }: { status: ProductStatus }) {
  const cls =
    status === "Active"
      ? "bg-[#EAF8EF] text-[#179B4D] border-[#9DD8B2]"
      : "bg-[#F3F4F6] text-[#565449] border-[#CFCFD3]";
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
      ? "bg-[#EAF8EF] text-[#179B4D] border-[#9DD8B2]"
      : flag === "Low Stock"
        ? "bg-[#FFF7E8] text-[#B7791F] border-[#F6D28B]"
        : "bg-[#FFF1F2] text-[#BE123C] border-[#FECDD3]";
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
      className="inline-flex h-[40px] w-[40px] items-center justify-center rounded-[12px] border border-[#CFCFD3] bg-white hover:bg-[#F3F4F6] active:scale-[0.98]"
    >
      <GoogleIcon name={icon} className="text-[#565449]" />
    </button>
  );
}

function formatQty(value: number) {
  if (!Number.isFinite(value)) return "0";
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function formatSize(product: Product) {
  if (!product.sizeValue || product.sizeUnit === "STANDARD") return "Standard";
  return `${formatQty(product.sizeValue)} ${product.sizeUnit}`;
}

function formatPackage(product: Product) {
  return `${formatQty(product.packageQuantity || 1)} ${product.packageUnit || "PIECE"}`;
}

function buildPaginationItems(page: number, totalPages: number) {
  const items: Array<number | "ellipsis-start" | "ellipsis-end"> = [];
  const safeTotalPages = Math.max(1, totalPages);
  const safePage = Math.min(safeTotalPages, Math.max(1, page));
  const windowStart = Math.max(2, safePage - 2);
  const windowEnd = Math.min(safeTotalPages - 1, safePage + 2);

  items.push(1);

  if (windowStart > 2) {
    items.push("ellipsis-start");
  }

  for (let pageNumber = windowStart; pageNumber <= windowEnd; pageNumber += 1) {
    items.push(pageNumber);
  }

  if (windowEnd < safeTotalPages - 1) {
    items.push("ellipsis-end");
  }

  if (safeTotalPages > 1) {
    items.push(safeTotalPages);
  }

  return items;
}

// data table for displaying products
// supports row selection via checkboxes, sorting (conceptually), and pagination controls at the bottom
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
  onPageChange,
  onPageSizeChange,
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
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const paginationItems = buildPaginationItems(page, totalPages);

  return (
    <Card>
      <div className="p-[10px]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1280px] text-left">
            <thead>
              <tr className="border-b border-[#CFCFD3] text-[12px] font-semibold text-[#8C8889]">
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
                <th className="px-[10px] py-[12px]">Source</th>
                <th className="px-[10px] py-[12px]">Group / Variant</th>
                <th className="px-[10px] py-[12px]">Size</th>
                <th className="px-[10px] py-[12px]">Package</th>
                <th className="px-[10px] py-[12px]">Rate / Piece</th>
                <th className="px-[10px] py-[12px]">Qty Wholesale</th>
                <th className="px-[10px] py-[12px]">Stock</th>
                <th className="px-[10px] py-[12px]">Status</th>
                <th className="w-[120px] px-[10px] py-[12px] text-right">Action</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-[#CFCFD3]">
              {rows.map((product) => {
                const flag = getStockFlag(product);
                const isSelected = !!selected[product.id];

                return (
                  <tr
                    key={product.id}
                    className={cn(
                      "text-[14px]",
                      isSelected && "bg-[#F3F4F6]/80",
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
                        <ProductImage
                          src={product.imageUrl}
                          alt={product.name}
                          className="flex h-[48px] w-[48px] items-center justify-center overflow-hidden rounded-[12px] border border-[#CFCFD3] bg-[#F3F4F6]"
                          iconClassName="text-[#8C8889]"
                        />

                        <div className="min-w-0">
                          <div className="max-w-[340px] truncate font-semibold text-[#000000]">
                            {product.name}
                          </div>
                          <div className="text-[12px] text-[#8C8889]">
                            SKU: {product.sku}
                            {product.barcode ? (
                              <span className="ml-[10px]">Barcode: {product.barcode}</span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </td>

                    <td className="px-[10px] py-[14px] text-[#565449]">
                      <div className="font-semibold text-[#000000]">
                        {product.vendorSource || product.brand}
                      </div>
                      <div className="mt-[4px] text-[11px] text-[#8C8889]">
                        {product.category || "Uncategorized"}
                      </div>
                    </td>
                    <td className="px-[10px] py-[14px] text-[#565449]">
                      <div className="max-w-[220px] truncate font-semibold text-[#000000]">
                        {product.categoryGroup || product.category || "-"}
                      </div>
                      <div className="mt-[4px] max-w-[220px] truncate text-[11px] text-[#8C8889]">
                        {product.productCodeVariant || "No variant"}
                      </div>
                    </td>
                    <td className="px-[10px] py-[14px] text-[#565449]">
                      <div className="font-semibold text-[#000000]">
                        {formatSize(product)}
                      </div>
                      <div className="mt-[4px] text-[11px] text-[#8C8889]">
                        Sale unit: {product.saleUnit || "PIECE"}
                      </div>
                    </td>
                    <td className="px-[10px] py-[14px] text-[#565449]">
                      <div className="font-semibold text-[#000000]">
                        {formatPackage(product)}
                      </div>
                      <div className="mt-[4px] text-[11px] text-[#8C8889]">
                        Step {formatQty(product.quantityStep || 1)}
                      </div>
                    </td>
                    <td className="px-[10px] py-[14px] font-semibold text-[#000000]">
                      {formatNpr(product.ratePerPiece || product.retailPrice)}
                    </td>
                    <td className="px-[10px] py-[14px] text-[#565449]">
                      <div className="font-semibold text-[#000000]">
                        {product.wholesaleEligible ? formatNpr(product.wholesalePrice) : "Qty pricing off"}
                      </div>
                      <div className="mt-[4px] text-[11px] text-[#8C8889]">
                        Qty threshold {formatQty(product.thresholdQty)}
                      </div>
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
                          title={`Low stock threshold: ${product.lowStockThreshold}`}
                        />
                        <div className="font-semibold text-[#000000]">
                          {formatQty(product.stock)} {product.saleUnit || "PIECE"}
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
                          label="Delete options"
                          onClick={() => onDelete(product)}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}

              {rows.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-[14px] py-[22px] text-[14px] text-[#8C8889]">
                    No products match your filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-[12px] px-[10px] py-[12px] text-[13px] text-[#565449] lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-x-[12px] gap-y-[8px]">
            <div>
              Showing <span className="font-semibold text-[#000000]">{total === 0 ? 0 : start + 1}</span>
              -<span className="font-semibold text-[#000000]">{end}</span> of{" "}
              <span className="font-semibold text-[#000000]">{total}</span> products
            </div>

            <label className="flex items-center gap-[8px] text-[12px] font-semibold text-[#8C8889]">
              Rows
              <select
                value={pageSize}
                onChange={(event) => onPageSizeChange(Number(event.target.value))}
                className="h-[34px] rounded-[10px] border border-[#CFCFD3] bg-white px-[10px] text-[12px] font-bold text-[#565449] outline-none"
              >
                {[20, 50, 100].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-[8px] lg:justify-end">
            <button
              type="button"
              onClick={() => onPageChange(Math.max(1, page - 1))}
              disabled={page <= 1}
              className="inline-flex h-[32px] w-[32px] items-center justify-center rounded-[10px] border border-[#CFCFD3] bg-white text-[#565449] transition hover:bg-[#F3F4F6]"
              aria-label="Previous page"
            >
              <GoogleIcon name="chevron_left" className="text-inherit" />
            </button>

            {paginationItems.map((item) => {
              if (typeof item !== "number") {
                return (
                  <span
                    key={item}
                    className="inline-flex h-[32px] min-w-[24px] items-center justify-center text-[12px] font-extrabold text-[#8C8889]"
                  >
                    ...
                  </span>
                );
              }

              const active = item === page;

              return (
                <button
                  key={item}
                  type="button"
                  onClick={() => onPageChange(item)}
                  className={cn(
                    "inline-flex h-[32px] min-w-[32px] items-center justify-center rounded-[10px] border px-[8px] text-[12px] font-extrabold transition",
                    active
                      ? "border-[#11120d] bg-[#11120d] text-white"
                      : "border-[#CFCFD3] bg-white text-[#565449] hover:bg-[#F3F4F6]",
                  )}
                >
                  {item}
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => onPageChange(Math.min(totalPages, page + 1))}
              disabled={page >= totalPages}
              className="inline-flex h-[32px] w-[32px] items-center justify-center rounded-[10px] border border-[#CFCFD3] bg-white text-[#565449] transition hover:bg-[#F3F4F6]"
              aria-label="Next page"
            >
              <GoogleIcon name="chevron_right" className="text-inherit" />
            </button>

            <label className="ml-[4px] flex items-center gap-[8px] text-[12px] font-semibold text-[#8C8889]">
              Go
              <input
                type="number"
                min={1}
                max={totalPages}
                value={page}
                onChange={(event) => {
                  const nextPage = Number(event.target.value);
                  if (Number.isFinite(nextPage)) {
                    onPageChange(Math.min(totalPages, Math.max(1, nextPage)));
                  }
                }}
                className="h-[34px] w-[74px] rounded-[10px] border border-[#CFCFD3] bg-white px-[10px] text-center text-[12px] font-bold text-[#565449] outline-none"
                aria-label="Go to page"
              />
              <span>of {totalPages}</span>
            </label>
          </div>
        </div>
      </div>
    </Card>
  );
}

