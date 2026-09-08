export function priceFromPercentageChange(
  rate: number,
  percent: number,
  direction: "INCREASE" | "DECREASE",
) {
  const normalizedRate = Number(rate);
  const normalizedPercent = Number(percent);
  if (!Number.isFinite(normalizedRate) || normalizedRate <= 0) {
    throw new Error("Rate must be greater than 0.");
  }
  if (!Number.isFinite(normalizedPercent) || normalizedPercent <= 0 || normalizedPercent > 100) {
    throw new Error("Percentage must be above 0 and no more than 100.");
  }
  if (direction === "DECREASE" && normalizedPercent >= 100) {
    throw new Error("A decrease must be below 100 percent.");
  }
  const factor = direction === "DECREASE"
    ? 1 - normalizedPercent / 100
    : 1 + normalizedPercent / 100;
  return Math.round(normalizedRate * factor * 100) / 100;
}
