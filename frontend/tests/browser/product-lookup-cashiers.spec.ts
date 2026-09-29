import { test, expect, type Page } from "@playwright/test";

const staffUser = { id: "staff-1", name: "Staff User", role: "staff" };

test.describe("Product Lookup Cashier Load", () => {
  // Use a mobile viewport so the 'Review draft' drawer button is visible!
  test.use({ viewport: { width: 375, height: 812 } });

  test("out-of-order cashier presence responses are ignored", async ({ page }) => {
    let resolveFirstRequest: (body: any) => void;
    let resolveSecondRequest: (body: any) => void;

    let requestCount = 0;

    await page.addInitScript((value) => localStorage.setItem("khatasathi_auth_user", JSON.stringify(value)), staffUser);
    await page.addInitScript(() => {
      // Create a draft so the drawer button is present
      localStorage.setItem("khatasathi:staff-draft-request:staff-1", JSON.stringify({
        items: [{ product: { id: "p1", name: "P1", stock: 10, retailPrice: 10 }, qty: 1 }]
      }));
    });
    
    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const path = new URL(route.request().url()).pathname;
      const respond = (body: unknown, status = 200) => 
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

      if (path.endsWith("/capabilities")) {
        return respond({
          businessMode: "POS",
          catalogEnabled: true,
          inventoryEnabled: true,
          posEnabled: true,
          stockTracked: true,
          staffDraftRequestsEnabled: true,
        });
      }
      if (path.endsWith("/auth/me")) return respond({ user: staffUser });
      if (path.endsWith("/brands")) return respond(["Sirpolin"]);
      if (path.endsWith("/categories")) return respond(["Plastic"]);
      if (path.endsWith("/products")) return respond({ products: [], total: 0, page: 1, pageSize: 50 });
      if (path.endsWith("/customers")) return respond({ customers: [] });

      if (path.endsWith("/users/cashiers/presence")) {
        requestCount++;
        if (requestCount === 1) {
          // The first request (poll or mount)
          return new Promise<void>((resolve) => {
            resolveFirstRequest = (body) => {
              respond(body);
              resolve();
            };
          });
        }
        if (requestCount === 2) {
          // The second request (focus/drawer)
          return new Promise<void>((resolve) => {
            resolveSecondRequest = (body) => {
              respond(body);
              resolve();
            };
          });
        }
        return respond({ cashiers: [] });
      }
      return respond({});
    });

    // 1. Go to product lookup. The mount effect should trigger request 1.
    await page.goto("/product-lookup");
    
    // Wait until the first request has been intercepted
    await expect.poll(() => typeof resolveFirstRequest === 'function').toBeTruthy();

    // 2. Open the draft drawer to trigger the visibility/focus listener
    await page.click('button:has-text("Review draft")');

    // Wait until the second request has been intercepted
    await expect.poll(() => typeof resolveSecondRequest === 'function').toBeTruthy();

    // 3. Resolve out of order
    // Resolve second request first
    resolveSecondRequest!({ cashiers: [{ id: "c2", name: "Cashier 2", isActive: true }] });
    
    // Verify it applied the second response (wait for the text to appear in the visible modal)
    await expect(page.locator(".app-modal-layer").getByText("Cashier 2").first()).toBeVisible();

    // Now resolve the first (slower, older) request
    resolveFirstRequest!({ cashiers: [{ id: "c1", name: "Cashier 1", isActive: true }] });

    // Verify the UI didn't downgrade to Cashier 1
    // A small wait to ensure React renders if it was going to
    await page.waitForTimeout(500);
    await expect(page.locator(".app-modal-layer").getByText("Cashier 2").first()).toBeVisible();
    await expect(page.locator(".app-modal-layer").getByText("Cashier 1")).toHaveCount(0);
  });
});
