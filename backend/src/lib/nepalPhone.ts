const DEVANAGARI_DIGITS: Record<string, string> = {
  "०": "0",
  "१": "1",
  "२": "2",
  "३": "3",
  "४": "4",
  "५": "5",
  "६": "6",
  "७": "7",
  "८": "8",
  "९": "9",
};

export const NEPAL_COUNTRY_CODE = "+977";
export const NEPAL_MOBILE_EXAMPLE = "98XXXXXXXX";

function normalizeDigits(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[०-९]/g, (digit) => DEVANAGARI_DIGITS[digit] || digit);
}

/**
 * Converts a Nepali mobile number to one unique E.164-shaped storage value.
 * Accepted input examples: 98XXXXXXXX, +97798XXXXXXXX, 0097798XXXXXXXX,
 * spaces, dashes, and Devanagari digits. Fixed-line and short-code values are
 * intentionally rejected because user accounts require a personal mobile.
 */
export function normalizeNepalMobilePhone(value: unknown) {
  const raw = normalizeDigits(String(value ?? "").trim());
  if (!raw) {
    throw new Error("Phone number is required.");
  }

  const compact = raw.replace(/[\s().-]/g, "");
  let national = compact;
  if (national.startsWith("+977")) {
    national = national.slice(4);
  } else if (national.startsWith("00977")) {
    national = national.slice(5);
  } else if (national.startsWith("977") && national.length === 13) {
    national = national.slice(3);
  }

  if (!/^9\d{9}$/.test(national)) {
    throw new Error(
      `Enter a 10-digit Nepali mobile number such as ${NEPAL_MOBILE_EXAMPLE}.`,
    );
  }

  return `${NEPAL_COUNTRY_CODE}${national}`;
}

export function tryNormalizeNepalMobilePhone(value: unknown) {
  try {
    return normalizeNepalMobilePhone(value);
  } catch {
    return null;
  }
}
