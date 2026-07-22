const DEFAULT_CURRENCY_DECIMALS = 2;
const POS_PAYABLE_DECIMALS = 0;

export function roundCurrency(
  value: number,
  decimals = DEFAULT_CURRENCY_DECIMALS,
) {
  const normalized = Number(value || 0);
  if (!Number.isFinite(normalized)) return 0;

  const factor = 10 ** decimals;
  const rounded = Math.round((normalized + Number.EPSILON) * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function roundPayableTotal(value: number) {
  return roundCurrency(Math.max(0, value), POS_PAYABLE_DECIMALS);
}

export function getInvoicePaymentTargetTotal(netTotal: number) {
  return roundPayableTotal(netTotal);
}

export function getRemainingPaymentDue(netTotal: number, paidTotal: number) {
  return roundCurrency(
    Math.max(0, getInvoicePaymentTargetTotal(netTotal) - roundCurrency(paidTotal)),
  );
}

export function wouldExceedPaymentTarget(params: {
  netTotal: number;
  paidTotal: number;
  nextAmount: number;
}) {
  return (
    roundCurrency(params.paidTotal) + roundCurrency(params.nextAmount) >
    getInvoicePaymentTargetTotal(params.netTotal)
  );
}
