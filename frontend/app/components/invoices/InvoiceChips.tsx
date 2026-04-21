import Icon from "~/components/ui/Icon";
import type { InvoiceStatusLabel, PaymentMethodLabel } from "~/lib/invoices";

// helper to join CSS class names — filters out falsy values
function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

// colored chip that displays the invoice payment status (Paid, Partial, Unpaid, Cancelled)
// each status gets a different color scheme — green for paid, amber for partial, red for unpaid, gray for cancelled
export function InvoiceStatusChip({
  status,
  className,
}: {
  status: InvoiceStatusLabel;
  className?: string;
}) {
  const styles: Record<InvoiceStatusLabel, string> = {
    Paid: "border-[#9DD8B2] bg-[#EAF8EF] text-[#179B4D]",
    Partial: "border-[#F6D28B] bg-[#FFF7E8] text-[#B7791F]",
    Unpaid: "border-[#FECDD3] bg-[#FFF1F2] text-[#BE123C]",
    Cancelled: "border-[#D1D5DB] bg-[#F3F4F6] text-[#6B7280]",
  };

  const label = status === "Partial" ? "PARTIAL" : status.toUpperCase();

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-[12px] py-[5px] text-[11px] font-extrabold ",
        styles[status],
        className,
      )}
    >
      {label}
    </span>
  );
}

// colored chip that displays the payment method (Cash, eSewa, None)
// optionally shows an icon next to the label — we use different icons for cash and eSewa
export function PaymentMethodChip({
  method,
  showIcon = false,
  className,
}: {
  method: PaymentMethodLabel;
  showIcon?: boolean;
  className?: string;
}) {
  const iconName =
    method === "Cash" ? "payments" : method === "eSewa" ? "qr_code_2" : "block";
  const label = method === "None" ? "No Payment" : method;
  const tone =
    method === "Cash"
      ? "border-[#8C8889] bg-[#FFFFFF] text-[#000000]"
      : method === "eSewa"
        ? "border-[#9DD8B2] bg-[#EAF8EF] text-[#179B4D]"
        : "border-[#D1D5DB] bg-[#F3F4F6] text-[#6B7280]";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-[6px] rounded-[10px] border px-[8px] py-[4px] text-[11px] font-bold",
        tone,
        className,
      )}
    >
      {showIcon ? <Icon name={iconName} className="text-[13px]" /> : null}
      {label}
    </span>
  );
}

