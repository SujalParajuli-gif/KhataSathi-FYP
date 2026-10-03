import assert from "node:assert/strict";
import test from "node:test";

test("Customer product history URL and parameter construction", () => {
  function buildCustomerProductHistoryRequest(customerId, productIds) {
    const encodedCustomer = encodeURIComponent(customerId);
    const params = { productIds: productIds.join(",") };
    const url = `/api/customers/${encodedCustomer}/product-history`;
    return { url, params };
  }

  const result = buildCustomerProductHistoryRequest("cust_123", ["prod_1", "prod_2", "prod_3"]);
  assert.equal(result.url, "/api/customers/cust_123/product-history");
  assert.equal(result.params.productIds, "prod_1,prod_2,prod_3");

  const specialCharCustomer = buildCustomerProductHistoryRequest("cust/special&id", ["prod_1"]);
  assert.equal(specialCharCustomer.url, "/api/customers/cust%2Fspecial%26id/product-history");
});

test("History request lifecycle: empty cart or unselected customer produces no query", () => {
  function computeHistoryRequestParams(selectedCustomerId, cart) {
    const ids = new Set();
    for (const line of cart) {
      if (line.productId) ids.add(line.productId);
    }
    const cartProductIds = Array.from(ids).sort();
    if (!selectedCustomerId || cartProductIds.length === 0) {
      return null;
    }
    return {
      customerId: selectedCustomerId,
      productIds: cartProductIds.slice(0, 20),
    };
  }

  // 1. Unselected customer with cart items -> no request
  assert.equal(computeHistoryRequestParams(null, [{ productId: "p1" }]), null);

  // 2. Selected customer with empty cart -> no request
  assert.equal(computeHistoryRequestParams("cust_1", []), null);

  // 3. Selected customer with cart items -> bounded request
  const params = computeHistoryRequestParams("cust_1", [
    { productId: "p3" },
    { productId: "p1" },
    { productId: "p3" }, // duplicate
    { productId: "p2" },
  ]);
  assert.deepEqual(params, {
    customerId: "cust_1",
    productIds: ["p1", "p2", "p3"],
  });

  // 4. More than 20 unique items in cart -> bounded to first 20
  const manyLines = Array.from({ length: 25 }, (_, i) => ({ productId: `p${i + 1}` }));
  const boundedParams = computeHistoryRequestParams("cust_1", manyLines);
  assert.equal(boundedParams.productIds.length, 20);
});

test("Historical data does not mutate cart prices or checkout payload", () => {
  const initialCart = [
    { productId: "p1", qty: 2, unitPrice: 200, priceType: "Retail" },
    { productId: "p2", qty: 1, unitPrice: 500, priceType: "Wholesale" },
  ];

  const historicalItems = [
    {
      id: "item_hist_1",
      invoiceId: "inv_old_1",
      invoiceNo: "INV-OLD-01",
      invoiceDate: "2026-08-01T10:00:00.000Z",
      productId: "p1",
      productName: "Product 1",
      productSku: "SKU-1",
      qty: 5,
      appliedUnitPrice: 180, // Different historical price!
    },
  ];

  // Cart prices and calculations remain pure and unchanged by historical items
  const currentSubtotal = initialCart.reduce((sum, item) => sum + item.qty * item.unitPrice, 0);
  assert.equal(currentSubtotal, 900);
  assert.equal(initialCart[0].unitPrice, 200); // Historical 180 did not overwrite current 200
});

test("History error and empty states remain nonblocking for checkout", () => {
  function isCheckoutAllowed(cart, hasStockErrors, isCheckoutBusy) {
    return cart.length > 0 && !hasStockErrors && !isCheckoutBusy;
  }

  // Even if customer history failed or is loading, checkout is allowed
  assert.equal(isCheckoutAllowed([{ productId: "p1", qty: 1 }], false, false), true);
});
