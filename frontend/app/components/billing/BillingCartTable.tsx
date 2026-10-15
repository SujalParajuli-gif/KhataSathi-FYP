import { formatBillingMoney } from "~/lib/billingWorkspace";
import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import Icon from "~/components/ui/Icon";
import GoogleIcon from "~/components/ui/GIcon";
import PreviewableImage from "~/components/ui/PreviewableImage";
import { latestComparablePurchase } from "~/lib/billingWorkspace";

import type { CustomerProductPurchaseHistoryItem } from "~/lib/api/endpoints";

export interface CartTableItem {
  id: string; // product id or line id
  productId: string;
  name: string;
  sku?: string | null;
  brand?: string | null;
  saleUnit?: string | null;
  imageUrl?: string | null;
  qty: number;
  stock: number;
  appliedUnitPrice: number;
  originalUnitPrice: number;
  priceType?: string;
  overrideUnitPrice?: number;
  overrideReason?: string;
  lineTotal: number;
  unresolvedReason?: "UNAVAILABLE" | "INACTIVE" | "INSUFFICIENT_STOCK" | "INVALID_STEP" | "UNPRICED" | null;
  quantityStep?: number | null;
}

interface BillingCartTableProps {
  note: string;
  onChangeNote: (value: string) => void;
  onSelectRow: (index: number) => void;
  selectedRowIndex: number;
  cart: CartTableItem[];
  onUpdateQty: (productId: string, newQty: number) => void;
  onRemoveItem: (productId: string) => void;
  onClearCart: () => void;
  canClearDraft?: boolean;
  onOpenPriceOverride: (item: CartTableItem) => void;
  onParkBill: () => void;
  parkedCount?: number;
  onOpenParkedModal?: () => void;
  customerHistoryItems?: CustomerProductPurchaseHistoryItem[];
  selectedCustomerId?: string | null;
  onOpenDifferPopover?: (item: CartTableItem, pastPurchases: CustomerProductPurchaseHistoryItem[], anchor: HTMLElement) => void;
}

export default function BillingCartTable({
  note: cartNote,
  onChangeNote: setCartNote,
  onSelectRow,
  selectedRowIndex,
  cart,
  onUpdateQty,
  onRemoveItem,
  onClearCart,
  canClearDraft = cart.length > 0,
  onOpenPriceOverride,
  onParkBill,
  parkedCount = 0,
  onOpenParkedModal,
  customerHistoryItems = [],
  onOpenDifferPopover,
}: BillingCartTableProps) {
  const [activeMenuProductId, setActiveMenuProductId] = useState<string | null>(null);
  const [menuPosition,setMenuPosition] = useState({top:0,left:0});
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!activeMenuProductId) return;
    const frame=requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus());
    const close=()=>setActiveMenuProductId(null);
    const outside=(event:PointerEvent)=>{if(!menuRef.current?.contains(event.target as Node)&&!menuTrigger.current?.contains(event.target as Node))close();};
    const key=(event:KeyboardEvent)=>{if(event.key==="Escape"){event.stopPropagation();close();menuTrigger.current?.focus();}};
    document.addEventListener("pointerdown",outside); document.addEventListener("keydown",key);window.addEventListener("resize",close);window.addEventListener("scroll",close,true);
    return()=>{cancelAnimationFrame(frame);document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",key);window.removeEventListener("resize",close);window.removeEventListener("scroll",close,true);};
  },[activeMenuProductId]);
  const [isNoteOpen, setIsNoteOpen] = useState(false);

  const rows = useRef<Array<HTMLTableRowElement | null>>([]);
  useEffect(() => {
    const frame=requestAnimationFrame(() => rows.current[selectedRowIndex]?.scrollIntoView({block:"nearest"}));
    return () => cancelAnimationFrame(frame);
  }, [selectedRowIndex]);
  const needsAttention = cart.some(item => Boolean(item.unresolvedReason));
  const totalLines = cart.length;
  const totalUnits = cart.reduce((sum, item) => sum + item.qty, 0);
  const saleUnits = [...new Set(cart.map(item => item.saleUnit || "unknown"))];
  const quantitySummary = saleUnits.length === 1 && saleUnits[0] !== "unknown" ? `${totalUnits} ${saleUnits[0].toLowerCase()}` : "mixed / unspecified units";

  // Map product IDs to history items to detect price differences
  const historyByProduct = new Map<string, CustomerProductPurchaseHistoryItem[]>();
  customerHistoryItems.forEach((h) => {
    const list = historyByProduct.get(h.productId) || [];
    list.push(h);
    historyByProduct.set(h.productId, list);
  });

  return (
    <div className="billing-card">
      {/* Current Sale Header matching mockup */}
      <div className="flex items-center justify-between border-b border-line bg-white px-4 py-2.5">
        <div className="flex items-center gap-2">
          <h2 className="text-[15px] font-semibold text-ink">Current Sale</h2>
          <span className="rounded-full bg-inset px-2 py-0.5 text-[12px] font-sans font-medium text-muted">
            {totalLines} items &bull; {quantitySummary}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {onOpenParkedModal && (
            <button
              type="button"
              onClick={onOpenParkedModal}
              className="flex items-center gap-1 rounded-lg border border-line bg-white px-2.5 py-1 text-[12px] font-medium text-muted hover:bg-inset transition shadow-2xs"
            >
              <Icon name="pause_circle" className="text-[14px]" />
              <span>Held Bills</span>
              {parkedCount > 0 && (
                <span className="ml-0.5 rounded-full bg-[#102043] px-1.5 py-0.2 text-[12px] font-medium text-white font-sans">
                  {parkedCount}
                </span>
              )}
            </button>
          )}
          {cart.length > 0 && onParkBill && (
            <button
              type="button"
              onClick={onParkBill}
              className="flex items-center gap-1 rounded-lg border border-line bg-white px-2.5 py-1 text-[12px] font-medium text-muted hover:bg-inset transition shadow-2xs"
              title="Park current bill (F6)"
            >
              <Icon name="local_parking" className="text-[14px]" />
              <span>Park (F6)</span>
            </button>
          )}
        </div>
      </div>

      {/* Cart Content Table */}
      <div className="billing-list">
        {cart.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center p-8 text-center text-muted">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-inset text-muted">
              <Icon name="add_shopping_cart" className="text-[28px]" />
            </div>
            <p className="mt-3 text-[14px] font-medium text-ink">Your cart is empty</p>
            <p className="mt-1 max-w-[280px] text-[13px] leading-relaxed text-muted">
              Select items from the catalog on the left or scan a barcode (F3) to begin a transaction.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2 text-[12px] text-muted">
              <span className="rounded border border-line bg-inset px-2 py-1 font-sans">
                F2 : Search
              </span>
              <span className="rounded border border-line bg-inset px-2 py-1 font-sans">
                F3 : Barcode
              </span>
              <span className="rounded border border-line bg-inset px-2 py-1 font-sans">
                F4 : Cash review
              </span>
            </div>
          </div>
        ) : (
          <table className="w-full border-collapse text-left">
            <thead className="sticky top-0 z-10 border-b border-line bg-inset text-[12px] font-medium  text-muted">
              <tr>
                <th className="py-2.5 pl-3 pr-2 w-8 text-center">#</th>
                <th className="py-2.5 px-2">Product</th>
                <th className="py-2.5 px-2 w-24">Brand</th><th className="py-2.5 px-2 text-center w-16">Stock</th>
                <th className="py-2.5 px-2 text-right w-24">Unit Price</th>
                <th className="py-2.5 px-2 text-center w-28">Qty</th>
                <th className="py-2.5 px-2 text-right w-24">Total</th>
                <th className="py-2.5 pr-3 pl-1 text-center w-9"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#e4edf6]">
              {cart.map((item, index) => {
                const pastList = historyByProduct.get(item.productId) || [];
                const latestPast = latestComparablePurchase(pastList, item.saleUnit);
                const differingPast = latestPast?.appliedUnitPrice !== item.appliedUnitPrice ? latestPast : undefined;
                const hasPriceOverride = Boolean(item.overrideUnitPrice != null);
                const catStyle = { bg: "bg-inset border-line", text: "text-muted", icon: "inventory_2" };
                const isMenuOpen = activeMenuProductId === item.productId;

                return (
                  <tr key={item.productId} ref={el => { rows.current[index] = el; }} aria-selected={selectedRowIndex === index} onClick={() => onSelectRow(index)} className={`billing-cart-row transition group ${selectedRowIndex === index ? "billing-row-selected" : ""}`}>
                    {/* Index */}
                    <td className="pl-3 pr-2 align-middle text-[12px] font-sans text-muted">
                      {index + 1}
                    </td>

                    {/* Product Details (Thumbnail + Name + SKU) */}
                    <td className="px-2 align-middle">
                      <div className="flex items-center gap-2.5">
                        <div className={`flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border ${catStyle.bg}`}>
                          <PreviewableImage presentation="billing" src={item.imageUrl} alt={item.name} title={item.name} className="flex h-full w-full items-center justify-center bg-inset" fallback={<GoogleIcon name="inventory_2" sizePx={22} className="text-[#8C8889]"/>}/>
                        </div>
                        <div className="min-w-0">
                          <div title={item.name} className="font-semibold text-black line-clamp-2">
                            {item.name}
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted mt-0.5">
                            {item.saleUnit ? (
                              <span className="text-muted">Sold by {item.saleUnit.toLowerCase()}</span>
                            ) : null}

                            {/* Unresolved Badges */}
                            {(item.unresolvedReason === "INACTIVE" || item.unresolvedReason === "UNAVAILABLE") && (
                              <span className="rounded bg-rose-100 px-1 py-0.5 text-[12px] font-semibold text-rose-800 uppercase">
                                Unavailable
                              </span>
                            )}
                            {item.unresolvedReason === "INSUFFICIENT_STOCK" && (
                              <span className="rounded bg-rose-100 px-1 py-0.5 text-[12px] font-semibold text-rose-800 uppercase">
                                Stock Short
                              </span>
                            )}
                            {item.unresolvedReason === "INVALID_STEP" && (
                              <span className="rounded bg-amber-100 px-1 py-0.5 text-[12px] font-semibold text-amber-800 uppercase">
                                Step {item.quantityStep || 1}
                              </span>
                            )}




                            {item.unresolvedReason === "UNPRICED" && <span className="text-xs text-amber-800">Rate needed</span>}
                            {/* Price Override Pill */}
                            {hasPriceOverride && (
                              <span
                                className="inline-flex items-center gap-0.5 rounded bg-blue-100 px-1 py-0.2 text-[12px] font-medium text-blue-900"
                                title={`Rate overridden from NPR ${item.originalUnitPrice}`}
                              >
                                <Icon name="edit" className="text-[12px]" />
                                <span>Override</span>
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>

                    <td className="billing-brand-cell" title={item.brand||undefined}>{item.brand||"—"}</td>
                    {/* Stock (Vibrant Green matching mockup) */}
                    <td className="px-2 align-middle font-sans text-[12px]">
                      <span className="font-medium text-green-700">{item.stock}</span>
                    </td>

                    {/* Unit Price */}
                    <td className="px-2 align-middle font-sans font-semibold text-black">
                      {item.unresolvedReason === "UNPRICED" ? "Not set" : formatBillingMoney(item.appliedUnitPrice)}
                      {item.priceType === "Wholesale" && !hasPriceOverride && <span className="billing-rate-badge" title="Quantity-based wholesale rate is active">Wholesale</span>}
                      {differingPast && onOpenDifferPopover && <button type="button" onClick={e => { e.stopPropagation(); onOpenDifferPopover(item, pastList, e.currentTarget); }} className="billing-differ rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-900" aria-label={`Inspect price difference for ${item.name}`}>Differ</button>}
                    </td>

                    {/* Qty Stepper matching mockup: [ -  12  + ] */}
                    <td className="px-2 align-middle">
                      <div className="inline-flex items-center rounded-lg border border-line bg-white shadow-2xs">
                        <button
                          type="button"
                          onClick={() => onUpdateQty(item.productId, Math.max(item.quantityStep || 1, item.qty - (item.quantityStep || 1)))}
                          className="flex h-7 w-7 items-center justify-center text-muted hover:bg-inset rounded-l-lg transition active:bg-[#e4edf6]"
                          aria-label={`Decrease quantity of ${item.name}`}
                        >
                          <Icon name="remove" className="text-[14px]" />
                        </button>
                        <input
                          id={`qty-input-${item.productId}`}
                          type="number"
                          min={item.quantityStep || 1}
                          step={item.quantityStep || 1}
                          aria-label={`Quantity of ${item.name}`}
                          max={item.stock > 0 ? item.stock : 9999}
                          value={item.qty}
                          onChange={(e) => {
                            const val = Number(e.target.value);
                            if (Number.isFinite(val) && val >= (item.quantityStep || 1)) {
                              onUpdateQty(item.productId, val);
                            }
                          }}
                          className="w-10 border-x border-line bg-transparent text-center font-sans text-[13px] font-medium text-ink focus:outline-none py-1"
                        />
                        <button
                          type="button"
                          onClick={() => onUpdateQty(item.productId, item.qty + (item.quantityStep || 1))}
                          className="flex h-7 w-7 items-center justify-center text-muted hover:bg-inset rounded-r-lg transition active:bg-[#e4edf6]"
                          aria-label={`Increase quantity of ${item.name}`}
                        >
                          <Icon name="add" className="text-[14px]" />
                        </button>
                      </div>
                    </td>

                    {/* Total (Bold text matching mockup) */}
                    <td className="px-2 align-middle font-sans font-semibold text-[14px] text-black">
                      {formatBillingMoney(item.lineTotal)}
                    </td>

                    {/* Vertical Ellipsis Menu */}
                    <td className="pr-3 pl-1 align-middle relative">
                      <button
                        type="button"
                        aria-label={`Actions for ${item.name}`} aria-haspopup="menu" aria-expanded={isMenuOpen}
                        onClick={event => { menuTrigger.current=event.currentTarget;const rect=event.currentTarget.getBoundingClientRect();setMenuPosition({left:Math.max(8,Math.min(innerWidth-216,rect.right-200)),top:rect.bottom+114>innerHeight?Math.max(8,rect.top-110):rect.bottom+4});setActiveMenuProductId(isMenuOpen ? null : item.productId); }}
                        className="p-1 rounded-md text-muted hover:text-ink hover:bg-inset transition"
                        title="Row actions"
                      >
                        <Icon name="more_vert" className="text-[18px]" />
                      </button>

                      {/* Dropdown Menu */}
                      {isMenuOpen && createPortal(
                        <div ref={menuRef} role="menu" aria-label={`Actions for ${item.name}`} className="billing-row-menu" style={menuPosition} onKeyDown={event => { if (["ArrowUp","ArrowDown"].includes(event.key)) {event.preventDefault();const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];buttons[(buttons.indexOf(document.activeElement as HTMLButtonElement)+(event.key==="ArrowDown"?1:-1)+buttons.length)%buttons.length]?.focus();} }}>
                          <button
                            type="button" role="menuitem"
                            onClick={() => {
                              setActiveMenuProductId(null);
                              menuTrigger.current?.focus();
                              onOpenPriceOverride(item);
                            }}
                            className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 font-medium text-ink hover:bg-inset"
                          >
                            <Icon name="edit" className="text-[13px]" />
                            <span>Price Override</span>
                          </button>
                          <button
                            type="button" role="menuitem"
                            onClick={() => {
                              setActiveMenuProductId(null);
                              onRemoveItem(item.productId);
                            }}
                            className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 font-medium text-rose-600 hover:bg-rose-50"
                          >
                            <Icon name="delete" className="text-[13px]" />
                            <span>Remove Item</span>
                          </button>
                        </div>, document.body
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Cart Note expandable */}
      {isNoteOpen && (
        <div className="border-t border-line bg-inset p-2.5 animate-in fade-in">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[12px] font-medium text-ink">Invoice / Sale Note</span>
            <button
              type="button"
              onClick={() => setIsNoteOpen(false)}
              className="text-muted hover:text-ink"
            >
              <Icon name="close" className="text-[14px]" />
            </button>
          </div>
          <input
            type="text"
            value={cartNote}
            onChange={(e) => setCartNote(e.target.value)}
            placeholder="Add internal remarks, delivery notes, or special instructions..."
            className="w-full rounded border border-line bg-white px-2.5 py-1 text-[12px] focus:outline-none"
          />
        </div>
      )}

      {/* Footer matching mockup */}
      <div className="border-t border-line bg-white p-3 space-y-2">
        {/* Buttons Row: "Add Note" + "Clear Cart" */}
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setIsNoteOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-inset transition shadow-2xs"
          >
            <Icon name="edit_note" className="text-[16px] text-muted" />
            <span>{cartNote ? "Edit Note" : "Add Note"}</span>
          </button>

          {canClearDraft && (
            <button
              type="button"
              onClick={onClearCart}
              className="flex items-center gap-1.5 rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-[12px] font-medium text-rose-600 hover:bg-rose-50 transition shadow-2xs"
            >
              <Icon name="delete_sweep" className="text-[16px] text-rose-600" />
              <span>Clear (F9)</span>
            </button>
          )}
        </div>

        {/* Status Line: Green dot + Cart ready text */}
        <div className="flex items-center justify-between text-[12px] text-muted pt-1 border-t border-[#f0f6fb]">
          <div className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${needsAttention ? "bg-amber-500" : "bg-[#16A34A]"}`} />
            <span>{needsAttention ? "Requires attention • resolve the item notices before review" : "Cart ready • prices and stock rechecked at checkout"}</span>
          </div>
          <span className="font-medium text-muted">
            {totalLines} items &bull; {quantitySummary}
          </span>
        </div>

        {/* Shortcut Hint line */}
        <div className="flex items-center justify-between text-[12px] text-muted pt-0.5 font-sans">
          <span>Use Alt + &uarr; / &darr; to navigate &bull; Alt + P for price override</span>
          <span className="hover:text-ink cursor-pointer">&bull;&bull;&bull; Row actions</span>
        </div>
      </div>
    </div>
  );
}
