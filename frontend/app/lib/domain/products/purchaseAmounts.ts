// Exact fixed-point arithmetic for reviewed purchase input; backend remains authority.
export function decimalUnits(value: string, scale: number, positive = false): bigint {
  if (!/^\d+(\.\d+)?$/.test(value) || value.length > 30) throw new Error("Enter a non-negative decimal number.");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > scale || whole.length > 12) throw new Error(`Use at most ${scale} decimal places and 12 whole digits.`);
  const units = BigInt(whole + fraction.padEnd(scale, "0"));
  if (positive && units === 0n) throw new Error("Quantity and conversion must be greater than zero.");
  return units;
}
export function formatUnits(units: bigint, scale: number): string {
  const text = units.toString().padStart(scale + 1, "0");
  return `${text.slice(0, -scale)}.${text.slice(-scale)}`;
}
export function purchaseLineAmounts(qty: string, cost: string, factor: string) {
  const quantity = decimalUnits(qty, 3, true);
  const stock = quantity * decimalUnits(factor, 6, true);
  if (stock % 1_000_000n !== 0n) throw new Error("Converted stock must be exact to three decimal places.");
  const cents = (quantity * decimalUnits(cost, 6) + 5_000_000n) / 10_000_000n;
  return { cents, money: formatUnits(cents, 2), stock: formatUnits(stock / 1_000_000n, 3) };
}
