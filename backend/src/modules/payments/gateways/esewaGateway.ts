import crypto from "crypto";
import {
  buildEsewaResultUrl,
  buildEsewaSignature,
  decodeEsewaPayload,
  ESEWA_SIGNED_FIELD_NAMES,
  formatEsewaAmount,
  getEsewaConfig,
  getEsewaStatusCheckUrlCandidates,
  verifyEsewaSignature,
  type EsewaFormFields,
  type EsewaStatusResponse,
} from "../esewa";
import type {
  GatewayInitiationInput,
  GatewayInitiationResult,
  GatewayRedirectInput,
  GatewayVerificationInput,
  GatewayVerificationResult,
  PaymentGateway,
} from "./types";

function buildEsewaTransactionUuid() {
  return `esw-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

async function fetchEsewaStatus(transactionUuid: string, totalAmount: string) {
  const config = getEsewaConfig();
  const statusCheckUrls = getEsewaStatusCheckUrlCandidates(config.statusCheckUrl);
  let lastError: Error | null = null;

  for (const statusCheckUrl of statusCheckUrls) {
    try {
      const url = new URL(statusCheckUrl);
      url.searchParams.set("product_code", config.productCode);
      url.searchParams.set("total_amount", totalAmount);
      url.searchParams.set("transaction_uuid", transactionUuid);

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
      });

      const rawText = await response.text();
      const data = rawText ? (JSON.parse(rawText) as EsewaStatusResponse) : null;

      if (!response.ok || !data) {
        throw new Error(`Status API returned ${response.status || 0} from ${url.origin}.`);
      }

      return data;
    } catch (err) {
      lastError =
        err instanceof Error
          ? err
          : new Error("Could not verify transaction with eSewa.");
    }
  }

  throw lastError || new Error("Could not verify transaction with eSewa.");
}

function createEsewaInitiation(input: GatewayInitiationInput): GatewayInitiationResult {
  const config = getEsewaConfig();
  const transactionUuid = buildEsewaTransactionUuid();
  const amountText = formatEsewaAmount(input.amount);
  const signedFieldNames = ESEWA_SIGNED_FIELD_NAMES.join(",");
  const fields: EsewaFormFields = {
    amount: amountText,
    tax_amount: "0",
    total_amount: amountText,
    transaction_uuid: transactionUuid,
    product_code: config.productCode,
    product_service_charge: "0",
    product_delivery_charge: "0",
    success_url: `${config.backendBaseUrl}/api/payments/esewa/verify/${input.paymentId}`,
    failure_url: `${config.backendBaseUrl}/api/payments/esewa/failure/${input.paymentId}`,
    signed_field_names: signedFieldNames,
    signature: "",
  };

  fields.signature = buildEsewaSignature(
    fields,
    ESEWA_SIGNED_FIELD_NAMES,
    config.secretKey,
  );

  return {
    paymentId: input.paymentId,
    amount: input.amount,
    transactionUuid,
    formAction: config.formUrl,
    fields,
  };
}

async function verifyEsewaCallback(
  input: GatewayVerificationInput,
): Promise<GatewayVerificationResult> {
  const config = getEsewaConfig();

  let payload;
  try {
    payload = decodeEsewaPayload(String(input.encodedPayload || ""));
  } catch {
    return {
      status: "FAILED",
      failureReason: "Missing or invalid eSewa callback payload.",
    };
  }

  const payloadStatus = String(payload.status || "").toUpperCase();
  const payloadAmount = Math.round(Number(payload.total_amount || 0) * 100) / 100;
  const expectedAmount = Math.round(input.amount * 100) / 100;

  if (
    !verifyEsewaSignature(payload, config.secretKey) ||
    payloadStatus !== "COMPLETE" ||
    payload.transaction_uuid !== input.transactionUuid ||
    payload.product_code !== config.productCode ||
    Math.abs(payloadAmount - expectedAmount) > 0.01
  ) {
    return {
      status: "FAILED",
      failureReason: "eSewa callback validation failed.",
    };
  }

  try {
    const statusResponse = await fetchEsewaStatus(
      input.transactionUuid,
      formatEsewaAmount(input.amount),
    );

    const statusText = String(statusResponse.status || "").toUpperCase();
    if (statusText !== "COMPLETE") {
      return {
        status: "FAILED",
        failureReason: `eSewa status check returned ${statusText || "UNKNOWN"}.`,
      };
    }

    return {
      status: "SUCCESS",
      reference: payload.transaction_code || statusResponse.refId || statusResponse.ref_id || null,
    };
  } catch {
    return {
      status: "FAILED",
      failureReason: "Could not verify transaction with eSewa.",
    };
  }
}

function buildEsewaRedirect(input: GatewayRedirectInput) {
  const config = getEsewaConfig();
  return buildEsewaResultUrl(config.frontendBaseUrl, {
    status: input.status,
    invoiceId: input.invoiceId,
    invoiceNo: input.invoiceNo,
    paymentId: input.paymentId,
    amount:
      typeof input.amount === "number"
        ? formatEsewaAmount(input.amount)
        : undefined,
    reference: input.reference || undefined,
    message: input.message,
  });
}

export const esewaGateway: PaymentGateway = {
  provider: "ESEWA",
  label: "eSewa",
  createInitiation: createEsewaInitiation,
  verifyCallback: verifyEsewaCallback,
  buildResultRedirect: buildEsewaRedirect,
};
