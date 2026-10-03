import test from "node:test";
import assert from "node:assert/strict";
import * as invoiceService from "../modules/invoices/service";
import { checkout } from "../modules/invoices/controller";

test("checkout preserves request authorization, not-found, and state-conflict HTTP statuses", async () => {
  const original = invoiceService.checkoutInvoice;
  try {
    for (const statusCode of [403, 404, 409]) {
      (invoiceService as any).checkoutInvoice = async () => {
        throw Object.assign(new Error("Draft request validation failed"), { statusCode });
      };
      const res: any = { status(code: number) { this.statusCode = code; return this; }, json(body: any) { this.body = body; } };
      await checkout({ user: { id: "cashier" }, body: { operationKey: "checkout-operation-123", draftRequestId: "request", items: [{ productId: "product", qty: 1 }] } } as any, res);
      assert.equal(res.statusCode, statusCode);
      assert.equal(res.body.error, "Draft request validation failed");
    }
  } finally { (invoiceService as any).checkoutInvoice = original; }
});
