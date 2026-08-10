export function priceFromGrossMargin(cost: number, marginPercent: number) {
  const normalizedCost = Number(cost || 0);
  const normalizedMargin = Number(marginPercent || 0);
  if (!Number.isFinite(normalizedCost) || normalizedCost <= 0) {
    throw new Error("Base rate must be greater than 0.");
  }
  if (!Number.isFinite(normalizedMargin) || normalizedMargin < 0 || normalizedMargin >= 100) {
    throw new Error("Gross margin must be between 0 and 99.99 percent.");
  }
  return Math.round((normalizedCost / (1 - normalizedMargin / 100)) * 100) / 100;
}
