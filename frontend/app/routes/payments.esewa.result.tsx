import { Link, useSearchParams } from "react-router";
import Icon from "~/components/ui/Icon";
import { getAuthUser, isLoggedIn } from "~/lib/auth";
import { formatNpr } from "~/lib/invoices";

export default function EsewaResultPage() {
  const [searchParams] = useSearchParams();

  const status = searchParams.get("status") || "failed";
  const message =
    searchParams.get("message") ||
    (status === "success"
      ? "eSewa payment verified successfully."
      : "eSewa payment could not be completed.");
  const invoiceId = searchParams.get("invoiceId") || "";
  const invoiceNo = searchParams.get("invoiceNo") || "";
  const reference = searchParams.get("reference") || "";
  const amountRaw = searchParams.get("amount");
  const amount = amountRaw ? Number(amountRaw) : NaN;

  const loggedIn = isLoggedIn() && !!getAuthUser();
  const returnPath = loggedIn ? "/invoices" : "/login";
  const success = status === "success";

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-10">
      <div className="mx-auto max-w-[640px] rounded-[24px] border border-slate-200 bg-white p-8 shadow-xl">
        <div
          className={`mx-auto flex h-16 w-16 items-center justify-center rounded-full ${
            success ? "bg-emerald-50 text-emerald-600" : "bg-rose-50 text-rose-600"
          }`}
        >
          <Icon name={success ? "check_circle" : "error"} className="text-[34px]" />
        </div>

        <div className="mt-5 text-center">
          <div className="text-[12px] font-extrabold uppercase tracking-[0.24em] text-slate-500">
            eSewa Result
          </div>
          <h1 className="mt-2 text-[28px] font-extrabold text-slate-900">
            {success ? "Payment Verified" : "Payment Not Completed"}
          </h1>
          <p className="mt-3 text-[14px] text-slate-600">{message}</p>
        </div>

        <div className="mt-8 space-y-3 rounded-[18px] border border-slate-200 bg-slate-50 p-5 text-[14px]">
          <div className="flex items-center justify-between gap-4">
            <span className="font-bold text-slate-500">Invoice</span>
            <span className="font-semibold text-slate-900">
              {invoiceNo || invoiceId || "-"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="font-bold text-slate-500">Method</span>
            <span className="font-semibold text-slate-900">eSewa</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="font-bold text-slate-500">Amount</span>
            <span className="font-semibold text-slate-900">
              {Number.isFinite(amount) ? formatNpr(amount) : "-"}
            </span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="font-bold text-slate-500">Reference</span>
            <span className="break-all text-right font-semibold text-slate-900">
              {reference || "-"}
            </span>
          </div>
        </div>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link
            to={returnPath}
            className="flex h-[46px] flex-1 items-center justify-center rounded-[14px] bg-slate-900 text-[14px] font-extrabold text-white hover:bg-slate-800"
          >
            {loggedIn ? "Back to Invoices" : "Go to Login"}
          </Link>
          {loggedIn && invoiceId ? (
            <Link
              to="/history"
              className="flex h-[46px] flex-1 items-center justify-center rounded-[14px] border-2 border-slate-200 bg-white text-[14px] font-extrabold text-slate-900 hover:bg-slate-50"
            >
              Open History
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}
