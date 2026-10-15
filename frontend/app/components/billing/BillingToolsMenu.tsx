import React, { useEffect, useRef, useState } from "react";
import Icon from "~/components/ui/Icon";
import { ModalFrame } from "~/components/ui/Modal";
import { openInvoicePrint, openInvoiceReceiptPrint } from "~/lib/invoices";

interface BillingToolsMenuProps {
  onOpenCalculator: () => void;
  lastInvoiceId?: string | null;
}

const SHORTCUTS = [
  { key: "F2", description: "Focus product catalog search" },
  { key: "F3", description: "Focus barcode scanner input" },
  { key: "F4", description: "Prepare Cash review in Worksheet" },
  { key: "F5", description: "Prepare eSewa review in Worksheet" },
  { key: "F7", description: "Choose a customer" },
  { key: "Alt + ↑ / ↓", description: "Select and scroll through cart rows" },
  { key: "Alt + Shift + Q", description: "Edit the selected quantity" },
  { key: "Alt + Delete", description: "Remove the selected item" },
  { key: "F6", description: "Park current bill / Held bills" },
  { key: "Alt + H", description: "Open held bills" },
  { key: "Alt + Backspace", description: "Remove the selected item" },
  { key: "Alt + Shift + + / −", description: "Increase / decrease selected quantity" },
  { key: "Alt + P", description: "Price override for selected item" },
  { key: "Alt + 1 / 2 / 3 / 4", description: "Cash / Fonepay / eSewa / Split in payment review" },
  { key: "Alt + A", description: "Add a cash split in payment review" },
  { key: "↑ / ↓, Enter", description: "Select / add a product in catalog search" },
  { key: "F8", description: "Price override for selected item" },
  { key: "F9", description: "Clear active cart" },
  { key: "Shift + Enter", description: "Review / confirm current step" },
  { key: "Esc", description: "Close active popover / modal" },
];

export default function BillingToolsMenu({
  onOpenCalculator,
  lastInvoiceId,
}: BillingToolsMenuProps) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!toolsOpen) return;
    const dismiss = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setToolsOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setToolsOpen(false); triggerRef.current?.focus(); event.stopPropagation(); } };
    document.addEventListener("pointerdown",dismiss); document.addEventListener("keydown",escape);
    return () => { document.removeEventListener("pointerdown",dismiss); document.removeEventListener("keydown",escape); };
  }, [toolsOpen]);
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false);

  const handleReprintLast = () => {
    let id = lastInvoiceId;
    if (!id && typeof window !== "undefined") {
      id = localStorage.getItem("khatasathi:lastInvoicePrintId");
    }
    if (id) {
      openInvoicePrint(id);
    }
  };

  const handleReceiptPrint = () => {
    let id = lastInvoiceId;
    if (!id && typeof window !== "undefined") {
      id = localStorage.getItem("khatasathi:lastInvoicePrintId");
    }
    if (id) {
      openInvoiceReceiptPrint(id);
    }
  };

  const hasLastInvoice = Boolean(
    lastInvoiceId ||
      (typeof window !== "undefined" &&
        localStorage.getItem("khatasathi:lastInvoicePrintId"))
  );

  return (
    <div ref={rootRef} className="billing-tools">
      <button ref={triggerRef} type="button" className="billing-toolbar-button" aria-haspopup="menu" aria-expanded={toolsOpen} onClick={() => setToolsOpen(open => !open)} onKeyDown={event => {
        if (event.key === "ArrowDown") { event.preventDefault(); setToolsOpen(true); requestAnimationFrame(() => rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()); }
      }}><Icon name="more_horiz" sizePx={20}/>Tools<Icon name="expand_more" sizePx={18}/></button>
      {toolsOpen && <div role="menu" aria-label="Billing tools" className="billing-tools-menu" onKeyDown={event => {
        const items=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index=items.indexOf(document.activeElement as HTMLButtonElement);
        if (["ArrowDown","ArrowUp","Home","End"].includes(event.key)) { event.preventDefault(); const next=event.key==="Home"?0:event.key==="End"?items.length-1:(index+(event.key==="ArrowDown"?1:-1)+items.length)%items.length;items[next]?.focus(); }
      }}>
        <button type="button" role="menuitem" id="billing-calculator-trigger" onClick={() => {setToolsOpen(false);triggerRef.current?.focus();onOpenCalculator();}}><Icon name="calculate" sizePx={20}/>Calculator</button>
        <button type="button" role="menuitem" disabled={!hasLastInvoice} onClick={() => {setToolsOpen(false);triggerRef.current?.focus();handleReprintLast();}}><Icon name="print" sizePx={20}/>Reprint Last</button>
        <button type="button" role="menuitem" disabled={!hasLastInvoice} onClick={() => {setToolsOpen(false);triggerRef.current?.focus();handleReceiptPrint();}}><Icon name="receipt_long" sizePx={20}/>Receipt</button>
        <button type="button" role="menuitem" onClick={() => {setToolsOpen(false);triggerRef.current?.focus();setIsShortcutsOpen(true);}}><Icon name="keyboard" sizePx={20}/>Keyboard Shortcuts</button>
      </div>}

      {/* Shortcuts Modal */}
      {isShortcutsOpen && (
        <ModalFrame presentation="billing"
          open={isShortcutsOpen}
          title="POS Keyboard Shortcuts"
          description="Use keyboard shortcuts for fast, mouse-free counter operations."
          onClose={() => setIsShortcutsOpen(false)}
          maxWidthClass="max-w-[400px]"
        >
          <div className="divide-y divide-[#e4edf6] rounded-lg border border-line">
            {SHORTCUTS.map((s) => (
              <div
                key={s.key}
                className="flex items-center justify-between p-2.5 text-[13px]"
              >
                <span className="font-sans font-semibold text-ink bg-inset px-2 py-0.5 rounded border border-line">
                  {s.key}
                </span>
                <span className="text-muted">{s.description}</span>
              </div>
            ))}
          </div>
        </ModalFrame>
      )}
    </div>
  );
}
