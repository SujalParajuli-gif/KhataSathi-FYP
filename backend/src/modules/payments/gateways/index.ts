import { esewaGateway } from "./esewaGateway";
import type { GatewayPaymentMethod, PaymentGateway } from "./types";

const gateways: Record<GatewayPaymentMethod, PaymentGateway> = {
  ESEWA: esewaGateway,
};

export function getPaymentGateway(method: GatewayPaymentMethod) {
  return gateways[method];
}

export function listPaymentGateways() {
  return Object.values(gateways);
}

export type {
  GatewayInitiationInput,
  GatewayInitiationResult,
  GatewayPaymentMethod,
  GatewayRedirectInput,
  GatewayVerificationInput,
  GatewayVerificationResult,
  PaymentGateway,
} from "./types";
