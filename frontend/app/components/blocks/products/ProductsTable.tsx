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
  onPageChange,
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
  onPageChange: (page: number) => void;
}) {
  return (
    <Card>
      <div className="p-[10px]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1040px] text-left">
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

                    <td className="px-[10px] py-[14px] text-[#565449]">{product.brand}</td>
                    <td className="px-[10px] py-[14px] text-[#565449]">{product.category}</td>
                    <td className="px-[10px] py-[14px] font-semibold text-[#000000]">
                      {formatNpr(product.retailPrice)}
                    </td>
                    <td className="px-[10px] py-[14px] font-semibold text-[#000000]">
                      {formatNpr(product.wholesalePrice)}
                    </td>
                    <td className="px-[10px] py-[14px] text-[#565449]">
                      <div className="font-semibold text-[#000000]">
                        {product.thresholdQty}
                      </div>
                      <div className="mt-[4px] text-[11px] text-[#8C8889]">
                        {product.thresholdQtyMode === "default"
                          ? "Business default"
                          : "Custom"}
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
                  <td colSpan={10} className="px-[14px] py-[22px] text-[14px] text-[#8C8889]">
                    No products match your filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-[12px] px-[10px] py-[12px] text-[13px] text-[#565449] md:flex-row md:items-center md:justify-between">
          <div>
            Showing <span className="font-semibold text-[#000000]">{total === 0 ? 0 : start + 1}</span>
            -<span className="font-semibold text-[#000000]">{end}</span> of{" "}
            <span className="font-semibold text-[#000000]">{total}</span> products
          </div>

          <div className="flex items-center justify-center gap-[8px]">
            <button
              type="button"
              onClick={() => onPageChange(Math.max(1, page - 1))}
              className="inline-flex h-[32px] w-[32px] items-center justify-center rounded-[10px] border border-[#CFCFD3] bg-white text-[#565449] transition hover:bg-[#F3F4F6]"
            >
              <GoogleIcon name="chevron_left" className="text-inherit" />
            </button>

            {Array.from({ length: totalPages })
              .slice(0, 8)
              .map((_, index) => {
                const pageNumber = index + 1;
                const active = pageNumber === page;

                return (
                  <button
                    key={pageNumber}
                    type="button"
                    onClick={() => onPageChange(pageNumber)}
                    className={cn(
                      "inline-flex h-[32px] w-[32px] items-center justify-center rounded-[10px] border text-[12px] font-extrabold transition",
                      active
                        ? "border-[#11120d] bg-[#11120d] text-white"
                        : "border-[#CFCFD3] bg-white text-[#565449] hover:bg-[#F3F4F6]",
                    )}
                  >
                    {pageNumber}
                  </button>
                );
              })}

            <button
              type="button"
              onClick={() => onPageChange(Math.min(totalPages, page + 1))}
              className="inline-flex h-[32px] w-[32px] items-center justify-center rounded-[10px] border border-[#CFCFD3] bg-white text-[#565449] transition hover:bg-[#F3F4F6]"
            >
              <GoogleIcon name="chevron_right" className="text-inherit" />
            </button>
          </div>
        </div>
      </div>
    </Card>
  );
}

