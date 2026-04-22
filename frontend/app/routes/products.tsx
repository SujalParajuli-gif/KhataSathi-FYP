import { Link, useSearchParams } from "react-router";
import Icon from "~/components/ui/Icon";
import { getAuthUser, isLoggedIn } from "~/lib/auth";
import { formatNpr } from "~/lib/invoices";

// this page mirrors the eSewa redirect result and shows the payment summary after the gateway sends the user back
export default function EsewaResultPage() {
  const [searchParams] = useSearchParams(); // reading the payment result data from the current URL

  // taking the status first because the fallback message depends on whether this was a success or failure case
  const status = searchParams.get("status") || "failed";
  // using the gateway message when it exists, otherwise showing a safe default message
  const message =
    searchParams.get("message") ||
    (status === "success"
      ? "eSewa payment verified successfully."
      : "eSewa payment could not be completed.");
  // keeping all invoice-related values together so the summary card below can show them cleanly
  const invoiceId = searchParams.get("invoiceId") || "";
  const invoiceNo = searchParams.get("invoiceNo") || "";
  const reference = searchParams.get("reference") || "";
  const amountRaw = searchParams.get("amount");
  const amount = amountRaw ? Number(amountRaw) : NaN; // converting the amount once so we can check if it is valid before formatting

  const loggedIn = isLoggedIn() && !!getAuthUser(); // deciding whether the user should go back into the app or to login first
  const returnPath = loggedIn ? "/invoices" : "/login"; // the main action button uses this destination
  const success = status === "success"; // controls the heading, icon, and status colors

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-10">
      <div className="mx-auto max-w-[640px] rounded-[24px] border border-slate-200 bg-white p-8 ">
        {/* switching the visual tone quickly based on whether the payment was verified */}
        <div
          className={`mx-auto flex h-16 w-16 items-center justify-center rounded-full ${
            success ? "bg-emerald-50 text-emerald-600" : "bg-rose-50 text-rose-600"
          }`}
        >
          <Icon name={success ? "check_circle" : "error"} className="text-[34px]" />
        </div>

        <div className="mt-5 text-center">
          <div className="text-[12px] font-extrabold uppercase  text-slate-500">
            eSewa Result
          </div>
          <h1 className="mt-2 text-[28px] font-extrabold text-slate-900">
            {success ? "Payment Verified" : "Payment Not Completed"}
          </h1>
          <p className="mt-3 text-[14px] text-slate-600">{message}</p>
        </div>

        {/* summarizing the payment details here helps the user verify the invoice and reference before leaving the page */}
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

        {/* always showing one return action, and only showing the history shortcut when we know which invoice to follow up on */}
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link
            to={returnPath}
            className="flex h-[46px] flex-1 items-center justify-center rounded-[14px] bg-slate-900 text-[14px] font-extrabold text-white hover:bg-slate-800"
          >
            {loggedIn ? "Back to Invoices" : "Go to Login"}
          </Link>
          {/* this handles when the user is authenticated and there is enough context to open related invoice history */}
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

