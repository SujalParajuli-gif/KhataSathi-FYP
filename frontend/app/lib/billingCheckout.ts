export type PendingCheckoutSnapshot<TPayload> = {
  operationKey: string;
  payload: TPayload;
  activeDraftRequestId?: string | null;
};

export type CheckoutConfirmationPayload = {
  items: Array<{
    productId: string;
    qty: number;
    appliedUnitPrice: number;
  }>;
  payableTotal: number;
};

export type ReviewedCheckoutCandidate = {
  draftInvoiceId?: string;
  customerId?: string;
  draftRequestId?: string;
  notes?: string;
  items: Array<{
    productId: string;
    qty: number;
    overrideUnitPrice?: number;
    overrideReason?: string;
    overrideAuthorizationToken?: string;
  }>;
  payments?: Array<{
    method: "CASH" | "ESEWA" | "FONEPAY" | "BANK_TRANSFER" | "NONE";
    amount?: number;
    reference?: string;
    tenderedAmount?: number;
    receivingAccountId?: string;
    receivingAccountVersion?: number;
    manualReceiptConfirmed?: boolean;
  }>;
  confirmation: CheckoutConfirmationPayload;
  fingerprint?: string;
  display: {
    customerName?: string | null;
    lineCount: number;
    totalQty: number;
    subTotal: number;
    discountAmount: number;
    payableTotal: number;
    paymentMethod: string;
    paymentStatus: string;
    effectivePaidAmount: number;
    fonepayReference?: string;
    bankTransferReference?: string;
    receivingAccountId?: string | null;
    receivingAccountVersion?: number | null;
    receivingAccountLabel?: string | null;
    manualReceiptConfirmed?: boolean | null;
    splitCashAmount?: number;
    splitEsewaAmount?: number;
    splitFonepayAmount?: number;
    splitBankTransferAmount?: number;
    splitRows?: Array<{
      method: "CASH" | "ESEWA" | "FONEPAY" | "BANK_TRANSFER";
      amount: number;
      reference?: string;
      tenderedAmount?: number;
      receivingAccountId?: string | null;
      receivingAccountVersion?: number | null;
      receivingAccountLabel?: string | null;
      manualReceiptConfirmed?: boolean | null;
    }>;
    changeDue?: number;
    balanceDue?: number;
  };
};

export function isQuantityStepCompliant(qty: number, step?: number): boolean {
  if (!step || step <= 0) return true;
  const remainder = qty % step;
  return remainder < 0.0001 || Math.abs(remainder - step) < 0.0001;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidUuid(id: unknown): id is string {
  return typeof id === "string" && UUID_REGEX.test(id.trim());
}

export function resolvePendingCheckoutSnapshot<TPayload extends object>(
  pending: PendingCheckoutSnapshot<TPayload> | null,
  operationKey: string,
  payload: TPayload,
  activeDraftRequestId?: string | null,
): PendingCheckoutSnapshot<TPayload> {
  if (pending) return pending;
  const boundDraftRequestId =
    "draftRequestId" in (payload as any)
      ? ((payload as any).draftRequestId || undefined)
      : (activeDraftRequestId || undefined);
  return {
    operationKey,
    payload: {
      ...payload,
      draftRequestId: boundDraftRequestId,
    } as TPayload,
    activeDraftRequestId: boundDraftRequestId || null,
  };
}

export type CandidateDerivationResult =
  | { success: true; candidate: ReviewedCheckoutCandidate }
  | { success: false; error: string };

const HTML_TAG_PATTERN = /<[^>]*>/;
const CONTROL_CHAR_PATTERN = /[\x00-\x1F\x7F]/;

export function deriveCandidateCheckoutState(params: {
  cart: Array<{
    productId: string;
    qty: number;
    overrideUnitPrice?: number;
    overrideReason?: string;
    overrideAuthorizationToken?: string;
  }>;
  latestProductsById: Map<string, any>;
  selectedCustomer: any;
  subtotalDiscountPercent: number;
  paymentMethod: "Cash" | "eSewa" | "Fonepay" | "Bank Transfer" | "Split";
  paymentStatus: "Paid" | "Partial" | "Unpaid";
  paidAmountStr: string;
  cashTenderedStr: string;
  fonepayReference: string;
  bankTransferReference?: string;
  receivingAccountId?: string | null;
  receivingAccountVersion?: number | null;
  receivingAccountLabel?: string | null;
  manualReceiptConfirmed?: boolean | null;
  splitPayments: Array<{
    method: "CASH" | "ESEWA" | "FONEPAY" | "BANK_TRANSFER";
    amount: string | number;
    reference?: string;
    tenderedAmount?: string | number;
    receivingAccountId?: string | null;
    receivingAccountVersion?: number | null;
    receivingAccountLabel?: string | null;
    manualReceiptConfirmed?: boolean | null;
  }>;
  splitCashAmountStr?: string;
  activeDraftInvoiceId?: string | null;
  activeDraftRequestId?: string | null;
  selectedCustomerId?: string | null;
  invoiceNote?: string;
  shouldUseQuantityWholesalePrice: (
    customer: any,
    product: any,
    qty: number,
  ) => boolean;
}): CandidateDerivationResult {
  const {
    cart,
    latestProductsById,
    selectedCustomer,
    subtotalDiscountPercent,
    paymentMethod,
    paymentStatus,
    paidAmountStr,
    cashTenderedStr,
    fonepayReference,
    bankTransferReference = "",
    receivingAccountId,
    receivingAccountVersion,
    receivingAccountLabel,
    manualReceiptConfirmed,
    splitPayments,
    activeDraftInvoiceId,
    activeDraftRequestId,
    selectedCustomerId,
    invoiceNote,
    shouldUseQuantityWholesalePrice,
  } = params;

  if (cart.length === 0) {
    return { success: false, error: "Cart is empty." };
  }

  const candidateItems: Array<{
    productId: string;
    qty: number;
    appliedUnitPrice: number;
    overrideUnitPrice?: number;
    overrideReason?: string;
    overrideAuthorizationToken?: string;
  }> = [];

  for (const line of cart) {
    const p = latestProductsById.get(line.productId);
    if (!p) {
      return {
        success: false,
        error: `Item in cart is no longer available in the catalog. Please remove or replace it.`,
      };
    }
    if (!p.active) {
      return {
        success: false,
        error: `"${p.name}" is inactive. Please remove it from the cart.`,
      };
    }
    if (line.qty > p.stock) {
      return {
        success: false,
        error: `"${p.name}" has only ${p.stock} in stock (requested ${line.qty}). Please adjust quantity.`,
      };
    }
    if (!isQuantityStepCompliant(line.qty, p.quantityStep)) {
      return {
        success: false,
        error: `"${p.name}" quantity (${line.qty}) does not match required step (${p.quantityStep}).`,
      };
    }

    const useWholesale = shouldUseQuantityWholesalePrice(
      selectedCustomer,
      p,
      line.qty,
    );
    const basePrice = useWholesale ? p.wholesalePrice : p.retailPrice;
    const appliedUnitPrice =
      line.overrideUnitPrice !== undefined && line.overrideUnitPrice > 0
        ? line.overrideUnitPrice
        : basePrice;

    candidateItems.push({
      productId: line.productId,
      qty: line.qty,
      appliedUnitPrice,
      overrideUnitPrice: line.overrideUnitPrice,
      overrideReason: line.overrideReason,
      overrideAuthorizationToken: line.overrideAuthorizationToken,
    });
  }

  const candidateSubTotal = candidateItems.reduce(
    (sum, item) => sum + Math.round(item.appliedUnitPrice * item.qty * 100) / 100,
    0,
  );

  const computedDiscountAmount =
    subtotalDiscountPercent > 0
      ? Math.round(
          ((candidateSubTotal * subtotalDiscountPercent) / 100 +
            Number.EPSILON) *
            100,
        ) / 100
      : 0;

  const candidatePayableTotal = Math.round(
    Math.max(0, candidateSubTotal - computedDiscountAmount),
  );

  // Derive and validate payments matching refreshed candidatePayableTotal
  let candidatePayments: Array<{
    method: "CASH" | "ESEWA" | "FONEPAY" | "BANK_TRANSFER" | "NONE";
    amount?: number;
    reference?: string;
    tenderedAmount?: number;
    receivingAccountId?: string;
    receivingAccountVersion?: number;
    manualReceiptConfirmed?: boolean;
  }> = [];

  let effectivePaidAmount = 0;
  let changeDue = 0;
  let balanceDue = 0;
  let splitCashAmountNum: number | undefined = undefined;
  let splitEsewaAmountNum: number | undefined = undefined;
  let splitFonepayAmountNum: number | undefined = undefined;
  let splitBankTransferAmountNum: number | undefined = undefined;
  let normalizedSplitRowsForDisplay: Array<{
    method: "CASH" | "ESEWA" | "FONEPAY" | "BANK_TRANSFER";
    amount: number;
    reference?: string;
    tenderedAmount?: number;
    receivingAccountId?: string | null;
    receivingAccountVersion?: number | null;
    receivingAccountLabel?: string | null;
    manualReceiptConfirmed?: boolean | null;
  }> | undefined = undefined;

  const cashTenderedNum = Number(cashTenderedStr);
  const validCashTendered = Number.isFinite(cashTenderedNum) && cashTenderedNum > 0 ? cashTenderedNum : undefined;

  if (candidatePayableTotal === 0) {
    effectivePaidAmount = 0;
    balanceDue = 0;
    changeDue = 0;
    candidatePayments = [];
    normalizedSplitRowsForDisplay = undefined;
  } else if (paymentStatus === "Unpaid") {
    effectivePaidAmount = 0;
    balanceDue = candidatePayableTotal;
    changeDue = 0;
    candidatePayments = [];
    normalizedSplitRowsForDisplay = undefined;
  } else if (paymentMethod === "Split") {
    const rawSplitList = Array.isArray(splitPayments) ? splitPayments : [];
    const normalizedSplit: Array<{
      method: "CASH" | "ESEWA" | "FONEPAY" | "BANK_TRANSFER";
      amount: number;
      reference?: string;
      tenderedAmount?: number;
      receivingAccountId?: string;
      receivingAccountVersion?: number;
      receivingAccountLabel?: string | null;
      manualReceiptConfirmed?: boolean;
    }> = [];

    for (const p of rawSplitList) {
      if (p.method !== "CASH" && p.method !== "ESEWA" && p.method !== "FONEPAY" && p.method !== "BANK_TRANSFER") {
        return { success: false, error: `Unsupported split payment method: ${String((p as any).method)}` };
      }

      let amt = 0;
      if (typeof p.amount === "string") {
        const trimmed = p.amount.trim();
        if (trimmed === "") {
          amt = 0;
        } else {
          const parsed = Number(trimmed);
          if (!Number.isFinite(parsed) || parsed < 0) {
            return { success: false, error: "Split payment amount must be a valid non-negative number." };
          }
          amt = parsed;
        }
      } else if (typeof p.amount === "number") {
        if (!Number.isFinite(p.amount) || p.amount < 0) {
          return { success: false, error: "Split payment amount must be a valid non-negative number." };
        }
        amt = p.amount;
      } else {
        return { success: false, error: "Invalid split payment amount format." };
      }

      if (amt === 0) {
        continue;
      }

      if (p.method === "CASH" || p.method === "ESEWA") {
        if (p.receivingAccountId || p.receivingAccountVersion || p.manualReceiptConfirmed) {
          return {
            success: false,
            error: `Receiving destination accounts cannot be attached to ${p.method === "CASH" ? "Cash" : "eSewa"} split rows.`,
          };
        }
        const tnd = Number(p.tenderedAmount);
        const validTnd = p.method === "CASH" && Number.isFinite(tnd) && tnd > 0 ? tnd : undefined;
        normalizedSplit.push({
          method: p.method,
          amount: amt,
          tenderedAmount: validTnd,
        });
      } else {
        // FONEPAY or BANK_TRANSFER
        const rawRef = p.reference;
        const ref = typeof rawRef === "string" ? rawRef.trim() : "";
        if (!ref || ref.length > 160 || HTML_TAG_PATTERN.test(ref) || CONTROL_CHAR_PATTERN.test(ref)) {
          return {
            success: false,
            error: `Reference (1-160 chars) is required for ${p.method === "FONEPAY" ? "Fonepay" : "Bank Transfer"} in split payment.`,
          };
        }

        const trimmedRecAcc = typeof p.receivingAccountId === "string" ? p.receivingAccountId.trim() : "";
        if (trimmedRecAcc) {
          if (!isValidUuid(trimmedRecAcc)) {
            return {
              success: false,
              error: `Invalid receiving account ID for ${p.method === "FONEPAY" ? "Fonepay" : "Bank Transfer"} split row.`,
            };
          }
          const ver = Number(p.receivingAccountVersion);
          if (!Number.isInteger(ver) || ver <= 0 || !Number.isFinite(ver)) {
            return {
              success: false,
              error: `Invalid receiving account version for ${p.method === "FONEPAY" ? "Fonepay" : "Bank Transfer"} split row.`,
            };
          }
          if (p.manualReceiptConfirmed !== true) {
            return {
              success: false,
              error: `Please confirm receipt verification for ${p.method === "FONEPAY" ? "Fonepay" : "Bank Transfer"} split row.`,
            };
          }
          normalizedSplit.push({
            method: p.method,
            amount: amt,
            reference: ref,
            receivingAccountId: trimmedRecAcc,
            receivingAccountVersion: ver,
            receivingAccountLabel: p.receivingAccountLabel || null,
            manualReceiptConfirmed: true,
          });
        } else {
          // Unlinked legacy manual row
          normalizedSplit.push({
            method: p.method,
            amount: amt,
            reference: ref,
          });
        }
      }
    }

    const splitTotal = normalizedSplit.reduce((s, p) => s + p.amount, 0);

    splitCashAmountNum = normalizedSplit
      .filter((p) => p.method === "CASH")
      .reduce((s, p) => s + p.amount, 0);
    splitEsewaAmountNum = normalizedSplit
      .filter((p) => p.method === "ESEWA")
      .reduce((s, p) => s + p.amount, 0);
    splitFonepayAmountNum = normalizedSplit
      .filter((p) => p.method === "FONEPAY")
      .reduce((s, p) => s + p.amount, 0);
    splitBankTransferAmountNum = normalizedSplit
      .filter((p) => p.method === "BANK_TRANSFER")
      .reduce((s, p) => s + p.amount, 0);

    normalizedSplitRowsForDisplay = normalizedSplit.map((p) => ({
      method: p.method,
      amount: p.amount,
      reference: p.reference,
      tenderedAmount: p.tenderedAmount,
      receivingAccountId: p.receivingAccountId || undefined,
      receivingAccountVersion: p.receivingAccountVersion || undefined,
      receivingAccountLabel: p.receivingAccountLabel || undefined,
      manualReceiptConfirmed: p.manualReceiptConfirmed === true ? true : undefined,
    }));

    if (paymentStatus === "Paid") {
      if (Math.abs(splitTotal - candidatePayableTotal) > 0.01) {
        return {
          success: false,
          error: `Split payments total (Rs. ${splitTotal}) does not match updated bill total (Rs. ${candidatePayableTotal}). Please adjust split allocations.`,
        };
      }
      effectivePaidAmount = candidatePayableTotal;
      balanceDue = 0;
    } else {
      // Partial
      if (splitTotal <= 0) {
        return { success: false, error: "Partial split payment requires at least one payment amount." };
      }
      if (splitTotal > candidatePayableTotal) {
        return {
          success: false,
          error: `Split payment total (Rs. ${splitTotal}) cannot exceed bill total (Rs. ${candidatePayableTotal}).`,
        };
      }
      effectivePaidAmount = splitTotal;
      balanceDue = candidatePayableTotal - effectivePaidAmount;
    }

    candidatePayments = normalizedSplit.map((p) => {
      const item: {
        method: "CASH" | "ESEWA" | "FONEPAY" | "BANK_TRANSFER" | "NONE";
        amount: number;
        reference?: string;
        tenderedAmount?: number;
        receivingAccountId?: string;
        receivingAccountVersion?: number;
        manualReceiptConfirmed?: boolean;
      } = {
        method: p.method,
        amount: p.amount,
      };
      if (p.reference) item.reference = p.reference;
      if (p.tenderedAmount !== undefined) item.tenderedAmount = p.tenderedAmount;
      if (p.receivingAccountId) {
        item.receivingAccountId = p.receivingAccountId;
        item.receivingAccountVersion = p.receivingAccountVersion;
        item.manualReceiptConfirmed = true;
      }
      return item;
    });

    // Calculate change on cash split if tendered > amount
    for (const p of normalizedSplit) {
      if (p.method === "CASH" && p.tenderedAmount && p.tenderedAmount > p.amount) {
        changeDue += p.tenderedAmount - p.amount;
      }
    }
  } else if (paymentStatus === "Paid") {
    effectivePaidAmount = candidatePayableTotal;
    balanceDue = 0;

    if (paymentMethod === "Cash") {
      if (validCashTendered !== undefined && validCashTendered < candidatePayableTotal) {
        return {
          success: false,
          error: `Tendered cash (Rs. ${validCashTendered}) is less than updated bill total (Rs. ${candidatePayableTotal}). Please update cash received.`,
        };
      }
      changeDue = validCashTendered !== undefined ? Math.max(0, validCashTendered - candidatePayableTotal) : 0;
      const cashPay: { method: "CASH"; amount: number; tenderedAmount?: number } = {
        method: "CASH",
        amount: candidatePayableTotal,
      };
      if (validCashTendered !== undefined) cashPay.tenderedAmount = validCashTendered;
      candidatePayments = [cashPay];
    } else if (paymentMethod === "eSewa") {
      changeDue = 0;
      candidatePayments = [{ method: "ESEWA", amount: candidatePayableTotal }];
    } else if (paymentMethod === "Fonepay" || paymentMethod === "Bank Transfer") {
      const isFonepay = paymentMethod === "Fonepay";
      const method = isFonepay ? "FONEPAY" : "BANK_TRANSFER";
      const rawRef = isFonepay ? fonepayReference : (bankTransferReference || "");
      const ref = typeof rawRef === "string" ? rawRef.trim() : "";
      if (!ref || ref.length > 160 || HTML_TAG_PATTERN.test(ref) || CONTROL_CHAR_PATTERN.test(ref)) {
        return {
          success: false,
          error: `${isFonepay ? "Fonepay" : "Bank transfer"} reference/remarks (1-160 chars) is required.`,
        };
      }
      changeDue = 0;
      const trimmedRecAcc = typeof receivingAccountId === "string" ? receivingAccountId.trim() : "";
      if (trimmedRecAcc) {
        if (!isValidUuid(trimmedRecAcc)) {
          return { success: false, error: "Invalid receiving account ID." };
        }
        const ver = Number(receivingAccountVersion);
        if (!Number.isInteger(ver) || ver <= 0 || !Number.isFinite(ver)) {
          return { success: false, error: "Invalid receiving account version." };
        }
        if (manualReceiptConfirmed !== true) {
          return {
            success: false,
            error: isFonepay
              ? "Please confirm that you checked the merchant receiving account and received the money."
              : "Please confirm that you checked the receiving account and verified the bank transfer.",
          };
        }
        const paidNum = Number(paidAmountStr);
        if (!paidAmountStr || !paidAmountStr.trim() || !Number.isFinite(paidNum) || paidNum <= 0) {
          return {
            success: false,
            error: "Paid amount must be a valid positive number matching the bill total.",
          };
        }
        if (Math.abs(paidNum - candidatePayableTotal) > 0.01) {
          return {
            success: false,
            error: `Paid amount (Rs. ${paidNum}) does not match bill total (Rs. ${candidatePayableTotal}).`,
          };
        }
        candidatePayments = [
          {
            method,
            amount: candidatePayableTotal,
            reference: ref,
            receivingAccountId: trimmedRecAcc,
            receivingAccountVersion: ver,
            manualReceiptConfirmed: true,
          },
        ];
      } else {
        candidatePayments = [
          {
            method,
            amount: candidatePayableTotal,
            reference: ref,
          },
        ];
      }
    }
  } else {
    // Partial payment
    const paidNum = Number(paidAmountStr);
    if (!Number.isFinite(paidNum) || paidNum <= 0) {
      return { success: false, error: "Partial payment requires an amount greater than 0." };
    }
    if (paidNum > candidatePayableTotal) {
      return {
        success: false,
        error: `Partial payment (Rs. ${paidNum}) cannot exceed the bill total (Rs. ${candidatePayableTotal}).`,
      };
    }
    effectivePaidAmount = paidNum;
    balanceDue = candidatePayableTotal - effectivePaidAmount;

    if (paymentMethod === "Cash") {
      if (validCashTendered !== undefined && validCashTendered < effectivePaidAmount) {
        return {
          success: false,
          error: `Tendered cash (Rs. ${validCashTendered}) is less than partial amount (Rs. ${effectivePaidAmount}).`,
        };
      }
      changeDue = validCashTendered !== undefined ? Math.max(0, validCashTendered - effectivePaidAmount) : 0;
      const cashPay: { method: "CASH"; amount: number; tenderedAmount?: number } = {
        method: "CASH",
        amount: effectivePaidAmount,
      };
      if (validCashTendered !== undefined) cashPay.tenderedAmount = validCashTendered;
      candidatePayments = [cashPay];
    } else if (paymentMethod === "eSewa") {
      changeDue = 0;
      candidatePayments = [{ method: "ESEWA", amount: effectivePaidAmount }];
    } else if (paymentMethod === "Fonepay" || paymentMethod === "Bank Transfer") {
      const isFonepay = paymentMethod === "Fonepay";
      const method = isFonepay ? "FONEPAY" : "BANK_TRANSFER";
      const rawRef = isFonepay ? fonepayReference : (bankTransferReference || "");
      const ref = typeof rawRef === "string" ? rawRef.trim() : "";
      if (!ref || ref.length > 160 || HTML_TAG_PATTERN.test(ref) || CONTROL_CHAR_PATTERN.test(ref)) {
        return {
          success: false,
          error: `${isFonepay ? "Fonepay" : "Bank transfer"} reference/remarks (1-160 chars) is required.`,
        };
      }
      changeDue = 0;
      const trimmedRecAcc = typeof receivingAccountId === "string" ? receivingAccountId.trim() : "";
      if (trimmedRecAcc) {
        if (!isValidUuid(trimmedRecAcc)) {
          return { success: false, error: "Invalid receiving account ID." };
        }
        const ver = Number(receivingAccountVersion);
        if (!Number.isInteger(ver) || ver <= 0 || !Number.isFinite(ver)) {
          return { success: false, error: "Invalid receiving account version." };
        }
        if (manualReceiptConfirmed !== true) {
          return {
            success: false,
            error: isFonepay
              ? "Please confirm that you checked the merchant receiving account and received the money."
              : "Please confirm that you checked the receiving account and verified the bank transfer.",
          };
        }
        candidatePayments = [
          {
            method,
            amount: effectivePaidAmount,
            reference: ref,
            receivingAccountId: trimmedRecAcc,
            receivingAccountVersion: ver,
            manualReceiptConfirmed: true,
          },
        ];
      } else {
        candidatePayments = [
          {
            method,
            amount: effectivePaidAmount,
            reference: ref,
          },
        ];
      }
    }
  }

  const candidate: ReviewedCheckoutCandidate = {
    draftInvoiceId: activeDraftInvoiceId || undefined,
    customerId: selectedCustomerId || undefined,
    draftRequestId: activeDraftRequestId || undefined,
    notes: invoiceNote?.trim() || undefined,
    items: candidateItems,
    payments: candidatePayments,
    confirmation: {
      items: candidateItems.map((item) => ({
        productId: item.productId,
        qty: item.qty,
        appliedUnitPrice: item.appliedUnitPrice,
      })),
      payableTotal: candidatePayableTotal,
    },
    display: {
      customerName: selectedCustomer ? selectedCustomer.name : "Walk-in Customer",
      lineCount: candidateItems.length,
      totalQty: candidateItems.reduce((sum, item) => sum + item.qty, 0),
      subTotal: candidateSubTotal,
      discountAmount: computedDiscountAmount,
      payableTotal: candidatePayableTotal,
      paymentMethod:
        candidatePayableTotal === 0 || paymentStatus === "Unpaid"
          ? "None"
          : paymentMethod,
      paymentStatus,
      effectivePaidAmount,
      fonepayReference:
        candidatePayableTotal === 0 || paymentStatus === "Unpaid"
          ? undefined
          : fonepayReference.trim() || undefined,
      bankTransferReference:
        candidatePayableTotal === 0 || paymentStatus === "Unpaid"
          ? undefined
          : bankTransferReference.trim() || undefined,
      receivingAccountId:
        candidatePayableTotal === 0 || paymentStatus === "Unpaid"
          ? undefined
          : receivingAccountId || undefined,
      receivingAccountVersion:
        candidatePayableTotal === 0 || paymentStatus === "Unpaid"
          ? undefined
          : receivingAccountVersion || undefined,
      receivingAccountLabel:
        candidatePayableTotal === 0 || paymentStatus === "Unpaid"
          ? undefined
          : receivingAccountLabel || undefined,
      manualReceiptConfirmed:
        candidatePayableTotal === 0 || paymentStatus === "Unpaid"
          ? undefined
          : manualReceiptConfirmed === true
            ? true
            : undefined,
      splitCashAmount: splitCashAmountNum,
      splitEsewaAmount: splitEsewaAmountNum,
      splitFonepayAmount: splitFonepayAmountNum,
      splitBankTransferAmount: splitBankTransferAmountNum,
      splitRows: normalizedSplitRowsForDisplay,
      changeDue,
      balanceDue,
    },
  };

  return { success: true, candidate };
}

export function computeReviewFingerprint(params: {
  cart: Array<{
    productId: string;
    qty: number;
    overrideUnitPrice?: number;
    overrideReason?: string;
    overrideAuthorizationToken?: string;
  }>;
  productsById: Map<string, any>;
  selectedCustomerId?: string | null;
  selectedCustomer?: any;
  discountPercent: number;
  paymentMethod: string;
  paymentStatus: string;
  paidAmount: string;
  cashTendered: string;
  fonepayReference: string;
  bankTransferReference?: string;
  receivingAccountId?: string | null;
  receivingAccountVersion?: number | null;
  receivingAccountLabel?: string | null;
  manualReceiptConfirmed?: boolean | null;
  splitPayments: Array<any>;
  activeDraftInvoiceId?: string | null;
  activeDraftRequestId?: string | null;
  invoiceNote?: string;
}): string {
  const itemsSummary = params.cart
    .map((line) => {
      const p = params.productsById.get(line.productId);
      return `${line.productId}:${line.qty}:${line.overrideUnitPrice ?? ""}:${line.overrideReason ?? ""}:${line.overrideAuthorizationToken ?? ""}:${p?.retailPrice ?? ""}:${p?.wholesalePrice ?? ""}:${p?.wholesaleEligible ?? ""}:${p?.wholesaleQtyThreshold ?? ""}:${p?.stock ?? ""}:${p?.active ?? ""}:${p?.quantityStep ?? ""}`;
    })
    .sort()
    .join("|");

  const normalizedSplits = Array.isArray(params.splitPayments)
    ? params.splitPayments.map((p) => ({
        method: p.method,
        amount: String(p.amount ?? ""),
        ref: p.reference?.trim() || "",
        tendered: String(p.tenderedAmount ?? ""),
        recAcc: p.receivingAccountId || null,
        recVer: p.receivingAccountVersion || null,
        recConf: p.manualReceiptConfirmed === true,
      }))
    : [];

  return JSON.stringify({
    items: itemsSummary,
    cust: params.selectedCustomerId || null,
    custWholesalePercent: params.selectedCustomer?.wholesalePercent ?? null,
    custLoyaltyPercent: params.selectedCustomer?.loyaltyPercent ?? null,
    custWholesale: params.selectedCustomer?.isWholesale ?? params.selectedCustomer?.wholesale ?? null,
    disc: params.discountPercent,
    method: params.paymentMethod,
    status: params.paymentStatus,
    paid: params.paidAmount,
    tendered: params.cashTendered,
    foneRef: params.fonepayReference,
    bankRef: params.bankTransferReference || "",
    recAcc: params.receivingAccountId || null,
    recVer: params.receivingAccountVersion || null,
    recConf: params.manualReceiptConfirmed === true,
    splits: normalizedSplits,
    draftInv: params.activeDraftInvoiceId || null,
    draftReq: params.activeDraftRequestId || null,
    notes: params.invoiceNote || "",
  });
}
