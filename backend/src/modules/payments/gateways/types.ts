import type { PaymentMethod } from "@prisma/client";

export type GatewayPaymentMethod = Extract<PaymentMethod, "ESEWA">;

export type GatewayResultStatus = "SUCCESS" | "FAILED";

export type GatewayInitiationInput = {
  paymentId: string;
  amount: number;
};

export type GatewayInitiationResult = {
  paymentId: string;
  amount: number;
  transactionUuid: string;
  formAction: string;
  fields: Record<string, string>;
};

export type GatewayVerificationInput = {
  paymentId: string;
  transactionUuid: string;
  amount: number;
  encodedPayload?: string;
};

export type GatewayVerificationResult = {
  status: GatewayResultStatus;
  reference?: string | null;
  failureReason?: string;
};

export type GatewayRedirectInput = {
  status: "success" | "failed";
  invoiceId?: string;
  invoiceNo?: string;
  paymentId?: string;
  amount?: number;
  reference?: string | null;
  message?: string;
};

export type PaymentGateway = {
  provider: GatewayPaymentMethod;
  label: string;
  createInitiation(input: GatewayInitiationInput): GatewayInitiationResult;
  verifyCallback(input: GatewayVerificationInput): Promise<GatewayVerificationResult>;
  buildResultRedirect(input: GatewayRedirectInput): string;
};
