import { expect, test } from "@playwright/test";
import zlib from "node:zlib";

const admin = { id: "22222222-3333-4444-8555-666666666666", name: "Admin User", role: "admin" };
const cashier = { id: "11111111-2222-4333-8444-555555555555", name: "Cashier User", role: "cashier" };
const staff = { id: "33333333-4444-4555-8666-777777777777", name: "Staff User", role: "staff" };

const initialMockAccounts = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    providerLabel: "Fonepay Merchant",
    accountHolder: "KhataSathi Store",
    accountIdentifier: "9841234567",
    settlementMethod: "FONEPAY",
    confirmationMode: "MANUAL_RECEIPT",
    enabled: true,
    sortOrder: 0,
    version: 1,
    activeQrAssetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    activeQrAsset: {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      width: 600,
      height: 600,
      sizeBytes: 15420,
      thumbnailSizeBytes: 3200,
      mimeType: "image/png",
      checksum: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      createdAt: "2026-10-07T12:00:00.000Z",
    },
    createdById: "22222222-3333-4444-8555-666666666666",
    updatedById: "22222222-3333-4444-8555-666666666666",
    createdAt: "2026-10-07T12:00:00.000Z",
    updatedAt: "2026-10-07T12:00:00.000Z",
    totalAssetsCount: 1,
    linkedPaymentsCount: 0,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    providerLabel: "Nabil Bank Transfer",
    accountHolder: "KhataSathi Store Pvt Ltd",
    accountIdentifier: "01200100200300",
    settlementMethod: "BANK_TRANSFER",
    confirmationMode: "MANUAL_RECEIPT",
    enabled: false,
    sortOrder: 1,
    version: 1,
    activeQrAssetId: null,
    activeQrAsset: null,
    createdById: "22222222-3333-4444-8555-666666666666",
    updatedById: "22222222-3333-4444-8555-666666666666",
    createdAt: "2026-10-07T12:00:00.000Z",
    updatedAt: "2026-10-07T12:00:00.000Z",
    totalAssetsCount: 0,
    linkedPaymentsCount: 0,
  },
];

function createPng(width: number, height: number, r = 40, g = 120, b = 200): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
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

const thumbPngBuffer = createPng(160, 160, 30, 100, 220);
const largePngBuffer = createPng(600, 400, 30, 100, 220);

test.describe("Static QR Payment Accounts Settings", () => {
  test("lost-response create retries identical UUID and body without minting new UUID", async ({ page }) => {
    const createPayloads: any[] = [];
    let accountsList = [...initialMockAccounts];

    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-token");
    }, admin);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      const respond = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

      if (path.endsWith("/auth/me")) return respond({ user: admin });
      if (path.endsWith("/capabilities"))
        return respond({ businessMode: "FULL_POS", posEnabled: true });

      if (path.endsWith("/settings/payment-accounts") && method === "GET") {
        return respond(accountsList);
      }

      if (path.endsWith("/settings/payment-accounts") && method === "POST") {
        const payload = route.request().postDataJSON();
        createPayloads.push(payload);

        if (createPayloads.length === 1) {
          // Simulate 500 network/server timeout on first attempt
          return route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "Temporary server error" }),
          });
        }

        // Second attempt succeeds
        const newAcc = {
          ...payload,
          enabled: false,
          sortOrder: accountsList.length,
          version: 1,
          activeQrAssetId: null,
          createdById: admin.id,
          updatedById: admin.id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          totalAssetsCount: 0,
          linkedPaymentsCount: 0,
        };
        accountsList.push(newAcc);
        return respond(newAcc, 201);
      }

      if (path.endsWith("/thumbnail")) {
        return route.fulfill({ status: 200, contentType: "image/png", body: thumbPngBuffer });
      }

      return respond({});
    });

    await page.goto("/settings?tab=payment-accounts");

    // Click Add Payment Account
    await page.locator('button:has-text("Add Payment Account")').click();

    // Fill form
    await page.locator('input[placeholder*="Fonepay QR"]').fill("Global IME Merchant");
    await page.locator('input[placeholder*="KhataSathi Store"]').fill("KhataSathi Store Pvt Ltd");
    await page.locator('input[placeholder*="Merchant ID"]').fill("9801122334");

    // Submit first attempt (will fail 500)
    await page.locator('button:has-text("Save Account")').click();

    // Verify error and frozen attempt message
    await expect(page.locator('[role="dialog"]').locator("text=Creation outcome uncertain")).toBeVisible({ timeout: 4000 });
    await expect(page.locator('[role="dialog"]').locator("text=Pending submission frozen")).toBeVisible();

    // Retry exact creation
    const retryBtn = page.locator('button:has-text("Retry Exact Creation")');
    await expect(retryBtn).toBeVisible();
    await retryBtn.click();

    // Modal closes on success
    await expect(page.locator("text=Global IME Merchant")).toBeVisible({ timeout: 4000 });

    // Verify exactly 2 requests were made and their UUID and payload are strictly identical
    expect(createPayloads.length).toBe(2);
    expect(createPayloads[0].id).toBeDefined();
    expect(createPayloads[1].id).toBe(createPayloads[0].id);
    expect(createPayloads[1].providerLabel).toBe(createPayloads[0].providerLabel);
    expect(createPayloads[1].accountHolder).toBe(createPayloads[0].accountHolder);
    expect(createPayloads[1].accountIdentifier).toBe(createPayloads[0].accountIdentifier);
  });

  test("definite 409 conflict requires explicit re-review without silent overwrite", async ({ page }) => {
    let accountsList = [...initialMockAccounts];

    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-token");
    }, admin);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      const respond = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

      if (path.endsWith("/auth/me")) return respond({ user: admin });
      if (path.endsWith("/capabilities"))
        return respond({ businessMode: "FULL_POS", posEnabled: true });

      if (path.endsWith("/settings/payment-accounts") && method === "GET") {
        return respond(accountsList);
      }

      if (path.endsWith("/settings/payment-accounts") && method === "POST") {
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "Account ID collision or conflicting settings version" }),
        });
      }

      if (path.endsWith("/thumbnail")) {
        return route.fulfill({ status: 200, contentType: "image/png", body: thumbPngBuffer });
      }

      return respond({});
    });

    await page.goto("/settings?tab=payment-accounts");
    await page.locator('button:has-text("Add Payment Account")').click();

    await page.locator('input[placeholder*="Fonepay QR"]').fill("Colliding Account");
    await page.locator('input[placeholder*="KhataSathi Store"]').fill("Store Holder");

    await page.locator('button:has-text("Save Account")').click();

    // Verify conflict message and explicit review button
    await expect(page.locator('[role="dialog"]').locator("text=Conflict: Account ID collision")).toBeVisible({ timeout: 4000 });
    await expect(page.locator('[role="dialog"]').locator('button:has-text("Create with New ID")')).toBeVisible();
  });

  test("lost-response upload retries identical uploadId and expectedVersion", async ({ page }) => {
    const uploadRequests: { uploadId: string; expectedVersion: string }[] = [];

    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-token");
    }, admin);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      const respond = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

      if (path.endsWith("/auth/me")) return respond({ user: admin });
      if (path.endsWith("/capabilities"))
        return respond({ businessMode: "FULL_POS", posEnabled: true });

      if (path.endsWith("/settings/payment-accounts") && method === "GET") {
        return respond(initialMockAccounts);
      }

      if (path.includes("/qr") && method === "POST") {
        // Parse multipart form
        const postData = route.request().postData() || "";
        const uploadIdMatch = postData.match(/name="uploadId"\r\n\r\n([^\r\n]+)/);
        const versionMatch = postData.match(/name="expectedVersion"\r\n\r\n([^\r\n]+)/);

        uploadRequests.push({
          uploadId: uploadIdMatch?.[1] || "",
          expectedVersion: versionMatch?.[1] || "",
        });

        if (uploadRequests.length === 1) {
          return route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "Storage node busy" }),
          });
        }

        return respond({
          id: uploadRequests[0].uploadId,
          accountId: initialMockAccounts[1].id,
          publicationExpectedVersion: 1,
          fileName: "qr.png",
          thumbnailFileName: "qr-thumb.png",
          mimeType: "image/png",
          sizeBytes: 2000,
          thumbnailSizeBytes: 500,
          width: 400,
          height: 400,
          checksum: "dummychecksum",
          sourceChecksum: "dummysourcechecksum",
          createdById: admin.id,
          createdAt: new Date().toISOString(),
        });
      }

      if (path.endsWith("/thumbnail")) {
        return route.fulfill({ status: 200, contentType: "image/png", body: thumbPngBuffer });
      }

      return respond({});
    });

    await page.goto("/settings?tab=payment-accounts");

    // Click Upload QR on the second account
    const uploadBtns = page.locator('button:has-text("Upload QR")');
    await uploadBtns.first().click();

    // Attach sample image
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: "sample-qr.png",
      mimeType: "image/png",
      buffer: thumbPngBuffer,
    });

    // Submit first time (will fail 503)
    await page.locator('button:has-text("Publish QR")').click();

    // Verify error and frozen attempt message inside dialog
    const modal = page.locator('[role="dialog"]');
    await expect(modal.locator("text=Upload outcome uncertain")).toBeVisible({ timeout: 4000 });
    await expect(modal.locator("text=Pending upload attempt frozen")).toBeVisible();

    // Retry exact upload
    const retryBtn = modal.locator('button:has-text("Retry Exact Upload")');
    await expect(retryBtn).toBeVisible();
    await retryBtn.click();

    // Modal closes on success
    await expect(retryBtn).not.toBeVisible({ timeout: 4000 });

    expect(uploadRequests.length).toBe(2);
    expect(uploadRequests[0].uploadId.length).toBeGreaterThan(10);
    expect(uploadRequests[1].uploadId).toBe(uploadRequests[0].uploadId);
    expect(uploadRequests[1].expectedVersion).toBe(uploadRequests[0].expectedVersion);
  });

  test("non-admin role renders access denied and prevents API requests", async ({ page }) => {
    let adminApiCalled = false;

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

      if (path.endsWith("/settings/payment-accounts")) {
        adminApiCalled = true;
        return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "Forbidden" }) });
      }

      return respond({});
    });

    await page.goto("/settings?tab=payment-accounts");

    await expect(page).toHaveURL(/\/billing/);
    expect(adminApiCalled).toBe(false);
  });

  test("role change revokes all created blob URLs and clears state", async ({ page }) => {
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
    }, admin);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const path = new URL(route.request().url()).pathname;
      const respond = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

      if (path.endsWith("/auth/me")) return respond({ user: admin });
      if (path.endsWith("/capabilities"))
        return respond({ businessMode: "FULL_POS", posEnabled: true });

      if (path.endsWith("/settings/payment-accounts")) {
        return respond(initialMockAccounts);
      }

      if (path.endsWith("/thumbnail")) {
        return route.fulfill({ status: 200, contentType: "image/png", body: thumbPngBuffer });
      }

      return respond({});
    });

    await page.goto("/settings?tab=payment-accounts");
    await page.waitForTimeout(500);

    const createdCount = await page.evaluate(() => ((window as any).__createdUrls || []).length);
    expect(createdCount).toBeGreaterThan(0);

    // Switch role to staff via storage event
    await page.evaluate((staffUser) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(staffUser));
      window.dispatchEvent(new StorageEvent("storage", {
        key: "khatasathi_auth_user",
        newValue: JSON.stringify(staffUser),
      }));
    }, staff);

    await page.waitForTimeout(300);

    const { created, revoked } = await page.evaluate(() => ({
      created: (window as any).__createdUrls || [],
      revoked: (window as any).__revokedUrls || [],
    }));

    expect(revoked.length).toBeGreaterThanOrEqual(created.length);
    await expect(page.locator("text=Admin Privileges Required")).toBeVisible();
  });

  test("close and reopen after unknown upload preserves pending attempt tuple and file for retry", async ({ page }) => {
    const uploadRequests: { uploadId: string; expectedVersion: string }[] = [];

    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-token");
    }, admin);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      const respond = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

      if (path.endsWith("/auth/me")) return respond({ user: admin });
      if (path.endsWith("/capabilities"))
        return respond({ businessMode: "FULL_POS", posEnabled: true });

      if (path.endsWith("/settings/payment-accounts") && method === "GET") {
        return respond(initialMockAccounts);
      }

      if (path.includes("/qr") && method === "POST") {
        const postData = route.request().postData() || "";
        const uploadIdMatch = postData.match(/name="uploadId"\r\n\r\n([^\r\n]+)/);
        const versionMatch = postData.match(/name="expectedVersion"\r\n\r\n([^\r\n]+)/);

        uploadRequests.push({
          uploadId: uploadIdMatch?.[1] || "",
          expectedVersion: versionMatch?.[1] || "",
        });

        if (uploadRequests.length === 1) {
          return route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "Storage node busy on first attempt" }),
          });
        }

        return respond({
          id: uploadRequests[0].uploadId,
          accountId: initialMockAccounts[1].id,
          publicationExpectedVersion: 1,
          fileName: "qr.png",
          thumbnailFileName: "qr-thumb.png",
          mimeType: "image/png",
          sizeBytes: 2000,
          thumbnailSizeBytes: 500,
          width: 400,
          height: 400,
          checksum: "dummychecksum",
          sourceChecksum: "dummysourcechecksum",
          createdById: admin.id,
          createdAt: new Date().toISOString(),
        });
      }

      if (path.endsWith("/thumbnail")) {
        return route.fulfill({ status: 200, contentType: "image/png", body: thumbPngBuffer });
      }

      return respond({});
    });

    await page.goto("/settings?tab=payment-accounts");

    // Open upload modal on second account
    const uploadBtns = page.locator('button:has-text("Upload QR")');
    await uploadBtns.first().click();

    // Select file
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: "sample-qr.png",
      mimeType: "image/png",
      buffer: thumbPngBuffer,
    });

    // First attempt fails 503
    await page.locator('button:has-text("Publish QR")').click();
    const modal1 = page.locator('[role="dialog"]');
    await expect(modal1.locator("text=Upload outcome uncertain")).toBeVisible({ timeout: 4000 });
    await expect(modal1.locator("text=Pending upload attempt frozen")).toBeVisible();

    // Close modal via Cancel button
    await modal1.locator('button:has-text("Cancel")').click();
    await expect(page.locator("text=Upload QR Image")).not.toBeVisible();

    // Reopen upload modal on the same account
    await uploadBtns.first().click();

    // Frozen attempt must still be preserved with same upload ID and retry action
    const modal2 = page.locator('[role="dialog"]');
    await expect(modal2.locator("text=Pending upload attempt frozen")).toBeVisible();
    await expect(modal2.locator("text=sample-qr.png")).toBeVisible();

    const retryBtn = modal2.locator('button:has-text("Retry Exact Upload")');
    await expect(retryBtn).toBeVisible();
    await retryBtn.click();

    // Succeeded and modal closed
    await expect(page.locator("text=Upload QR Image")).not.toBeVisible({ timeout: 4000 });
    expect(uploadRequests.length).toBe(2);
    expect(uploadRequests[0].uploadId).toBe(uploadRequests[1].uploadId);
    expect(uploadRequests[0].expectedVersion).toBe(uploadRequests[1].expectedVersion);
  });

  test("conflicting create with matching ID but different payload rejects success and retains conflict error", async ({ page }) => {
    let postCallCount = 0;
    let submittedPayload: any = null;

    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-token");
    }, admin);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      const respond = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

      if (path.endsWith("/auth/me")) return respond({ user: admin });
      if (path.endsWith("/capabilities"))
        return respond({ businessMode: "FULL_POS", posEnabled: true });

      if (path.endsWith("/settings/payment-accounts") && method === "GET") {
        if (!submittedPayload) {
          return respond(initialMockAccounts);
        }
        // Return a conflicting account that has the same ID but different providerLabel
        return respond([
          ...initialMockAccounts,
          {
            id: submittedPayload.id,
            providerLabel: "Different Conflicting Provider",
            accountHolder: "Different Holder",
            accountIdentifier: "99999999",
            settlementMethod: "FONEPAY",
            confirmationMode: "MANUAL_RECEIPT",
            enabled: false,
            sortOrder: 2,
            version: 1,
            activeQrAssetId: null,
            activeQrAsset: null,
            createdById: admin.id,
            updatedById: admin.id,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            totalAssetsCount: 0,
            linkedPaymentsCount: 0,
          },
        ]);
      }

      if (path.endsWith("/settings/payment-accounts") && method === "POST") {
        postCallCount++;
        submittedPayload = route.request().postDataJSON();
        if (postCallCount === 1) {
          // Return 500 uncertain failure on initial submission
          return route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "Timeout on create" }),
          });
        }
        // Second attempt (retry) returns 409 conflict
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "Conflicting account already exists" }),
        });
      }

      if (path.endsWith("/thumbnail")) {
        return route.fulfill({ status: 200, contentType: "image/png", body: thumbPngBuffer });
      }

      return respond({});
    });

    await page.goto("/settings?tab=payment-accounts");
    await page.locator('button:has-text("Add Payment Account")').click();

    const createModal = page.locator('[role="dialog"]');
    await createModal.locator('input[placeholder*="Fonepay QR"]').fill("My New Fonepay");
    await createModal.locator('input[placeholder*="KhataSathi Store"]').fill("Store Holder");

    // First submission attempt fails 500
    await createModal.locator('button:has-text("Save Account")').click();

    // Verify uncertain error inside modal dialog and frozen attempt message
    await expect(createModal.locator("text=Creation outcome uncertain")).toBeVisible({ timeout: 4000 });
    await expect(createModal.locator("text=Pending submission frozen")).toBeVisible();

    // Retry exact creation with same UUID and payload, which returns 409 and triggers loadAccounts
    const retryBtn = createModal.locator('button:has-text("Retry Exact Creation")');
    await expect(retryBtn).toBeVisible();
    await retryBtn.click();

    // Because ID matched but payload differed, modal must NOT close, must NOT acknowledge success, and must show conflict
    await expect(createModal.locator("text=conflicting account with identical ID")).toBeVisible({ timeout: 4000 });
    await expect(createModal.locator('button:has-text("Create with New ID")')).toBeVisible();

    // Verify original input values are retained
    await expect(createModal.locator('input[placeholder*="Fonepay QR"]')).toHaveValue("My New Fonepay");
    await expect(createModal.locator('input[placeholder*="KhataSathi Store"]')).toHaveValue("Store Holder");
  });

  test("delayed in-flight audit request resolving after role change to non-admin does not render audit logs", async ({ page }) => {
    let resolveAuditPromise: (value: any) => void;
    const auditPromise = new Promise((resolve) => {
      resolveAuditPromise = resolve;
    });

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
        return respond(initialMockAccounts);
      }

      if (path.includes("/audit")) {
        const data = await auditPromise;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(data),
        });
      }

      if (path.endsWith("/thumbnail")) {
        return route.fulfill({ status: 200, contentType: "image/png", body: thumbPngBuffer });
      }

      return respond({});
    });

    await page.goto("/settings?tab=payment-accounts");

    // Click View Audit History on first account
    const auditBtns = page.locator('button[aria-label="View Audit History"]');
    await auditBtns.first().click();

    // Verify modal is open and showing loading
    await expect(page.locator("text=Loading audit history…")).toBeVisible({ timeout: 4000 });

    // Switch role to cashier via storage event
    await page.evaluate((cashierUser) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(cashierUser));
      window.dispatchEvent(new StorageEvent("storage", {
        key: "khatasathi_auth_user",
        newValue: JSON.stringify(cashierUser),
      }));
    }, cashier);

    // Resolve the delayed audit request with sensitive audit logs
    resolveAuditPromise!([
      {
        id: "audit-secret-log-1",
        accountId: initialMockAccounts[0].id,
        action: "PAYMENT_ACCOUNT_CREATED",
        actorId: admin.id,
        actor: { id: admin.id, name: "Admin", role: "admin" },
        meta: { secretConfig: "sensitive-account-data" },
        createdAt: new Date().toISOString(),
      },
    ]);

    await page.waitForTimeout(300);

    // Verify that audit log was dropped and page renders Access Denied
    await expect(page.locator("text=Admin Privileges Required")).toBeVisible();
    await expect(page.locator("text=sensitive-account-data")).not.toBeVisible();
    await expect(page.locator("text=audit-secret-log-1")).not.toBeVisible();
  });

  test("replaced-current-pointer replay acknowledges original upload but informs user current QR differs", async ({ page }) => {
    let uploadCount = 0;
    const oldAssetId = "33333333-3333-4333-8333-333333333333";
    const currentActiveAssetId = "44444444-4444-4444-8444-444444444444";

    await page.addInitScript((user) => {
      localStorage.setItem("khatasathi_auth_user", JSON.stringify(user));
      localStorage.setItem("khatasathi_token", "test-token");
    }, admin);

    await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      const respond = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

      if (path.endsWith("/auth/me")) return respond({ user: admin });
      if (path.endsWith("/capabilities"))
        return respond({ businessMode: "FULL_POS", posEnabled: true });

      if (path.endsWith("/settings/payment-accounts") && method === "GET") {
        if (uploadCount === 0) {
          return respond(initialMockAccounts);
        }
        // Account now has currentActiveAssetId as its activeQrAssetId
        return respond([
          {
            ...initialMockAccounts[0],
            version: 3,
            activeQrAssetId: currentActiveAssetId,
            activeQrAsset: {
              id: currentActiveAssetId,
              width: 600,
              height: 600,
              sizeBytes: 15420,
              thumbnailSizeBytes: 3200,
              mimeType: "image/png",
              checksum: "dummynew",
              createdAt: new Date().toISOString(),
            },
          },
          initialMockAccounts[1],
        ]);
      }

      if (path.includes("/qr") && method === "POST") {
        uploadCount++;
        // Returns the old asset that was replayed
        return respond({
          id: oldAssetId,
          accountId: initialMockAccounts[0].id,
          publicationExpectedVersion: 1,
          fileName: "qr.png",
          thumbnailFileName: "qr-thumb.png",
          mimeType: "image/png",
          sizeBytes: 2000,
          thumbnailSizeBytes: 500,
          width: 400,
          height: 400,
          checksum: "dummyold",
          sourceChecksum: "dummysourceold",
          createdById: admin.id,
          createdAt: new Date().toISOString(),
        });
      }

      if (path.endsWith("/thumbnail")) {
        return route.fulfill({ status: 200, contentType: "image/png", body: thumbPngBuffer });
      }

      return respond({});
    });

    await page.goto("/settings?tab=payment-accounts");

    // Click Replace QR on first account
    const uploadBtns = page.locator('button:has-text("Replace QR")');
    await uploadBtns.first().click();

    // Select file and publish
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: "old-qr.png",
      mimeType: "image/png",
      buffer: thumbPngBuffer,
    });

    await page.locator('button:has-text("Publish QR")').click();

    // Verify info toast indicating original QR was acknowledged, but current active QR differs
    await expect(
      page.locator("text=Original QR upload was acknowledged by the server, but current active QR differs"),
    ).toBeVisible({ timeout: 4000 });
  });
});
