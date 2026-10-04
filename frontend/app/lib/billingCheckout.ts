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
    splitCashAmount?: number;
    splitEsewaAmount?: number;
    splitFonepayAmount?: number;
    changeDue?: number;
    balanceDue?: number;
  };
};

export function isQuantityStepCompliant(qty: number, step?: number): boolean {
  if (!step || step <= 0) return true;
  const remainder = qty % step;
  return remainder < 0.0001 || Math.abs(remainder - step) < 0.0001;
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
  paymentMethod: "Cash" | "eSewa" | "Fonepay" | "Split";
  paymentStatus: "Paid" | "Partial" | "Unpaid";
  paidAmountStr: string;
  cashTenderedStr: string;
  fonepayReference: string;
  splitPayments: Array<{
    method: "CASH" | "ESEWA" | "FONEPAY";
    amount: string | number;
    reference?: string;
    tenderedAmount?: string | number;
  }>;
  splitCashAmountStr: string;
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
  }> = [];

  let effectivePaidAmount = 0;
  let changeDue = 0;
  let balanceDue = 0;
  let splitCashAmountNum: number | undefined = undefined;
  let splitEsewaAmountNum: number | undefined = undefined;
  let splitFonepayAmountNum: number | undefined = undefined;

  const cashTenderedNum = Number(cashTenderedStr);
  const validCashTendered = Number.isFinite(cashTenderedNum) && cashTenderedNum > 0 ? cashTenderedNum : undefined;

  if (paymentMethod === "Split") {
    const normalizedSplit = splitPayments
      .map((p) => {
        const amt = Number(p.amount);
        const tnd = Number(p.tenderedAmount);
        return {
          method: p.method,
          amount: Number.isFinite(amt) ? amt : 0,
          reference: p.method === "FONEPAY" ? p.reference?.trim() || undefined : undefined,
          tenderedAmount: p.method === "CASH" && Number.isFinite(tnd) && tnd > 0 ? tnd : undefined,
        };
      })
      .filter((p) => p.amount > 0);

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

    if (paymentStatus === "Paid") {
      if (Math.abs(splitTotal - candidatePayableTotal) > 0.01) {
        return {
          success: false,
          error: `Split payments total (Rs. ${splitTotal}) does not match updated bill total (Rs. ${candidatePayableTotal}). Please adjust split allocations.`,
        };
      }
      effectivePaidAmount = candidatePayableTotal;
      balanceDue = 0;
    } else if (paymentStatus === "Unpaid") {
      effectivePaidAmount = 0;
      balanceDue = candidatePayableTotal;
      candidatePayments = [];
    } else {
      // Partial
      if (splitTotal <= 0) {
        return { success: false, error: "Partial split payment requires at least one payment amount." };
      }
      effectivePaidAmount = Math.min(splitTotal, candidatePayableTotal);
      balanceDue = Math.max(0, candidatePayableTotal - effectivePaidAmount);
    }

    if (paymentStatus !== "Unpaid") {
      candidatePayments = normalizedSplit.map((p) => ({
        method: p.method,
        amount: p.amount,
        reference: p.reference,
        tenderedAmount: p.tenderedAmount,
      }));
      // Calculate change on cash split if tendered > amount
      for (const p of normalizedSplit) {
        if (p.method === "CASH" && p.tenderedAmount && p.tenderedAmount > p.amount) {
          changeDue += p.tenderedAmount - p.amount;
        }
      }
    }
  } else if (paymentStatus === "Unpaid") {
    effectivePaidAmount = 0;
    balanceDue = candidatePayableTotal;
    changeDue = 0;
    candidatePayments = [];
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
      candidatePayments = [
        {
          method: "CASH",
          amount: candidatePayableTotal,
          tenderedAmount: validCashTendered,
        },
      ];
    } else if (paymentMethod === "eSewa") {
      changeDue = 0;
      candidatePayments = [{ method: "ESEWA", amount: candidatePayableTotal }];
    } else if (paymentMethod === "Fonepay") {
      const ref = fonepayReference.trim();
      if (!ref) {
        return { success: false, error: "Fonepay reference/remarks is required." };
      }
      changeDue = 0;
      candidatePayments = [{ method: "FONEPAY", amount: candidatePayableTotal, reference: ref }];
    }
  } else {
    // Partial payment
    const paidNum = Number(paidAmountStr);
    if (!Number.isFinite(paidNum) || paidNum <= 0) {
      return { success: false, error: "Partial payment requires an amount greater than 0." };
    }
    effectivePaidAmount = Math.min(paidNum, candidatePayableTotal);
    balanceDue = Math.max(0, candidatePayableTotal - effectivePaidAmount);

    if (paymentMethod === "Cash") {
      if (validCashTendered !== undefined && validCashTendered < effectivePaidAmount) {
        return {
          success: false,
          error: `Tendered cash (Rs. ${validCashTendered}) is less than partial amount (Rs. ${effectivePaidAmount}).`,
        };
      }
      changeDue = validCashTendered !== undefined ? Math.max(0, validCashTendered - effectivePaidAmount) : 0;
      candidatePayments = [
        {
          method: "CASH",
          amount: effectivePaidAmount,
          tenderedAmount: validCashTendered,
        },
      ];
    } else if (paymentMethod === "eSewa") {
      changeDue = 0;
      candidatePayments = [{ method: "ESEWA", amount: effectivePaidAmount }];
    } else if (paymentMethod === "Fonepay") {
      const ref = fonepayReference.trim();
      if (!ref) {
        return { success: false, error: "Fonepay reference/remarks is required." };
      }
      changeDue = 0;
      candidatePayments = [{ method: "FONEPAY", amount: effectivePaidAmount, reference: ref }];
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
      paymentMethod: paymentStatus === "Unpaid" ? "None" : paymentMethod,
      paymentStatus,
      effectivePaidAmount,
      fonepayReference: fonepayReference.trim() || undefined,
      splitCashAmount: splitCashAmountNum,
      splitEsewaAmount: splitEsewaAmountNum,
      splitFonepayAmount: splitFonepayAmountNum,
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
    splits: params.splitPayments,
    draftInv: params.activeDraftInvoiceId || null,
    draftReq: params.activeDraftRequestId || null,
    notes: params.invoiceNote || "",
  });
}
