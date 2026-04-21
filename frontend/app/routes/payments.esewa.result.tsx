import { Link, useSearchParams } from "react-router";
import Icon from "~/components/ui/Icon";
import { getAuthUser, isLoggedIn } from "~/lib/auth";
import { formatNpr } from "~/lib/invoices";

// this page handles the redirect from eSewa after a payment attempt
// it reads the URL search parameters to show success or failure to the user
export default function EsewaResultPage() {
  const [searchParams] = useSearchParams(); // reading the payment result data directly from the redirected URL

  // pulling the payment status first because the fallback message depends on whether it succeeded or failed
  const status = searchParams.get("status") || "failed";
  // showing the backend-provided message when available, otherwise falling back to a simple default message
  const message =
    searchParams.get("message") ||
    (status === "success"
      ? "eSewa payment verified successfully."
      : "eSewa payment could not be completed.");
  // grabbing invoice details from the query string so the user can confirm which bill this payment belongs to
  const invoiceId = searchParams.get("invoiceId") || "";
  const invoiceNo = searchParams.get("invoiceNo") || "";
  const reference = searchParams.get("reference") || "";
  const amountRaw = searchParams.get("amount");
  const amount = amountRaw ? Number(amountRaw) : NaN; // converting the amount string once so the UI can format it safely

  // determines if we should kick the user to the login page or back to invoices when they click the action button
  const loggedIn = isLoggedIn() && !!getAuthUser();
  const returnPath = loggedIn ? "/invoices" : "/login"; // logged-in users go back to their invoice list, guests go to login
  const success = status === "success"; // switching the icon, colors, and heading based on payment result

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-10">
      <div className="mx-auto max-w-[640px] rounded-[24px] border border-slate-200 bg-white p-8 ">
        {/* using the success flag to swap between positive and error styles quickly */}
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

        {/* showing the payment metadata in a compact summary block so the user can verify the transaction details */}
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

        {/* offering a primary way back into the app, with an extra history shortcut only when we know the invoice id */}
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link
            to={returnPath}
            className="flex h-[46px] flex-1 items-center justify-center rounded-[14px] bg-slate-900 text-[14px] font-extrabold text-white hover:bg-slate-800"
          >
            {loggedIn ? "Back to Invoices" : "Go to Login"}
          </Link>
          {/* this handles when the user is still logged in and we can safely offer a direct follow-up route */}
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

