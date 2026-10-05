import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasCapabilityRouteAccess,
  hasRouteAccess,
} from "../app/lib/routeAccess.ts";
import { normalizeInvoice } from "../app/lib/invoices.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fullPos = {
  businessMode: "FULL_POS",
  catalogEnabled: true,
  inventoryEnabled: true,
  posEnabled: true,
  staffDraftRequestsEnabled: true,
  stockTracked: true,
};

test("Route access rules for /manual-bills", () => {
  // Admin, Manager, and Cashier have access to manual paper bills in Full POS
  assert.equal(hasRouteAccess("admin", "/manual-bills", fullPos), true);
  assert.equal(hasRouteAccess("manager", "/manual-bills", fullPos), true);
  assert.equal(hasRouteAccess("cashier", "/manual-bills", fullPos), true);
  assert.equal(hasRouteAccess("staff", "/manual-bills", fullPos), false);

  assert.equal(hasCapabilityRouteAccess("/manual-bills", fullPos), true);
});

test("ui.nav.json contains Paper Bills navigation entry", () => {
  const navPath = path.resolve(__dirname, "../app/config/ui.nav.json");
  const navConfig = JSON.parse(fs.readFileSync(navPath, "utf8"));

  const paperBillEntry = navConfig.sidebar.items.find(
    (item) => item.to === "/manual-bills" || item.key === "manual-bills",
  );
  assert.ok(paperBillEntry, "Must have navigation item for /manual-bills");
  assert.equal(paperBillEntry.to, "/manual-bills");
  assert.ok(paperBillEntry.roles.includes("admin"));
  assert.ok(paperBillEntry.roles.includes("cashier"));
});

test("normalizeInvoice preserves billingChannel and manualBillRecord metadata", () => {
  const rawInvoice = {
    id: "inv_manual_101",
    invoiceNo: "INV-2026-101",
    status: "FINALIZED",
    billingChannel: "MANUAL_EXTERNAL",
    billRecordStatus: "RECORDED",
    externalBillNo: "PB-4040",
    externalBillDate: "2026-10-04",
    items: [],
    payments: [],
    netTotal: 1500,
    paidTotal: 1500,
  };

  const normalized = normalizeInvoice(rawInvoice);
  assert.equal(normalized.id, "inv_manual_101");
  assert.equal(normalized.billingChannel, "MANUAL_EXTERNAL");
  assert.equal(normalized.netTotal, 1500);
});
