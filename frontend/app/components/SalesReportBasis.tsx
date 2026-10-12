import { INVOICE_SALES_BASIS, type InvoiceSalesBasis } from "~/lib/reports";

export default function SalesReportBasis({ basis = INVOICE_SALES_BASIS }: { basis?: InvoiceSalesBasis }) {
  return (
    <section aria-label="Sales reporting basis" className="rounded-[20px] border border-[#cfcfd3] bg-white px-5 py-4 text-[13px] text-[#565449]">
      <p className="font-semibold text-[#11120d]">Invoice sales: after discounts, before returns</p>
      <p className="mt-1">Returns and refunds are not deducted from sales. Recorded collections and invoice-basis due can differ from cash movement and current customer receivables. These figures do not show profit.</p>
      <details className="mt-2">
        <summary className="cursor-pointer font-semibold text-[#11120d] focus-visible:outline-2 focus-visible:outline-offset-4">View formulas and reporting limits</summary>
        <dl className="mt-3 space-y-2">
          {Object.entries(basis).filter(([key]) => key !== "kind").map(([key, text]) => (
            <div key={key}>
              <dt className="font-semibold capitalize text-[#11120d]">{key}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}
