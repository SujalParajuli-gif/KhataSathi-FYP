import React, { useEffect, useRef, useState } from "react";
import ProjectDateInput from "~/components/ui/ProjectDateInput";
import ProjectSelect from "~/components/ui/ProjectSelect";
import GIcon from "~/components/ui/GIcon";
import { ModalFrame as Modal } from "~/components/ui/Modal";
import type {
  ExternalDocumentType,
  PaymentAssessment,
  PaymentAssessmentType,
  RecoveryCheckoutConfirmation,
  RecoveryCheckoutInput,
  RecoveryCheckoutItem,
  RecoveryCheckoutPayment,
  SaleEvidenceRecoveryOutcome,
  SaleEvidenceRecoveryPayload,
  SalesEvidenceRecord,
} from "~/lib/api/manualBills";
import {
  getSalesEvidenceRecoveryOutcome,
  postSalesEvidenceRecovery,
  reviseSalesEvidenceRecovery,
} from "~/lib/api/manualBills";
import {
  getCurrentCashDrawerApi,
  listCustomersApi,
  listProductsApi,
} from "~/lib/api/endpoints";
import { submitEsewaForm } from "~/lib/esewa";

interface Props {
  open: boolean;
  onClose: () => void;
  document: SalesEvidenceRecord | null;
  onSuccess: (result: { invoiceId: string; invoiceNo: string }) => void;
}

const DOCUMENT_TYPE_LABELS: Record<ExternalDocumentType, string> = {
  PAN_INVOICE: "PAN Manual Bill / Invoice",
  VAT_TAX_INVOICE: "VAT Tax Invoice",
  ABBREVIATED_TAX_INVOICE: "Abbreviated Tax Invoice",
  OTHER_MANUAL_SALES_DOCUMENT: "Other Manual Sales Document",
};

interface RecoveryItemRow {
  productId: string;
  name: string;
  sku?: string | null;
  basePrice: number;
  unitPrice: number;
  qty: number;
  overrideReason?: string;
  overrideAuthorizationToken?: string;
}

interface CustomerOption {
  id: string;
  name: string;
  phone?: string | null;
  panNumber?: string | null;
}

function getNepalDateTimeLocalString(date = new Date()): string {
  const nepalOffsetMs = (5 * 60 + 45) * 60 * 1000;
  const nepalDate = new Date(date.getTime() + nepalOffsetMs);
  return nepalDate.toISOString().slice(0, 16);
}

function parseNepalDateTimeLocalToIso(localStr: string): string {
  if (!localStr) return new Date().toISOString();
  if (localStr.includes("+") || localStr.endsWith("Z")) {
    return new Date(localStr).toISOString();
  }
  return new Date(`${localStr}:00+05:45`).toISOString();
}

export default function ManualBillRecoveryModal({
  open,
  onClose,
  document,
  onSuccess,
}: Props) {
  // Outcome state
  const [outcomeLoading, setOutcomeLoading] = useState(false);
  const [outcome, setOutcome] = useState<SaleEvidenceRecoveryOutcome | null>(null);

  // Active cashier drawer
  const [activeDrawerId, setActiveDrawerId] = useState<string | null>(null);
  const [loadingDrawer, setLoadingDrawer] = useState(false);

  // Reference fields
  const [billNo, setBillNo] = useState("");
  const [externalDocumentType, setExternalDocumentType] =
    useState<ExternalDocumentType>("PAN_INVOICE");
  const [externalBillDate, setExternalBillDate] = useState(
    getNepalDateTimeLocalString().slice(0, 10),
  );
  const [reason, setReason] = useState("");
  const [duplicateOverrideReason, setDuplicateOverrideReason] = useState("");

  // Customer selection
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerOption | null>(null);
  const [customerSearch, setCustomerSearch] = useState("");
  const [customerResults, setCustomerResults] = useState<CustomerOption[]>([]);
  const [searchingCustomers, setSearchingCustomers] = useState(false);
  const [showCustomerDropdown, setShowCustomerDropdown] = useState(false);

  // Payment assessment fields
  const [assessmentType, setAssessmentType] =
    useState<PaymentAssessmentType>("CURRENT_DRAWER_CASH");
  const [collectedAt, setCollectedAt] = useState(getNepalDateTimeLocalString());
  const [notCollectedSettlement, setNotCollectedSettlement] = useState<
    "UNPAID" | "CASH" | "ESEWA" | "FONEPAY" | "BANK_TRANSFER"
  >("UNPAID");
  const [settlementReference, setSettlementReference] = useState("");

  // Line items & product search
  const [productSearch, setProductSearch] = useState("");
  const [productResults, setProductResults] = useState<any[]>([]);
  const [searchingProducts, setSearchingProducts] = useState(false);
  const [items, setItems] = useState<RecoveryItemRow[]>([]);
  const [discountAmount, setDiscountAmount] = useState<number>(0);
  const [overridePin, setOverridePin] = useState("");

  // Revision state
  const [revisionMode, setRevisionMode] = useState(false);
  const [revisionReason, setRevisionReason] = useState("");

  // eSewa digital intent result
  const [esewaIntent, setEsewaIntent] = useState<any | null>(null);

  // Submission / state
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const [conflictDoc, setConflictDoc] = useState<SalesEvidenceRecord | null>(null);

  // Ref to freeze submitted intent for retries across transport timeouts
  const lastSubmittedPayloadRef = useRef<SaleEvidenceRecoveryPayload | null>(null);

  // Reset and load outcome whenever modal opens or document changes
  useEffect(() => {
    if (!open || !document) return;

    setError(null);
    setInfoMessage(null);
    setDuplicateWarning(null);
    setConflictDoc(null);
    setEsewaIntent(null);
    setBillNo("");
    setExternalDocumentType("PAN_INVOICE");
    setExternalBillDate(getNepalDateTimeLocalString().slice(0, 10));
    setReason("");
    setDuplicateOverrideReason("");
    setSelectedCustomer(null);
    setCustomerSearch("");
    setCustomerResults([]);
    setShowCustomerDropdown(false);
    setAssessmentType("CURRENT_DRAWER_CASH");
    setCollectedAt(getNepalDateTimeLocalString());
    setNotCollectedSettlement("UNPAID");
    setSettlementReference("");
    setItems([]);
    setDiscountAmount(0);
    setOverridePin("");
    setProductSearch("");
    setProductResults([]);
    setRevisionMode(false);
    setRevisionReason("");
    lastSubmittedPayloadRef.current = null;

    loadOutcome(document.id);
    loadActiveDrawer();
  }, [open, document]);

  async function loadOutcome(docId: string): Promise<SaleEvidenceRecoveryOutcome | null> {
    setOutcomeLoading(true);
    try {
      const res = await getSalesEvidenceRecoveryOutcome(docId);
      setOutcome(res);
      if (res?.esewaPaymentIntent) {
        setEsewaIntent(res.esewaPaymentIntent);
      }
      return res;
    } catch (err: any) {
      console.error("Failed to load recovery outcome:", err);
      const unavailableOutcome: SaleEvidenceRecoveryOutcome = {
        status: "UNCERTAIN",
        document: document!,
        invoice: null,
        retryEligible: false,
        uncertainExplanation:
          "Unable to verify sales evidence recovery outcome from server. Form submission is blocked until status is verified.",
      };
      setOutcome(unavailableOutcome);
      return unavailableOutcome;
    } finally {
      setOutcomeLoading(false);
    }
  }

  async function loadActiveDrawer() {
    setLoadingDrawer(true);
    try {
      const res = await getCurrentCashDrawerApi();
      if (res?.drawer?.id && res.drawer.status === "OPEN") {
        setActiveDrawerId(res.drawer.id);
      } else {
        setActiveDrawerId(null);
      }
    } catch {
      setActiveDrawerId(null);
    } finally {
      setLoadingDrawer(false);
    }
  }

  // Customer search debounced
  useEffect(() => {
    if (!customerSearch.trim()) {
      setCustomerResults([]);
      setShowCustomerDropdown(false);
      return;
    }

    const timer = setTimeout(async () => {
      setSearchingCustomers(true);
      try {
        const res = await listCustomersApi(true);
        const all: any[] = res?.customers || (Array.isArray(res) ? res : []);
        const q = customerSearch.trim().toLowerCase();
        const filtered = all
          .filter(
            (c) =>
              c.name?.toLowerCase().includes(q) ||
              c.phone?.includes(q) ||
              c.panNumber?.includes(q),
          )
          .slice(0, 8);
        setCustomerResults(filtered);
        setShowCustomerDropdown(true);
      } catch (err) {
        console.error("Customer search error:", err);
      } finally {
        setSearchingCustomers(false);
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [customerSearch]);

  // Product search debounced
  useEffect(() => {
    if (!productSearch.trim()) {
      setProductResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      setSearchingProducts(true);
      try {
        const res = await listProductsApi({ search: productSearch.trim() });
        setProductResults(res.products || []);
      } catch (err) {
        console.error("Product search error:", err);
      } finally {
        setSearchingProducts(false);
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [productSearch]);

  function handleSelectCustomer(cust: CustomerOption) {
    setSelectedCustomer(cust);
    setCustomerSearch("");
    setCustomerResults([]);
    setShowCustomerDropdown(false);
  }

  function handleClearCustomer() {
    setSelectedCustomer(null);
    setCustomerSearch("");
    setCustomerResults([]);
    setShowCustomerDropdown(false);
  }

  function handleAddProduct(prod: any) {
    const existingIndex = items.findIndex((i) => i.productId === prod.id);
    if (existingIndex >= 0) {
      setItems((prev) =>
        prev.map((item, idx) =>
          idx === existingIndex ? { ...item, qty: item.qty + 1 } : item,
        ),
      );
    } else {
      const price = Number(prod.retailPrice ?? prod.price ?? prod.sellingPrice ?? 0);
      setItems((prev) => [
        ...prev,
        {
          productId: prod.id,
          name: prod.name,
          sku: prod.sku || prod.code || null,
          basePrice: price,
          unitPrice: price,
          qty: 1,
        },
      ]);
    }
    setProductSearch("");
    setProductResults([]);
  }

  function handleUpdateQty(index: number, newQty: number) {
    if (newQty <= 0) {
      setItems((prev) => prev.filter((_, idx) => idx !== index));
    } else {
      setItems((prev) =>
        prev.map((item, idx) => (idx === index ? { ...item, qty: newQty } : item)),
      );
    }
  }

  function handleUpdateUnitPrice(index: number, newPrice: number) {
    setItems((prev) =>
      prev.map((item, idx) =>
        idx === index
          ? {
              ...item,
              unitPrice: newPrice,
              overrideReason:
                newPrice !== item.basePrice
                  ? item.overrideReason || "Paper bill matched price"
                  : undefined,
            }
          : item,
      ),
    );
  }

  function handleUpdateOverrideReason(index: number, reasonText: string) {
    setItems((prev) =>
      prev.map((item, idx) =>
        idx === index ? { ...item, overrideReason: reasonText } : item,
      ),
    );
  }

  function handleRemoveItem(index: number) {
    setItems((prev) => prev.filter((_, idx) => idx !== index));
  }

  // Calculated totals (reviewed billing utilities alignment)
  const subtotal = items.reduce(
    (sum, item) => sum + Math.round(item.qty * item.unitPrice * 100) / 100,
    0,
  );
  const discountNum = Math.max(0, Math.min(subtotal, Number(discountAmount) || 0));
  const payableTotal = Math.max(0, Math.round(subtotal - discountNum));
  const totalItemCount = items.reduce((sum, item) => sum + item.qty, 0);

  const hasPriceOverrides = items.some((i) => i.unitPrice !== i.basePrice);

  // Policy validation
  const isPaymentBlocked =
    assessmentType === "PRIOR_OR_OTHER_CASH" ||
    assessmentType === "PRIOR_DIGITAL" ||
    assessmentType === "UNKNOWN";

  function buildPayload(): SaleEvidenceRecoveryPayload | null {
    if (!document) return null;

    const trimmedBillNo = billNo.trim();
    if (!trimmedBillNo) {
      setError("Paper bill / receipt number is required.");
      return null;
    }

    const trimmedReason = reason.trim();
    if (!trimmedReason || trimmedReason.length < 3) {
      setError("A valid recovery explanation (at least 3 characters) is required.");
      return null;
    }

    if (items.length === 0) {
      setError("At least one product item is required for sale recovery.");
      return null;
    }

    if (isPaymentBlocked) {
      setError(
        "Payment reconciliation is required. You cannot post recovery with blocked or prior payment assessment.",
      );
      return null;
    }

    if (assessmentType === "CURRENT_DRAWER_CASH" && !activeDrawerId) {
      setError(
        "Current drawer cash requires an active open cash drawer for your cashier session.",
      );
      return null;
    }

    if (
      assessmentType === "NOT_COLLECTED" &&
      notCollectedSettlement === "CASH" &&
      !activeDrawerId
    ) {
      setError(
        "Receiving fresh cash requires an active open cash drawer for your cashier session.",
      );
      return null;
    }

    if (
      assessmentType === "NOT_COLLECTED" &&
      (notCollectedSettlement === "FONEPAY" ||
        notCollectedSettlement === "BANK_TRANSFER") &&
      !settlementReference.trim()
    ) {
      setError(
        `Reference / remarks is required for fresh ${notCollectedSettlement} payment.`,
      );
      return null;
    }

    // Build confirmation strictly matching whole NPR integer schema
    const confirmation: RecoveryCheckoutConfirmation = {
      payableTotal: Math.round(payableTotal),
      items: items.map((i) => ({
        productId: i.productId,
        qty: i.qty,
        appliedUnitPrice: i.unitPrice,
      })),
    };

    // Build payments based on assessment and fresh settlement
    let payments: RecoveryCheckoutPayment[] = [];
    if (assessmentType === "CURRENT_DRAWER_CASH") {
      payments = [
        {
          method: "CASH",
          amount: Math.round(payableTotal),
          tenderedAmount: Math.round(payableTotal),
        },
      ];
    } else if (assessmentType === "NOT_COLLECTED") {
      if (notCollectedSettlement === "CASH") {
        payments = [
          {
            method: "CASH",
            amount: Math.round(payableTotal),
            tenderedAmount: Math.round(payableTotal),
          },
        ];
      } else if (notCollectedSettlement === "ESEWA") {
        payments = [
          {
            method: "ESEWA",
            amount: Math.round(payableTotal),
          },
        ];
      } else if (notCollectedSettlement === "FONEPAY") {
        payments = [
          {
            method: "FONEPAY",
            amount: Math.round(payableTotal),
            reference: settlementReference.trim(),
          },
        ];
      } else if (notCollectedSettlement === "BANK_TRANSFER") {
        payments = [
          {
            method: "BANK_TRANSFER",
            amount: Math.round(payableTotal),
            reference: settlementReference.trim(),
          },
        ];
      }
    }

    const checkoutPayload: RecoveryCheckoutInput = {
      customerId: selectedCustomer?.id || null,
      items: items.map((i) => ({
        productId: i.productId,
        qty: i.qty,
        overrideUnitPrice: i.unitPrice !== i.basePrice ? i.unitPrice : undefined,
        overrideReason:
          i.unitPrice !== i.basePrice
            ? i.overrideReason || "Paper bill matched price"
            : undefined,
        overrideAuthorizationToken: i.overrideAuthorizationToken || undefined,
      })),
      discountAmount: discountNum > 0 ? discountNum : undefined,
      overridePin: overridePin.trim() || undefined,
      payment: payments.length === 1 ? payments[0] : null,
      payments: payments.length > 0 ? payments : undefined,
      confirmation,
    };

    let paymentAssessmentObj: PaymentAssessment;
    if (assessmentType === "CURRENT_DRAWER_CASH") {
      paymentAssessmentObj = {
        type: "CURRENT_DRAWER_CASH",
        drawerId: activeDrawerId!,
        collectedAt: parseNepalDateTimeLocalToIso(collectedAt),
        explanation: trimmedReason,
        alreadyAccounted: false,
      };
    } else {
      paymentAssessmentObj = {
        type: "NOT_COLLECTED",
        explanation: trimmedReason,
      };
    }

    return {
      reference: {
        billNo: trimmedBillNo,
        externalDocumentType,
        externalBillDate,
      },
      reason: trimmedReason,
      duplicateOverrideReason: duplicateOverrideReason.trim() || undefined,
      paymentAssessment: paymentAssessmentObj,
      checkout: checkoutPayload,
    };
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!document) return;

    if (
      outcome?.status === "UNCERTAIN" ||
      outcome?.status === "ARCHIVED" ||
      outcome?.status === "COMMITTED"
    ) {
      setError("Recovery action is blocked while status is unverified or terminal.");
      return;
    }

    if (outcome?.status === "PREPARED" && !outcome?.retryEligible && !revisionMode) {
      setError(
        "Another manager prepared this attempt. Only the preparing manager can post or revise it.",
      );
      return;
    }

    let payload: SaleEvidenceRecoveryPayload | null = null;
    if (outcome?.status === "PREPARED" && !revisionMode) {
      if (lastSubmittedPayloadRef.current) {
        payload = lastSubmittedPayloadRef.current;
      } else {
        setError(
          "This attempt was previously prepared on the server. Please click 'Revise Prepared Attempt' to review and submit updated details.",
        );
        return;
      }
    } else {
      payload = buildPayload();
    }

    if (!payload) return;

    lastSubmittedPayloadRef.current = payload;
    setSubmitting(true);
    setError(null);
    setInfoMessage(null);
    setDuplicateWarning(null);

    try {
      if (revisionMode && outcome?.latestAttempt?.id) {
        const revReason = revisionReason.trim() || "Corrected recovery details";
        await reviseSalesEvidenceRecovery(document.id, {
          expectedAttemptId: outcome.latestAttempt.id,
          reason: revReason,
          recovery: payload,
        });
        setRevisionMode(false);
        setRevisionReason("");
        const refreshed = await loadOutcome(document.id);
        setInfoMessage(
          "Recovery attempt revised successfully. You can now post with the updated details.",
        );
      } else {
        const res = await postSalesEvidenceRecovery(document.id, payload);
        setOutcome({
          status: "COMMITTED",
          document: res.document,
          invoice: res.invoice,
          retryEligible: false,
        });
        if (res.esewaPaymentIntent) {
          setEsewaIntent(res.esewaPaymentIntent);
        }
        onSuccess({
          invoiceId: res.invoice.id,
          invoiceNo: res.invoice.invoiceNo,
        });
        if (!res.esewaPaymentIntent) {
          onClose();
        }
      }
    } catch (err: any) {
      // Step 1: Query current recovery outcome to reconcile transport / server errors
      try {
        const outcomeRes = await loadOutcome(document.id);
        if (outcomeRes?.status === "COMMITTED" && outcomeRes.invoice) {
          onSuccess({
            invoiceId: outcomeRes.invoice.id,
            invoiceNo: outcomeRes.invoice.invoiceNo,
          });
          if (outcomeRes.esewaPaymentIntent) {
            setEsewaIntent(outcomeRes.esewaPaymentIntent);
          } else {
            onClose();
          }
          return;
        }
        if (outcomeRes?.status === "PREPARED") {
          if (outcomeRes.retryEligible) {
            setInfoMessage(
              "Your recovery attempt is durably prepared on the server. You can retry posting with your prepared details or revise if changes are needed.",
            );
          }
        }
      } catch (outcomeErr) {
        console.error("Outcome check error:", outcomeErr);
      }

      const data = err?.response?.data;
      if (data?.code === "DUPLICATE_REVIEW_REQUIRED") {
        setDuplicateWarning(
          data.error ||
            "Duplicate paper bill reference warning. Please provide supervisor justification to override.",
        );
      } else if (data?.code === "INTENT_CONFLICT") {
        setRevisionMode(true);
        setError(
          data.error ||
            "Recovery attempt was already prepared with different details. Form switched to revision mode.",
        );
      } else if (err?.response?.status === 409) {
        setConflictDoc(data?.document || null);
        setError(
          data?.error ||
            "The sales evidence or operational state changed. Please review current status.",
        );
      } else {
        setError(
          data?.error || err.message || "Failed to complete missing sale recovery.",
        );
      }
    } finally {
      setSubmitting(false);
    }
  }

  const isFormDisabled =
    submitting ||
    outcomeLoading ||
    outcome?.status === "COMMITTED" ||
    outcome?.status === "ARCHIVED" ||
    outcome?.status === "UNCERTAIN" ||
    (outcome?.status === "PREPARED" && !revisionMode);

  if (!open || !document) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Recover Missing Sale (Paper Bill)"
    >
      <div className="max-h-[82vh] overflow-y-auto pr-1 space-y-4 text-left text-[13px]">
        {/* Outcome banner if already resolved or prepared */}
        {outcomeLoading ? (
          <div className="flex items-center gap-2 rounded-xl bg-control-hover p-3 text-secondary">
            <GIcon name="refresh" className="animate-spin text-[18px]" />
            Verifying sales evidence recovery status…
          </div>
        ) : outcome?.status === "COMMITTED" ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-emerald-900 space-y-2">
            <div className="flex items-center gap-2 font-bold text-[14px]">
              <GIcon name="check_circle" className="text-emerald-700 text-[20px]" />
              Sale Already Recovered and Committed
            </div>
            <p className="text-[12px] text-emerald-800 leading-relaxed">
                Original recovered sale: <span className="font-bold">{outcome.invoice?.invoiceNo}</span>. No further recovery action is permitted.
                {outcome.document.linkedEntityId !== outcome.invoice?.id && <span className="block break-all">The proof association was corrected to sale {outcome.document.linkedEntityId}; the original recovery posting remains unchanged.</span>}
            </p>
            {esewaIntent && (
              <div className="mt-2 rounded-lg bg-emerald-100/70 p-2.5 text-[12px] space-y-2">
                <div className="font-bold text-emerald-950">eSewa Payment Pending</div>
                <p className="text-[11px] text-emerald-900">
                  Transaction Amount: NPR {esewaIntent.amount || esewaIntent.totalAmount || payableTotal} · Reference: {esewaIntent.productCode || esewaIntent.transactionUuid || outcome.invoice?.invoiceNo}
                </p>
                {esewaIntent.formAction && esewaIntent.fields && (
                  <button
                    type="button"
                    onClick={() => submitEsewaForm(esewaIntent)}
                    className="rounded-lg bg-emerald-700 px-3 py-1.5 font-bold text-white hover:bg-emerald-800 text-[11px] flex items-center gap-1"
                  >
                    <GIcon name="open_in_new" className="text-[14px]" />
                    Proceed to eSewa Gateway
                  </button>
                )}
              </div>
            )}
            <div className="pt-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl bg-[#11120d] px-4 py-2 font-bold text-white hover:bg-black"
              >
                Close
              </button>
            </div>
          </div>
        ) : outcome?.status === "ARCHIVED" ? (
          <div className="rounded-xl border border-control-line bg-control-hover p-4 text-secondary space-y-2">
            <div className="flex items-center gap-2 font-bold text-[14px]">
              <GIcon name="archive" className="text-secondary text-[20px]" />
              Sales Evidence is Archived
            </div>
            <p className="text-[12px] text-secondary">
              Archived sales evidence cannot be recovered into a sale.
            </p>
            <div className="pt-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl border border-control-line px-4 py-2 font-bold text-secondary hover:bg-control-hover"
              >
                Close
              </button>
            </div>
          </div>
        ) : outcome?.status === "UNCERTAIN" ? (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950 space-y-2">
            <div className="flex items-center gap-2 font-bold text-[14px]">
              <GIcon name="help_outline" className="text-amber-700 text-[20px]" />
              Recovery Status Uncertain
            </div>
            <p className="text-[12px] text-amber-900 leading-relaxed">
              {outcome.uncertainExplanation ||
                "This sales evidence has conflicting or unverified recovery provenance records. Automatic recovery posting is blocked until verified by an administrator."}
            </p>
            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => loadOutcome(document.id)}
                className="rounded-xl border border-amber-400 bg-white px-4 py-2 font-bold text-amber-950 hover:bg-amber-100 flex items-center gap-1.5"
              >
                <GIcon name="refresh" className="text-[16px]" />
                Retry Status Verification
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl border border-control-line px-4 py-2 font-bold text-secondary hover:bg-control-hover"
              >
                Close
              </button>
            </div>
          </div>
        ) : outcome?.status === "PREPARED" ? (
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-blue-900 space-y-2">
            <div className="flex items-center gap-2 font-bold text-[14px]">
              <GIcon name="info" className="text-blue-700 text-[20px]" />
              Recovery Attempt Prepared
            </div>
            <p className="text-[12px] text-blue-800 leading-relaxed">
              {outcome.retryEligible
                ? lastSubmittedPayloadRef.current
                  ? "You prepared an attempt for this document. You can submit exact matching intent or revise the attempt if line items, prices, or references changed."
                  : "You prepared an attempt for this document. Because the exact memory payload is not available after reopening, please click 'Revise Prepared Attempt' below to submit updated details."
                : "Another manager prepared this attempt. Only the preparing manager can post or revise it."}
            </p>
            {outcome.retryEligible && (
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setRevisionMode(!revisionMode)}
                  className="rounded-lg bg-action px-3 py-1.5 text-[11px] font-bold text-white hover:bg-black"
                >
                  {revisionMode ? "Cancel Revision Mode" : "Revise Prepared Attempt"}
                </button>
              </div>
            )}
          </div>
        ) : null}

        {/* Evidence Header */}
        <div className="rounded-xl border border-control-line bg-control-hover p-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 truncate">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gray-200 text-secondary">
              <GIcon name="receipt_long" className="text-[20px]" />
            </div>
            <div className="truncate">
              <div className="font-bold text-[#11120d] truncate">
                {document.title || document.fileName}
              </div>
              <div className="text-[11px] text-secondary">
                Uploaded: {new Date(document.createdAt).toLocaleDateString()} · Status:{" "}
                <span className="font-semibold text-amber-700">
                  {document.saleRecoveryStatus || "UNRESOLVED"}
                </span>
              </div>
            </div>
          </div>
        </div>

        {infoMessage && (
          <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-blue-800 text-[12px] flex items-center gap-2">
            <GIcon name="info" className="text-blue-600 text-[16px] shrink-0" />
            <span>{infoMessage}</span>
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-rose-700 text-[12px] space-y-1">
            <p className="font-bold">{error}</p>
            {conflictDoc && (
              <p>Current outcome state: {conflictDoc.saleRecoveryStatus}</p>
            )}
          </div>
        )}

        {duplicateWarning && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-amber-900 text-[12px] space-y-2">
            <div className="flex items-center gap-1.5 font-bold">
              <GIcon name="warning" className="text-amber-700 text-[16px]" />
              Duplicate Bill Reference Warning
            </div>
            <p>{duplicateWarning}</p>
            <div>
              <label className="block font-bold text-[11px] mb-1">
                Supervisor Override Justification *
              </label>
              <input
                type="text"
                value={duplicateOverrideReason}
                onChange={(e) => setDuplicateOverrideReason(e.target.value)}
                placeholder="Reason for overriding duplicate paper bill reference..."
                className="w-full rounded-lg border border-amber-300 bg-white p-2 text-[12px] focus:outline-none focus:ring-1 focus:ring-amber-600"
              />
            </div>
          </div>
        )}

        {revisionMode && (
          <div className="rounded-xl border border-control-line bg-control-hover p-3 text-action text-[12px] space-y-2">
            <div className="font-bold flex items-center gap-1.5">
              <GIcon name="edit" className="text-action text-[16px]" />
              Revision Explanation (Required to replace prepared attempt)
            </div>
            <input
              type="text"
              value={revisionReason}
              onChange={(e) => setRevisionReason(e.target.value)}
              placeholder="Reason for modifying line items, quantities, or paper reference..."
              className="w-full rounded-lg border border-control-line bg-white p-2 text-[12px] focus:outline-none focus:ring-1 focus:ring-action"
            />
          </div>
        )}

        {outcome?.status !== "COMMITTED" &&
          outcome?.status !== "ARCHIVED" &&
          outcome?.status !== "UNCERTAIN" && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <fieldset disabled={isFormDisabled} className="space-y-4">
                {/* Section 1: Customer & Paper Bill Reference */}
              <div className="space-y-3 rounded-xl border border-control-line p-3.5 bg-white">
                <div className="font-bold text-[#11120d] flex items-center gap-1.5">
                  <GIcon name="badge" className="text-secondary text-[16px]" />
                  1. Customer & Paper Bill Reference
                </div>

                {/* Customer Selector */}
                <div className="relative">
                  <label className="block text-[11px] font-bold text-secondary mb-1">
                    Customer (Optional / Walk-in by default)
                  </label>
                  {selectedCustomer ? (
                    <div className="flex items-center justify-between rounded-lg border border-emerald-300 bg-emerald-50/70 p-2 text-[12px]">
                      <div>
                        <span className="font-bold text-emerald-950">
                          {selectedCustomer.name}
                        </span>
                        {selectedCustomer.phone && (
                          <span className="text-[11px] text-emerald-800 ml-2">
                            ({selectedCustomer.phone})
                          </span>
                        )}
                        {selectedCustomer.panNumber && (
                          <span className="text-[11px] text-emerald-800 ml-2">
                            PAN: {selectedCustomer.panNumber}
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={handleClearCustomer}
                        className="text-[11px] font-bold text-rose-700 hover:underline"
                      >
                        Change / Walk-in
                      </button>
                    </div>
                  ) : (
                    <div className="relative">
                      <input
                        type="text"
                        value={customerSearch}
                        onChange={(e) => setCustomerSearch(e.target.value)}
                        placeholder="Search existing customer by name, phone or PAN (or leave blank for Walk-in)..."
                        className="w-full rounded-lg border border-control-line p-2 text-[12px] text-black focus:border-black focus:outline-none focus:ring-1 focus:ring-black"
                      />
                      {searchingCustomers && (
                        <div className="absolute right-2.5 top-1/2 -translate-y-1/2">
                          <GIcon name="refresh" className="animate-spin text-placeholder text-[14px]" />
                        </div>
                      )}

                      {showCustomerDropdown && customerResults.length > 0 && (
                        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-40 overflow-y-auto rounded-xl border border-control-line bg-white shadow-lg">
                          {customerResults.map((cust) => (
                            <button
                              key={cust.id}
                              type="button"
                              onClick={() => handleSelectCustomer(cust)}
                              className="flex w-full items-center justify-between p-2 hover:bg-control-hover text-left text-[12px] border-b border-control-line last:border-b-0"
                            >
                              <div className="font-bold text-action">{cust.name}</div>
                              <div className="text-[11px] text-secondary">
                                {cust.phone ? `Phone: ${cust.phone}` : ""} {cust.panNumber ? `· PAN: ${cust.panNumber}` : ""}
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-[11px] font-bold text-secondary mb-1">
                      Paper Bill # *
                    </label>
                    <input
                      type="text"
                      value={billNo}
                      onChange={(e) => setBillNo(e.target.value)}
                      placeholder="e.g. 00482"
                      required
                      className="w-full rounded-lg border border-control-line p-2 text-[13px] font-semibold text-black focus:border-black focus:outline-none focus:ring-1 focus:ring-black font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-bold text-secondary mb-1">
                      Document Type *
                    </label>
                    <ProjectSelect
                      aria-label="Document type"
                      value={externalDocumentType}
                      onChange={(e) =>
                        setExternalDocumentType(e.target.value as ExternalDocumentType)
                      }
                      className="w-full rounded-lg border border-control-line p-2 text-[13px] text-black focus:border-black focus:outline-none focus:ring-1 focus:ring-black"
                    >
                      {Object.entries(DOCUMENT_TYPE_LABELS).map(([k, label]) => (
                        <option key={k} value={k}>
                          {label}
                        </option>
                      ))}
                    </ProjectSelect>
                  </div>

                  <div>
                    <label className="block text-[11px] font-bold text-secondary mb-1">
                      Paper Bill Date * (Historical)
                    </label>
                    <ProjectDateInput
                      aria-label="Paper bill date"
                      value={externalBillDate}
                      onChange={(e) => setExternalBillDate(e.target.value)}
                      required
                      className="w-full rounded-lg border border-control-line p-2 text-[13px] text-black focus:border-black focus:outline-none focus:ring-1 focus:ring-black"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-bold text-secondary mb-1">
                    Missing Sale Recovery Reason * (Reviewer explanation)
                  </label>
                  <input
                    type="text"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. Handwritten paper bill issued during power outage and not entered in POS"
                    required
                    minLength={3}
                    className="w-full rounded-lg border border-control-line p-2 text-[13px] text-black focus:border-black focus:outline-none focus:ring-1 focus:ring-black"
                  />
                </div>
              </div>

              {/* Section 2: Payment Assessment Policy */}
              <div className="space-y-3 rounded-xl border border-control-line p-3.5 bg-white">
                <div className="font-bold text-[#11120d] flex items-center gap-1.5">
                  <GIcon name="payments" className="text-secondary text-[16px]" />
                  2. Payment Assessment & Cashier Drawer Policy
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[12px]">
                  <label
                    className={`flex items-start gap-2 rounded-lg border p-2.5 cursor-pointer transition ${
                      assessmentType === "CURRENT_DRAWER_CASH"
                        ? "border-emerald-600 bg-emerald-50/50 font-bold text-emerald-950"
                        : "border-control-line hover:bg-control-hover text-secondary"
                    }`}
                  >
                    <input
                      type="radio"
                      name="assessmentType"
                      value="CURRENT_DRAWER_CASH"
                      checked={assessmentType === "CURRENT_DRAWER_CASH"}
                      onChange={() => setAssessmentType("CURRENT_DRAWER_CASH")}
                      className="mt-0.5"
                    />
                    <div>
                      <div>Current Drawer Cash</div>
                      <div className="text-[11px] font-normal text-secondary">
                        Cash is in active manager drawer right now
                      </div>
                    </div>
                  </label>

                  <label
                    className={`flex items-start gap-2 rounded-lg border p-2.5 cursor-pointer transition ${
                      assessmentType === "NOT_COLLECTED"
                        ? "border-action bg-control-hover font-bold text-action"
                        : "border-control-line hover:bg-control-hover text-secondary"
                    }`}
                  >
                    <input
                      type="radio"
                      name="assessmentType"
                      value="NOT_COLLECTED"
                      checked={assessmentType === "NOT_COLLECTED"}
                      onChange={() => setAssessmentType("NOT_COLLECTED")}
                      className="mt-0.5"
                    />
                    <div>
                      <div>Not Collected (Unpaid on Paper Bill)</div>
                      <div className="text-[11px] font-normal text-secondary">
                        Bill was uncollected at issuance; choose settlement
                      </div>
                    </div>
                  </label>

                  <label
                    className={`flex items-start gap-2 rounded-lg border p-2.5 cursor-pointer transition ${
                      assessmentType === "PRIOR_OR_OTHER_CASH"
                        ? "border-amber-600 bg-amber-50 font-bold text-amber-950"
                        : "border-control-line hover:bg-control-hover text-secondary"
                    }`}
                  >
                    <input
                      type="radio"
                      name="assessmentType"
                      value="PRIOR_OR_OTHER_CASH"
                      checked={assessmentType === "PRIOR_OR_OTHER_CASH"}
                      onChange={() => setAssessmentType("PRIOR_OR_OTHER_CASH")}
                      className="mt-0.5"
                    />
                    <div>
                      <div>Prior / Other Drawer Cash (Blocked)</div>
                      <div className="text-[11px] font-normal text-secondary">
                        Cash was taken in prior shift / drawer
                      </div>
                    </div>
                  </label>

                  <label
                    className={`flex items-start gap-2 rounded-lg border p-2.5 cursor-pointer transition ${
                      assessmentType === "PRIOR_DIGITAL"
                        ? "border-amber-600 bg-amber-50 font-bold text-amber-950"
                        : "border-control-line hover:bg-control-hover text-secondary"
                    }`}
                  >
                    <input
                      type="radio"
                      name="assessmentType"
                      value="PRIOR_DIGITAL"
                      checked={assessmentType === "PRIOR_DIGITAL"}
                      onChange={() => setAssessmentType("PRIOR_DIGITAL")}
                      className="mt-0.5"
                    />
                    <div>
                      <div>Prior Digital / eSewa (Blocked)</div>
                      <div className="text-[11px] font-normal text-secondary">
                        Digital payment was already completed earlier
                      </div>
                    </div>
                  </label>
                </div>

                {/* Policy Warning Banner for Blocked Payment Types */}
                {isPaymentBlocked && (
                  <div className="rounded-xl border border-rose-300 bg-rose-50 p-3 text-[12px] text-rose-900 space-y-1">
                    <div className="flex items-center gap-1.5 font-bold text-rose-800">
                      <GIcon name="block" className="text-rose-700 text-[16px]" />
                      Payment Reconciliation Required
                    </div>
                    <p className="leading-relaxed">
                      KhataSathi financial integrity policy prohibits posting prior,
                      other-drawer, or pre-existing digital payments as current drawer
                      cash. Missing sale recovery is strictly blocked with this assessment
                      until manual payment reconciliation is performed.
                    </p>
                  </div>
                )}

                {assessmentType === "CURRENT_DRAWER_CASH" && (
                  <div className="rounded-lg bg-control-hover p-3 space-y-2 text-[12px]">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[11px] font-bold text-secondary mb-1">
                          Collection Timestamp * (Current Nepal Time)
                        </label>
                        <input
                          type="datetime-local"
                          value={collectedAt}
                          onChange={(e) => setCollectedAt(e.target.value)}
                          className="w-full rounded-lg border border-control-line p-1.5 text-[12px] bg-white text-black"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold text-secondary mb-1">
                          Drawer Attribution
                        </label>
                        {loadingDrawer ? (
                          <div className="p-1.5 text-[12px] text-secondary">Checking drawer…</div>
                        ) : activeDrawerId ? (
                          <div className="p-1.5 text-[12px] text-emerald-800 font-semibold flex items-center gap-1">
                            <GIcon name="lock_open" className="text-[14px]" />
                            Active Manager Drawer ({activeDrawerId})
                          </div>
                        ) : (
                          <div className="p-1.5 text-[12px] text-rose-700 font-semibold flex items-center gap-1">
                            <GIcon name="warning" className="text-[14px]" />
                            No Open Cash Drawer Found
                          </div>
                        )}
                      </div>
                    </div>
                    {!activeDrawerId && (
                      <p className="text-[11px] text-rose-700">
                        You must open a cash drawer for your cashier session before you can attribute recovery cash to the current drawer.
                      </p>
                    )}
                  </div>
                )}

                {assessmentType === "NOT_COLLECTED" && (
                  <div className="rounded-lg bg-control-hover p-3 space-y-2.5 text-[12px]">
                    <label className="block font-bold text-[#11120d]">
                      Settlement During Recovery:
                    </label>
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                      {[
                        { id: "UNPAID", label: "Unpaid / Credit" },
                        { id: "CASH", label: "Fresh Cash" },
                        { id: "ESEWA", label: "Fresh eSewa" },
                        { id: "FONEPAY", label: "Fresh Fonepay" },
                        { id: "BANK_TRANSFER", label: "Bank Transfer" },
                      ].map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => setNotCollectedSettlement(opt.id as any)}
                          className={`rounded-lg border p-2 text-center text-[11px] font-bold transition ${
                            notCollectedSettlement === opt.id
                              ? "border-action bg-white text-action shadow-sm"
                              : "border-control-line text-secondary hover:bg-white"
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>

                    {notCollectedSettlement === "CASH" && (
                      <div className="rounded border border-control-line bg-white p-2 text-[11px]">
                        {activeDrawerId ? (
                          <span className="text-emerald-800 font-semibold">
                            Fresh cash will be deposited into active drawer ({activeDrawerId}).
                          </span>
                        ) : (
                          <span className="text-rose-700 font-semibold">
                            Fresh cash payment requires an open cash drawer. Please open a drawer first.
                          </span>
                        )}
                      </div>
                    )}

                    {notCollectedSettlement === "ESEWA" && (
                      <div className="rounded border border-emerald-300 bg-emerald-50/60 p-2 text-[11px] text-emerald-900">
                        A new eSewa digital payment intent will be created in PENDING status upon posting.
                      </div>
                    )}

                    {(notCollectedSettlement === "FONEPAY" ||
                      notCollectedSettlement === "BANK_TRANSFER") && (
                      <div>
                        <label className="block text-[11px] font-bold text-secondary mb-1">
                          {notCollectedSettlement === "FONEPAY"
                            ? "Fonepay Reference / Remarks *"
                            : "Bank Transfer Reference / Transaction ID *"}
                        </label>
                        <input
                          type="text"
                          value={settlementReference}
                          onChange={(e) => setSettlementReference(e.target.value)}
                          placeholder="e.g. FP-901823901 or TXN-4491"
                          required
                          className="w-full rounded-lg border border-control-line bg-white p-1.5 text-[12px] text-black font-mono focus:outline-none focus:ring-1 focus:ring-black"
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Section 3: Line Items & Pricing */}
              <div className="space-y-3 rounded-xl border border-control-line p-3.5 bg-white">
                <div className="font-bold text-[#11120d] flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <GIcon name="shopping_cart" className="text-secondary text-[16px]" />
                    3. Line Items & Pricing
                  </span>
                  <span className="text-[12px] text-secondary">
                    {items.length} product(s) added
                  </span>
                </div>

                {/* Product Search Bar */}
                <div className="relative">
                  <input
                    type="text"
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                    placeholder="Search products by name or SKU to add..."
                    className="w-full rounded-lg border border-control-line py-2 pl-3 pr-8 text-[13px] text-black focus:border-black focus:outline-none focus:ring-1 focus:ring-black"
                  />
                  {searchingProducts && (
                    <div className="absolute right-2.5 top-1/2 -translate-y-1/2">
                      <GIcon name="refresh" className="animate-spin text-placeholder text-[16px]" />
                    </div>
                  )}

                  {productResults.length > 0 && (
                    <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-xl border border-control-line bg-white shadow-lg">
                      {productResults.map((prod) => (
                        <button
                          key={prod.id}
                          type="button"
                          onClick={() => handleAddProduct(prod)}
                          className="flex w-full items-center justify-between p-2.5 hover:bg-control-hover text-left text-[12px] border-b border-control-line last:border-b-0"
                        >
                          <div>
                            <div className="font-bold text-action">{prod.name}</div>
                            <div className="text-[11px] text-secondary">
                              {prod.sku ? `SKU: ${prod.sku}` : ""} · Stock: {prod.stockQty ?? prod.stock ?? "N/A"}
                            </div>
                          </div>
                          <div className="font-bold text-action font-mono">
                            NPR {Number(prod.retailPrice ?? prod.price ?? prod.sellingPrice ?? 0).toLocaleString()}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Selected Items Table */}
                {items.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-control-line p-4 text-center text-placeholder text-[12px]">
                    No products added yet. Search and select items above to match the physical paper receipt.
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="overflow-x-auto">
                      <table className="w-full text-[12px]">
                        <thead>
                          <tr className="border-b border-control-line text-secondary text-[11px]">
                            <th className="py-1.5 text-left font-semibold">Item</th>
                            <th className="py-1.5 text-center font-semibold w-20">Qty</th>
                            <th className="py-1.5 text-right font-semibold w-24">Unit Price</th>
                            <th className="py-1.5 text-right font-semibold w-24">Line Total</th>
                            <th className="py-1.5 text-center font-semibold w-8"></th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {items.map((item, idx) => (
                            <tr key={item.productId} className="align-middle">
                              <td className="py-2 pr-2">
                                <div className="font-bold text-action">{item.name}</div>
                                {item.sku && (
                                  <div className="text-[10px] text-placeholder font-mono">
                                    {item.sku}
                                  </div>
                                )}
                                {item.unitPrice !== item.basePrice && (
                                  <div className="mt-1 space-y-1">
                                    <input
                                      type="text"
                                      value={item.overrideReason || ""}
                                      onChange={(e) =>
                                        handleUpdateOverrideReason(idx, e.target.value)
                                      }
                                      placeholder="Price override reason..."
                                      className="w-full rounded border border-amber-300 bg-amber-50/50 p-1 text-[11px] text-amber-950"
                                    />
                                  </div>
                                )}
                              </td>
                              <td className="py-2 px-1 text-center">
                                <div className="flex items-center justify-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() => handleUpdateQty(idx, item.qty - 1)}
                                    className="h-6 w-6 rounded bg-control-hover font-bold hover:bg-gray-200"
                                  >
                                    -
                                  </button>
                                  <span className="w-6 font-bold text-center font-mono">
                                    {item.qty}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => handleUpdateQty(idx, item.qty + 1)}
                                    className="h-6 w-6 rounded bg-control-hover font-bold hover:bg-gray-200"
                                  >
                                    +
                                  </button>
                                </div>
                              </td>
                              <td className="py-2 px-1 text-right">
                                <input
                                  type="number"
                                  min={0}
                                  step="any"
                                  value={item.unitPrice}
                                  onChange={(e) =>
                                    handleUpdateUnitPrice(idx, Number(e.target.value) || 0)
                                  }
                                  className="w-20 rounded border border-control-line p-1 text-right text-[12px] font-semibold font-mono"
                                />
                              </td>
                              <td className="py-2 pl-2 text-right font-bold text-action font-mono">
                                NPR {(item.qty * item.unitPrice).toLocaleString()}
                              </td>
                              <td className="py-2 pl-1 text-center">
                                <button
                                  type="button"
                                  onClick={() => handleRemoveItem(idx)}
                                  className="text-placeholder hover:text-rose-600"
                                >
                                  <GIcon name="close" className="text-[16px]" />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {hasPriceOverrides && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-2.5 text-[12px] space-y-1.5">
                        <div className="flex items-center gap-1 text-amber-950 font-bold">
                          <GIcon name="lock" className="text-[14px]" />
                          Supervisor Price Override Authorization
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <div>
                            <label className="block text-[10px] font-bold text-amber-900 mb-0.5">
                              Manager PIN (Optional)
                            </label>
                            <input
                              type="password"
                              value={overridePin}
                              onChange={(e) => setOverridePin(e.target.value)}
                              placeholder="Enter supervisor PIN..."
                              className="w-full rounded border border-amber-300 bg-white p-1 text-[12px]"
                            />
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Summary & Discount */}
                    <div className="rounded-lg bg-control-hover p-3 space-y-2 text-[12px] border border-control-line">
                      <div className="flex items-center justify-between text-secondary">
                        <span>Subtotal ({totalItemCount} items):</span>
                        <span className="font-semibold font-mono">NPR {subtotal.toLocaleString()}</span>
                      </div>

                      <div className="flex items-center justify-between">
                        <span className="text-secondary">Bill Discount (NPR):</span>
                        <input
                          type="number"
                          min={0}
                          max={subtotal}
                          step="any"
                          value={discountAmount || ""}
                          onChange={(e) =>
                            setDiscountAmount(Math.max(0, Number(e.target.value) || 0))
                          }
                          placeholder="0"
                          className="w-24 rounded border border-control-line p-1 text-right text-[12px] bg-white font-semibold font-mono"
                        />
                      </div>

                      <div className="flex items-center justify-between border-t border-control-line pt-2 font-bold text-[13px] text-[#11120d]">
                        <span>Total Payable:</span>
                        <span className="text-emerald-800 text-[14px] font-mono">
                          NPR {payableTotal.toLocaleString()}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </fieldset>

            {/* Actions Footer */}
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-control-line">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="rounded-xl border border-control-line px-4 py-2 font-bold text-secondary hover:bg-control-hover"
              >
                Cancel
              </button>

              <button
                type="submit"
                disabled={
                  submitting ||
                  isPaymentBlocked ||
                  items.length === 0 ||
                  outcomeLoading ||
                  (assessmentType === "CURRENT_DRAWER_CASH" && !activeDrawerId) ||
                  (assessmentType === "NOT_COLLECTED" &&
                    notCollectedSettlement === "CASH" &&
                    !activeDrawerId) ||
                  (outcome?.status === "PREPARED" && !outcome?.retryEligible) ||
                  (outcome?.status === "PREPARED" &&
                    !revisionMode &&
                    !lastSubmittedPayloadRef.current)
                }
                className="inline-flex items-center gap-2 rounded-xl bg-action px-5 py-2 font-bold text-white hover:bg-gray-800 disabled:bg-gray-300 disabled:cursor-not-allowed shadow-sm"
              >
                {submitting ? (
                  <>
                    <GIcon name="refresh" className="animate-spin text-[16px]" />
                    {revisionMode ? "Revising Attempt…" : "Posting Recovery…"}
                  </>
                ) : (
                  <>
                    <GIcon name="task_alt" className="text-[16px]" />
                    {revisionMode
                      ? "Submit Attempt Revision"
                      : outcome?.status === "PREPARED" && lastSubmittedPayloadRef.current
                      ? "Retry Posting Prepared Intent"
                      : outcome?.status === "PREPARED" && !lastSubmittedPayloadRef.current
                      ? "Prepared (Click Revise Attempt)"
                      : "Post Missing Sale Recovery"}
                  </>
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}
