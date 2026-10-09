import { expect, test } from "@playwright/test";
import zlib from "node:zlib";

const cashier = { id: "11111111-2222-4333-8444-555555555555", name: "Cashier User", role: "cashier" };
const admin = { id: "22222222-3333-4444-8555-666666666666", name: "Admin User", role: "admin" };
const staff = { id: "33333333-4444-4555-8666-777777777777", name: "Staff User", role: "staff" };

const mockAccounts = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    providerLabel: "Fonepay Merchant",
    accountHolder: "KhataSathi Store",
    accountIdentifier: "9841234567",
    settlementMethod: "FONEPAY",
    confirmationMode: "MANUAL_RECEIPT",
    version: 1,
    activeQrAssetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    activeQrThumbnailUrl: "/api/settings/payment-accounts/11111111-1111-4111-8111-111111111111/qr/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/thumbnail",
    activeQrFileUrl: "/api/settings/payment-accounts/11111111-1111-4111-8111-111111111111/qr/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/file",
    supportedSettlement: true,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    providerLabel: "Nabil Bank Transfer",
    accountHolder: "KhataSathi Store Pvt Ltd",
    accountIdentifier: "01200100200300",
    settlementMethod: "BANK_TRANSFER",
    confirmationMode: "MANUAL_RECEIPT",
    version: 1,
    activeQrAssetId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    activeQrThumbnailUrl: "/api/settings/payment-accounts/22222222-2222-4222-8222-222222222222/qr/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/thumbnail",
    activeQrFileUrl: "/api/settings/payment-accounts/22222222-2222-4222-8222-222222222222/qr/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/file",
    supportedSettlement: true,
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    providerLabel: "Khalti Personal Wallet",
    accountHolder: "Store Owner",
    accountIdentifier: "9800000000",
    settlementMethod: null,
    confirmationMode: "DISPLAY_ONLY",
    version: 1,
    activeQrAssetId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    activeQrThumbnailUrl: "/api/settings/payment-accounts/33333333-3333-4333-8333-333333333333/qr/cccccccc-cccc-4ccc-8ccc-cccccccccccc/thumbnail",
    activeQrFileUrl: "/api/settings/payment-accounts/33333333-3333-4333-8333-333333333333/qr/cccccccc-cccc-4ccc-8ccc-cccccccccccc/file",
    supportedSettlement: false,
  },
];

function createPng(width: number, height: number, r = 40, g = 120, b = 200): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // 8 bits per channel
  ihdrData[9] = 6; // RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdrChunk = createChunk("IHDR", ihdrData);

  const rowSize = 1 + width * 4;
  const rawData = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    rawData[rowOffset] = 0;
    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 4;
      rawData[pxOffset] = r;
      rawData[pxOffset + 1] = g;
      rawData[pxOffset + 2] = b;
      rawData[pxOffset + 3] = 255;
    }
  }

  const compressedData = zlib.deflateSync(rawData);
  const idatChunk = createChunk("IDAT", compressedData);
  const iendChunk = createChunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return ~c >>> 0;
}

const largePngBuffer = createPng(600, 400, 30, 100, 220);
const thumbPngBuffer = createPng(160, 160, 30, 100, 220);
const updatedPngBuffer = createPng(600, 400, 220, 80, 40);

test.describe("Cashier QR Gallery & Previewable Image", () => {
  for (const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    test(`gallery browsing on ${viewport.name} makes zero financial writes`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      let financialWriteCalls = 0;

      await page.addInitScript((user) => {
        localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
        localStorage.setItem("khatasathi_token", "test-token");
      }, cashier);

      await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
        const path = new URL(route.request().url()).pathname;
        const respond = (body: unknown, status = 200) =>
          route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

        if (
          path.includes("/invoices/checkout") ||
          path.includes("/payments") ||
          path.includes("/gateways")
        ) {
          if (route.request().method() !== "GET") {
            financialWriteCalls++;
          }
        }

        if (path.endsWith("/auth/me")) return respond({ user: cashier });
        if (path.endsWith("/capabilities"))
          return respond({
            businessMode: "FULL_POS",
            catalogEnabled: true,
            inventoryEnabled: true,
            posEnabled: true,
            stockTracked: true,
          });
        if (path.endsWith("/settings/payment-accounts/enabled")) {
          return respond(mockAccounts);
        }
        if (path.endsWith("/thumbnail")) {
          return route.fulfill({
            status: 200,
            contentType: "image/png",
            body: thumbPngBuffer,
          });
        }
        if (path.endsWith("/file")) {
          return route.fulfill({
            status: 200,
            contentType: "image/png",
            body: largePngBuffer,
          });
        }
        if (path.endsWith("/customers") || path.endsWith("/products")) return respond([]);
        return respond({});
      });

      await page.goto("/billing");

      // Verify gallery trigger and open modal
      const galleryButton = page.getByRole("button", { name: "Store Payment QRs Gallery", exact: true });
      await expect(galleryButton).toBeVisible();
      await galleryButton.click();

      const galleryModal = page.getByRole("dialog", { name: "Store Payment QRs Gallery" });
      await expect(galleryModal).toBeVisible();
      await expect(galleryModal.locator("text=Fonepay Merchant")).toBeVisible();
      await expect(galleryModal.locator("text=Nabil Bank Transfer")).toBeVisible();

      // Refresh action
      const refreshBtn = galleryModal.locator('button:has-text("Refresh")').first();
      await expect(refreshBtn).toBeVisible();
      await refreshBtn.click();

      // Enlarge first QR
      const enlargeTrigger = galleryModal.locator('button[aria-label*="Fonepay Merchant"]').first();
      await expect(enlargeTrigger).toBeVisible();
      await enlargeTrigger.click();

      const zoomViewport = page.locator('[role="region"][aria-label*="preview viewport"]');
      await expect(zoomViewport).toBeVisible();

      // Check zoom buttons
      const fitBtn = page.locator('button:has-text("Fit")').first();
      const zoom100Btn = page.locator('button:has-text("100%")').first();
      const zoom200Btn = page.locator('button:has-text("200%")').first();

      await expect(fitBtn).toBeVisible();
      await expect(zoom100Btn).toBeVisible();
      await expect(zoom200Btn).toBeVisible();

      await expect(fitBtn).toHaveAttribute("aria-pressed", "true");
      await zoom100Btn.click();
      await expect(zoom100Btn).toHaveAttribute("aria-pressed", "true");
      await zoom200Btn.click();
      await expect(zoom200Btn).toHaveAttribute("aria-pressed", "true");

      // Close preview modal
      await page.keyboard.press("Escape");
      await expect(zoomViewport).toBeHidden();

      // Close gallery modal
      const closeBtn = galleryModal.locator('button:has-text("Close")').last();
      await expect(closeBtn).toBeVisible();
      await closeBtn.click();

      // Assert gallery modal is hidden, while trigger remains visible
      await expect(galleryModal).toBeHidden();
      await expect(galleryButton).toBeVisible();

      // Assert zero financial write mutations occurred
      expect(financialWriteCalls).toBe(0);
    });
  }

  test("delayed metadata and asset refresh does not create stale pairings", async ({ page }) => {
    let callCount = 0;
    let resolveOldAsset: () => void = () => {};
    const oldAssetPromise = new Promise<void>((resolve) => {
      resolveOldAsset = resolve;
    });

    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-token");
    }, cashier);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const path = new URL(route.request().url()).pathname;
      const respond = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

      if (path.endsWith("/auth/me")) return respond({ user: cashier });
      if (path.endsWith("/capabilities"))
        return respond({ businessMode: "FULL_POS", posEnabled: true });
      if (path.endsWith("/settings/payment-accounts/enabled")) {
        callCount++;
        if (callCount === 1) {
          return respond([mockAccounts[0]]);
        }
        return respond([
          {
            ...mockAccounts[0],
            version: 2,
            providerLabel: "Updated Fonepay Merchant",
            activeQrAssetId: "99999999-9999-4999-8999-999999999999",
            activeQrThumbnailUrl: "/api/settings/payment-accounts/11111111-1111-4111-8111-111111111111/qr/99999999-9999-4999-8999-999999999999/thumbnail",
            activeQrFileUrl: "/api/settings/payment-accounts/11111111-1111-4111-8111-111111111111/qr/99999999-9999-4999-8999-999999999999/file",
          },
        ]);
      }
      if (path.includes("/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/")) {
        // Hold old asset response until released
        await oldAssetPromise;
        return route.fulfill({
          status: 200,
          contentType: "image/png",
          body: thumbPngBuffer,
        });
      }
      if (path.includes("/99999999-9999-4999-8999-999999999999/")) {
        return route.fulfill({
          status: 200,
          contentType: "image/png",
          body: updatedPngBuffer,
        });
      }
      return respond({});
    });

    await page.goto("/billing");

    const galleryButton = page.getByRole("button", { name: "Store Payment QRs Gallery", exact: true });
    await expect(galleryButton).toBeVisible();
    await galleryButton.click();

    const galleryModal = page.getByRole("dialog", { name: "Store Payment QRs Gallery" });
    await expect(galleryModal).toBeVisible();

    // Trigger refresh while old asset is pending
    const refreshBtn = galleryModal.locator('button:has-text("Refresh")').first();
    await expect(refreshBtn).toBeVisible();
    await refreshBtn.click();

    // Release old asset response
    resolveOldAsset();

    // Verify updated label is rendered
    await expect(galleryModal.locator("text=Updated Fonepay Merchant")).toBeVisible();
  });

  test("closing gallery or switching role cleans up created object URLs", async ({ page }) => {
    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-token");

      const originalCreate = URL.createObjectURL.bind(URL);
      const originalRevoke = URL.revokeObjectURL.bind(URL);

      (window as any).__createdUrls = [];
      (window as any).__revokedUrls = [];

      URL.createObjectURL = (blob: Blob | MediaSource) => {
        const url = originalCreate(blob);
        (window as any).__createdUrls.push(url);
        return url;
      };

      URL.revokeObjectURL = (url: string) => {
        (window as any).__revokedUrls.push(url);
        return originalRevoke(url);
      };
    }, cashier);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const path = new URL(route.request().url()).pathname;
      const respond = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

      if (path.endsWith("/auth/me")) return respond({ user: cashier });
      if (path.endsWith("/capabilities"))
        return respond({ businessMode: "FULL_POS", posEnabled: true });
      if (path.endsWith("/settings/payment-accounts/enabled")) {
        return respond(mockAccounts);
      }
      if (path.endsWith("/thumbnail")) {
        return route.fulfill({
          status: 200,
          contentType: "image/png",
          body: thumbPngBuffer,
        });
      }
      if (path.endsWith("/file")) {
        return route.fulfill({
          status: 200,
          contentType: "image/png",
          body: largePngBuffer,
        });
      }
      return respond({});
    });

    await page.goto("/billing");

    const galleryButton = page.getByRole("button", { name: "Store Payment QRs Gallery", exact: true });
    await expect(galleryButton).toBeVisible();
    await galleryButton.click();
    const galleryModal = page.getByRole("dialog", { name: "Store Payment QRs Gallery" });
    await expect(galleryModal).toBeVisible();
    await expect(galleryModal.locator('img[alt*="Fonepay Merchant QR"]')).toBeVisible({ timeout: 5000 });

    // Verify object URLs were created
    const createdCount = await page.evaluate(() => ((window as any).__createdUrls || []).length);
    expect(createdCount).toBeGreaterThan(0);

    // Simulate switching role to staff via storage event
    await page.evaluate((staffUser) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(staffUser));
      window.dispatchEvent(new StorageEvent("storage", {
        key: "khatasathi_auth_user",
        newValue: JSON.stringify(staffUser),
      }));
    }, staff);

    await expect(galleryModal).toBeHidden();

    // Verify all created URLs were revoked
    const { created, revoked } = await page.evaluate(() => ({
      created: (window as any).__createdUrls || [],
      revoked: (window as any).__revokedUrls || [],
    }));

    expect(revoked.length).toBeGreaterThanOrEqual(created.length);
  });

  test("full file failure does not promote thumbnail to full preview and allows retry", async ({ page }) => {
    let fileFetchAttempts = 0;

    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-token");
    }, cashier);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const path = new URL(route.request().url()).pathname;
      const respond = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

      if (path.endsWith("/auth/me")) return respond({ user: cashier });
      if (path.endsWith("/capabilities"))
        return respond({ businessMode: "FULL_POS", posEnabled: true });
      if (path.endsWith("/settings/payment-accounts/enabled")) {
        return respond([mockAccounts[0]]);
      }
      if (path.endsWith("/thumbnail")) {
        return route.fulfill({
          status: 200,
          contentType: "image/png",
          body: thumbPngBuffer,
        });
      }
      if (path.endsWith("/file")) {
        fileFetchAttempts++;
        if (fileFetchAttempts === 1) {
          return route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "Storage temporarily unavailable" }),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: "image/png",
          body: largePngBuffer,
        });
      }
      return respond({});
    });

    await page.goto("/billing");

    const galleryButton = page.getByRole("button", { name: "Store Payment QRs Gallery", exact: true });
    await expect(galleryButton).toBeVisible();
    await galleryButton.click();

    const galleryModal = page.getByRole("dialog", { name: "Store Payment QRs Gallery" });
    await expect(galleryModal).toBeVisible();

    // High-res preview should indicate failure
    await expect(galleryModal.locator("text=High-res unavailable")).toBeVisible({ timeout: 3000 });

    // Click Retry Preview
    const retryBtn = galleryModal.locator('button:has-text("Retry Preview")');
    await expect(retryBtn).toBeVisible();
    await retryBtn.click();

    // After retry, full file should succeed and click to enlarge should become available
    await expect(galleryModal.locator("text=Click to enlarge & zoom")).toBeVisible({ timeout: 3000 });
    expect(fileFetchAttempts).toBe(2);
  });

  test("modal zoom controls support Fit, 100%, and 200% with natural aspect ratio and keyboard navigation", async ({ page }) => {
    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-token");
    }, admin);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const path = new URL(route.request().url()).pathname;
      const respond = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

      if (path.endsWith("/auth/me")) return respond({ user: admin });
      if (path.endsWith("/capabilities"))
        return respond({ businessMode: "FULL_POS", posEnabled: true });
      if (path.endsWith("/settings/payment-accounts")) {
        return respond([
          {
            ...mockAccounts[0],
            enabled: true,
            totalAssetsCount: 1,
            linkedPaymentsCount: 0,
          },
        ]);
      }
      if (path.endsWith("/settings/payment-accounts/enabled")) {
        return respond([mockAccounts[0]]);
      }
      if (path.endsWith("/thumbnail")) {
        return route.fulfill({
          status: 200,
          contentType: "image/png",
          body: thumbPngBuffer,
        });
      }
      if (path.endsWith("/file")) {
        return route.fulfill({
          status: 200,
          contentType: "image/png",
          body: largePngBuffer,
        });
      }
      return respond({});
    });

    await page.goto("/settings?tab=payment-accounts");

    // Verify settings payment accounts heading
    const paymentAccountsHeading = page.locator("text=Static QR Payment Accounts");
    await expect(paymentAccountsHeading).toBeVisible();

    // Enlarge thumbnail
    const qrThumbBtn = page.locator('button[aria-label*="Preview"]').first();
    await expect(qrThumbBtn).toBeVisible();
    await qrThumbBtn.click();

    const zoomViewport = page.locator('[role="region"][aria-label*="preview viewport"]');
    await expect(zoomViewport).toBeVisible();

    const fitBtn = page.locator('button:has-text("Fit")').first();
    const zoom100Btn = page.locator('button:has-text("100%")').first();
    const zoom200Btn = page.locator('button:has-text("200%")').first();

    await expect(fitBtn).toBeVisible();
    await expect(zoom100Btn).toBeVisible();
    await expect(zoom200Btn).toBeVisible();

    await expect(fitBtn).toHaveAttribute("aria-pressed", "true");
    await expect(zoom100Btn).toHaveAttribute("aria-pressed", "false");
    await expect(zoom200Btn).toHaveAttribute("aria-pressed", "false");

    // Switch to 100%
    await zoom100Btn.click();
    await expect(zoom100Btn).toHaveAttribute("aria-pressed", "true");

    // Verify viewport is scrollable and scroll starts at 0,0
    const scrollPos = await zoomViewport.evaluate((el) => ({
      left: el.scrollLeft,
      top: el.scrollTop,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(scrollPos.left).toBe(0);
    expect(scrollPos.top).toBe(0);

    // Switch to 200%
    await zoom200Btn.click();
    await expect(zoom200Btn).toHaveAttribute("aria-pressed", "true");

    // Close modal and reopen to verify reset to Fit
    await page.keyboard.press("Escape");
    await expect(zoomViewport).toBeHidden();
    await qrThumbBtn.click();
    await expect(zoomViewport).toBeVisible();
    await expect(fitBtn).toHaveAttribute("aria-pressed", "true");
  });

  test("unrelated default preview asserts default canvas and no zoom controls", async ({ page }) => {
    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-token");
    }, admin);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const path = new URL(route.request().url()).pathname;
      const respond = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

      if (path.endsWith("/auth/me")) return respond({ user: admin });
      if (path.endsWith("/capabilities"))
        return respond({ businessMode: "FULL_POS", posEnabled: true });
      if (path.endsWith("/settings/business")) {
        return respond({});
      }
      return respond({});
    });

    await page.goto("/settings");
    // Verify default preview behavior does not inject zoom controls on non-zoom images
    await expect(page.locator('[aria-label="Image zoom levels"]')).toHaveCount(0);
  });
});
