import crypto from "crypto";

const DEFAULT_ESEWA_PRODUCT_CODE = "EPAYTEST";
const DEFAULT_ESEWA_SECRET_KEY = "8gBm/:&EnhH.1/q";
const DEFAULT_ESEWA_FORM_URL =
  "https://rc-epay.esewa.com.np/api/epay/main/v2/form";
const DEFAULT_ESEWA_STATUS_CHECK_URL =
  "https://uat.esewa.com.np/api/epay/transaction/status/";
const FALLBACK_ESEWA_STATUS_CHECK_URL =
  "https://rc.esewa.com.np/api/epay/transaction/status/";

export const ESEWA_SIGNED_FIELD_NAMES = [
  "total_amount",
  "transaction_uuid",
  "product_code",
] as const;

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

export type EsewaSuccessPayload = {
  status?: string;
  signature?: string;
  transaction_code?: string;
  total_amount?: string | number;
  transaction_uuid?: string;
  product_code?: string;
  signed_field_names?: string;
};

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

export type EsewaConfig = {
  productCode: string;
  secretKey: string;
  formUrl: string;
  statusCheckUrl: string;
  backendBaseUrl: string;
  frontendBaseUrl: string;
};

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function stringifyFieldValue(value: unknown) {
  return value === undefined || value === null ? "" : String(value);
}

function appendTrailingSlash(value: string) {
  return `${stripTrailingSlash(value)}/`;
}

export function formatEsewaAmount(value: number) {
  return (Math.round(value * 100) / 100).toFixed(2);
}

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

export function getEsewaStatusCheckUrlCandidates(statusCheckUrl: string) {
  const configuredUrl = appendTrailingSlash(
    statusCheckUrl || DEFAULT_ESEWA_STATUS_CHECK_URL,
  );
  const candidates = new Set<string>([configuredUrl]);

  candidates.add(appendTrailingSlash(DEFAULT_ESEWA_STATUS_CHECK_URL));
  candidates.add(appendTrailingSlash(FALLBACK_ESEWA_STATUS_CHECK_URL));
  return Array.from(candidates);
}

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

export function decodeEsewaPayload(encodedPayload: string): EsewaSuccessPayload {
  const normalized = String(encodedPayload || "").trim();
  if (!normalized) {
    throw new Error("Missing eSewa response payload");
  }

  const decoded = Buffer.from(normalized, "base64").toString("utf8");
  return JSON.parse(decoded) as EsewaSuccessPayload;
}

export function verifyEsewaSignature(
  payload: EsewaSuccessPayload,
  secretKey: string,
) {
  const signedFieldNames = String(payload.signed_field_names || "")
    .split(",")
    .map((fieldName) => fieldName.trim())
    .filter(Boolean);

  if (!payload.signature || signedFieldNames.length === 0) {
    return false;
  }

  const expected = buildEsewaSignature(payload, signedFieldNames, secretKey);
  return expected === payload.signature;
}

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
