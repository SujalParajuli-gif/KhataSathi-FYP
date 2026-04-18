import crypto from "crypto";

// default values for eSewa test/sandbox environment
// in production, these would be overridden by environment variables
const DEFAULT_ESEWA_PRODUCT_CODE = "EPAYTEST";
const DEFAULT_ESEWA_SECRET_KEY = "8gBm/:&EnhH.1/q";
const DEFAULT_ESEWA_FORM_URL =
  "https://rc-epay.esewa.com.np/api/epay/main/v2/form";
const DEFAULT_ESEWA_STATUS_CHECK_URL =
  "https://uat.esewa.com.np/api/epay/transaction/status/";
const FALLBACK_ESEWA_STATUS_CHECK_URL =
  "https://rc.esewa.com.np/api/epay/transaction/status/";

// the fields that eSewa requires in the HMAC signature — in the exact order eSewa expects
export const ESEWA_SIGNED_FIELD_NAMES = [
  "total_amount",
  "transaction_uuid",
  "product_code",
] as const;

// defining the shape of the form fields we send to eSewa when initiating a payment
export type EsewaFormFields = {
  amount: string;
  tax_amount: string;
  total_amount: string;
  transaction_uuid: string;
  product_code: string;
  product_service_charge: string;
  product_delivery_charge: string;
  success_url: string;
  failure_url: string;
  signed_field_names: string;
  signature: string;
};

// defining the shape of the payload eSewa sends back after a successful payment
export type EsewaSuccessPayload = {
  status?: string;
  signature?: string;
  transaction_code?: string;
  total_amount?: string | number;
  transaction_uuid?: string;
  product_code?: string;
  signed_field_names?: string;
};

// defining the shape of the response from eSewa's status check API
export type EsewaStatusResponse = {
  status?: string;
  refId?: string | null;
  ref_id?: string | null;
  transaction_uuid?: string;
  total_amount?: string | number;
  totalAmount?: string | number;
  product_code?: string;
  productCode?: string;
};

// defining the eSewa configuration object — all values we need to interact with their API
export type EsewaConfig = {
  productCode: string;
  secretKey: string;
  formUrl: string;
  statusCheckUrl: string;
  backendBaseUrl: string;
  frontendBaseUrl: string;
};

// removing trailing slashes from URLs so we can append paths without double slashes
function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

// converting any value to a string for building the HMAC signature message
function stringifyFieldValue(value: unknown) {
  return value === undefined || value === null ? "" : String(value);
}

// making sure a URL ends with exactly one trailing slash (required by eSewa's status check API)
function appendTrailingSlash(value: string) {
  return `${stripTrailingSlash(value)}/`;
}

// formatting a number to exactly 2 decimal places as a string
// eSewa expects amounts in this format for their signature calculation
export function formatEsewaAmount(value: number) {
  return (Math.round(value * 100) / 100).toFixed(2);
}

// loading the eSewa configuration from environment variables, with defaults for local development
export function getEsewaConfig(): EsewaConfig {
  return {
    productCode: process.env.ESEWA_PRODUCT_CODE || DEFAULT_ESEWA_PRODUCT_CODE,
    secretKey: process.env.ESEWA_SECRET_KEY || DEFAULT_ESEWA_SECRET_KEY,
    formUrl: process.env.ESEWA_FORM_URL || DEFAULT_ESEWA_FORM_URL,
    statusCheckUrl:
      process.env.ESEWA_STATUS_CHECK_URL || DEFAULT_ESEWA_STATUS_CHECK_URL,
    backendBaseUrl: stripTrailingSlash(
      process.env.BACKEND_BASE_URL || "http://localhost:4000",
    ),
    frontendBaseUrl: stripTrailingSlash(
      process.env.FRONTEND_BASE_URL || "http://localhost:5173",
    ),
  };
}

// building a list of possible eSewa status check URLs to try
// we include both the configured URL and the known fallback URLs because eSewa has different
// endpoints for test (uat) and sandbox (rc) environments, and we try all of them
export function getEsewaStatusCheckUrlCandidates(statusCheckUrl: string) {
  const configuredUrl = appendTrailingSlash(
    statusCheckUrl || DEFAULT_ESEWA_STATUS_CHECK_URL,
  );
  const candidates = new Set<string>([configuredUrl]);

  candidates.add(appendTrailingSlash(DEFAULT_ESEWA_STATUS_CHECK_URL));
  candidates.add(appendTrailingSlash(FALLBACK_ESEWA_STATUS_CHECK_URL));
  return Array.from(candidates);
}

// building the HMAC-SHA256 signature that eSewa requires for payment verification
// the message is built by joining the signed field names and their values with commas
// then we hash it with the secret key and encode it as base64
export function buildEsewaSignature(
  fields: Record<string, unknown>,
  signedFieldNames: readonly string[],
  secretKey: string,
) {
  const message = signedFieldNames
    .map((fieldName) => `${fieldName}=${stringifyFieldValue(fields[fieldName])}`)
    .join(",");

  return crypto
    .createHmac("sha256", secretKey)
    .update(message)
    .digest("base64");
}

// decoding the base64-encoded payment response that eSewa sends back as a query parameter
// we parse it into a JSON object so we can verify the signature and extract payment details
export function decodeEsewaPayload(encodedPayload: string): EsewaSuccessPayload {
  const normalized = String(encodedPayload || "").trim();
  if (!normalized) {
    throw new Error("Missing eSewa response payload");
  }

  const decoded = Buffer.from(normalized, "base64").toString("utf8"); // decoding from base64 to a JSON string
  return JSON.parse(decoded) as EsewaSuccessPayload;
}

// verifying that the signature in eSewa's response matches what we expect
// we rebuild the signature from the payload fields using our secret key and compare it
// if they do not match, it means the response was tampered with
export function verifyEsewaSignature(
  payload: EsewaSuccessPayload,
  secretKey: string,
) {
  const signedFieldNames = String(payload.signed_field_names || "")
    .split(",")
    .map((fieldName) => fieldName.trim())
    .filter(Boolean);

  // if there is no signature or no field names, verification fails
  if (!payload.signature || signedFieldNames.length === 0) {
    return false;
  }

  const expected = buildEsewaSignature(payload, signedFieldNames, secretKey);
  return expected === payload.signature; // signatures must match exactly
}

// building the frontend URL to redirect the user to after eSewa payment completes
// we pass the payment status, invoice ID, and any error messages as query parameters
export function buildEsewaResultUrl(
  frontendBaseUrl: string,
  params: Record<string, string | number | undefined>,
) {
  const url = new URL("/payments/esewa/result", `${frontendBaseUrl}/`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}
