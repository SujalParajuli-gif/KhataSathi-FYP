import test from "node:test";
import assert from "node:assert/strict";
import { getPaymentGateway, listPaymentGateways } from "../modules/payments/gateways";

test("payment gateway registry exposes eSewa as the first online gateway", () => {
  const gateways = listPaymentGateways();

  assert.equal(gateways.length, 1);
  assert.equal(gateways[0].provider, "ESEWA");
  assert.equal(gateways[0].label, "eSewa");
});

test("eSewa gateway builds signed initiation payload with callback URLs", () => {
  const gateway = getPaymentGateway("ESEWA");
  const intent = gateway.createInitiation({
    paymentId: "payment-123",
    amount: 250,
  });

  assert.equal(intent.paymentId, "payment-123");
  assert.equal(intent.amount, 250);
  assert.match(intent.transactionUuid, /^esw-/);
  assert.equal(intent.fields.total_amount, "250.00");
  assert.equal(intent.fields.transaction_uuid, intent.transactionUuid);
  assert.match(intent.fields.success_url, /\/api\/payments\/esewa\/verify\/payment-123$/);
  assert.match(intent.fields.failure_url, /\/api\/payments\/esewa\/failure\/payment-123$/);
  assert.ok(intent.fields.signature);
});
