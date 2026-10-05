import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "crypto";
import prisma from "../db/prisma";

function hashOverrideToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

const storage = fs.mkdtempSync(path.join(os.tmpdir(), "ks-recovery-tx-"));
process.env.DOCUMENT_STORAGE_ROOT = storage;
after(() => fs.rmSync(storage, { recursive: true, force: true }));

const {
  getSaleEvidenceRecoveryOutcome,
  prepareAndPostSaleEvidenceRecovery,
  reviseSaleEvidenceRecoveryAttempt,
} = require("../modules/salesEvidence/recovery") as typeof import("../modules/salesEvidence/recovery");
const {
  attachSaleEvidence,
  archiveSaleEvidence,
} = require("../modules/salesEvidence/service") as typeof import("../modules/salesEvidence/service");
const {
  closeCashDrawer,
  getCurrentCashDrawer,
  openCashDrawer,
} = require("../modules/cash-drawers/service") as typeof import("../modules/cash-drawers/service");

const managerActor = { id: "mgr-1", name: "Manager One", role: "MANAGER" as const };
const managerTwoActor = { id: "mgr-2", name: "Manager Two", role: "MANAGER" as const };
const capabilities = async () => ({
  businessMode: "FULL_POS" as const,
  catalogEnabled: true as const,
  inventoryEnabled: true,
  posEnabled: true,
  staffDraftRequestsEnabled: true,
  stockTracked: true,
});

function matches(row: any, where: any): boolean {
  return (
    !!row &&
    Object.entries(where || {}).every(([key, value]: any) => {
      if (value && typeof value === "object" && !(value instanceof Date)) {
        if ("in" in value) return value.in.includes(row[key]);
        if ("not" in value) return row[key] !== value.not;
      }
      return row[key] instanceof Date && value instanceof Date
        ? row[key].getTime() === value.getTime()
        : row[key] === value;
    })
  );
}

function parseLockTarget(queryStr: string, values: any[]): string | null {
  const q = queryStr.toUpperCase();
  if (!q.includes("FOR UPDATE")) return null;

  const docMatch = queryStr.match(/FROM\s+Document\s+WHERE\s+id\s*=\s*(?:'([^']+)'|\$?\d*|\?)/i);
  if (docMatch) {
    const id = docMatch[1] || values[0];
    return `Document:${id}`;
  }

  const drawerMatch = queryStr.match(/FROM\s+CashDrawer\s+WHERE\s+id\s*=\s*(?:'([^']+)'|\$?\d*|\?)/i);
  if (drawerMatch) {
    const id = drawerMatch[1] || values[0];
    return `CashDrawer:${id}`;
  }

  const prodMatch = queryStr.match(/FROM\s+Product\s+WHERE\s+id\s*=\s*(?:'([^']+)'|\$?\d*|\?)/i);
  if (prodMatch) {
    const id = prodMatch[1] || values[0];
    return `Product:${id}`;
  }

  const userMatch = queryStr.match(/FROM\s+User\s+WHERE\s+id\s*=\s*(?:'([^']+)'|\$?\d*|\?)/i);
  if (userMatch) {
    const id = userMatch[1] || values[0];
    return `User:${id}`;
  }

  const invMatch = queryStr.match(/FROM\s+Invoice\s+WHERE\s+id\s*=\s*(?:'([^']+)'|\$?\d*|\?)/i);
  if (invMatch) {
    const id = invMatch[1] || values[0];
    return `Invoice:${id}`;
  }

  return `GenericLock:${queryStr.substring(0, 30)}`;
}

export function createFixture(options: {
  failClaim?: boolean;
  failAudit?: boolean;
  failPostingAudit?: boolean;
  failResponseUpdate?: boolean;
  failPayment?: boolean;
  failOverrideAuthorization?: boolean;
  failPostingAfterCommit?: boolean;
  failDuringFinalization?: boolean;
  corruptAuditReconciliation?: boolean;
  unavailablePostingAuditReconciliation?: boolean;
  contradictoryAuditReconciliation?: boolean;
  onBeforeCommit?: (txData: { txId: string; local: any }) => Promise<void>;
  onAfterLock?: (resourceKey: string, txId: string) => Promise<void>;
  onLockWait?: (resourceKey: string, txId: string) => Promise<void> | void;
} = {}) {
  fs.mkdirSync(path.join(storage, "documents"), { recursive: true });
  const file = path.join(storage, "documents", "paper_bill.jpg");
  fs.writeFileSync(file, "mock proof bytes");

  const state: any = {
    rawQueries: [] as Array<{ query: string; values: any[] }>,
    acquiredLocks: [] as Array<{ resource: string; txId: string; timestamp: number }>,
    lockWaiters: [] as Array<{ resource: string; txId: string; timestamp: number }>,
    contendedAcquisitions: [] as Array<{ resource: string; holderTxId: string; waiterTxId: string; timestamp: number }>,
    document: {
      id: "doc-rec-1",
      documentType: "SALE_BILL",
      title: "Physical Bill 001",
      fileName: "paper_bill.jpg",
      storedPath: "documents",
      storedFileName: "paper_bill.jpg",
      fileSize: 100,
      mimeType: "image/jpeg",
      visibility: "ADMIN_MANAGER",
      deletedAt: null,
      saleRecoveryStatus: "UNRESOLVED",
      linkedEntityType: null,
      linkedEntityId: null,
      salesEvidenceInvoiceId: null,
      checkoutOperationId: null,
      recoveryCheckoutOperationKey: null,
      recoveryCheckoutPayloadHash: null,
      recoveryArchiveReason: null,
      recoveryResolvedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      uploadedById: managerActor.id,
      uploadedBy: { id: managerActor.id, name: managerActor.name },
    },
    invoices: {
      "inv-existing-1": {
        id: "inv-existing-1",
        invoiceNo: "INV-2026-REC-000",
        status: "FINALIZED",
        paymentStatus: "PAID",
        paidTotal: 100,
        netTotal: 100,
        subTotal: 100,
        discountTotal: 0,
        billingChannel: "MANUAL_EXTERNAL",
        externalDocumentType: null,
        externalBillNo: null,
        externalBillDate: null,
        billRecordStatus: "PENDING",
        finalizedAt: new Date(),
        cancelledAt: null,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    } as Record<string, any>,
    products: {
      "prod-1": {
        id: "prod-1",
        name: "Test Item A",
        sku: "SKU-A",
        barcode: null,
        retailPrice: 100,
        wholesalePrice: 90,
        wholesaleEligible: false,
        stock: 50,
        reservedStock: 0,
        isActive: true,
      },
    } as Record<string, any>,
    cashiers: {
      [managerActor.id]: { id: managerActor.id, name: managerActor.name, role: "MANAGER", isActive: true },
      [managerTwoActor.id]: { id: managerTwoActor.id, name: managerTwoActor.name, role: "MANAGER", isActive: true },
    },
    cashDrawers: {
      "drawer-1": {
        id: "drawer-1",
        cashierId: managerActor.id,
        status: "OPEN",
        openedAt: new Date(Date.now() - 3600000),
        closedAt: null,
        businessDate: new Date(),
        openingFloat: 1000,
        cashSalesTotal: 0,
        cashInTotal: 0,
        cashOutTotal: 0,
        expectedTotal: 1000,
        actualTotal: null,
        difference: null,
        note: null,
      },
    } as Record<string, any>,
    cashDrawerEvents: [] as any[],
    audits: [] as any[],
    checkoutOperations: {} as Record<string, any>,
    invoiceItems: {} as Record<string, any>,
    payments: {} as Record<string, any>,
    stockTransactions: [] as any[],
    priceOverrideAuthorizations: {} as Record<string, any>,
    invoiceSequences: {
      "20261004": { id: "seq-1", businessDate: "20261004", lastNumber: 1 },
    } as Record<string, any>,
    businessSettings: {
      id: "settings-1",
      vatRate: 0.13,
      panNumber: null,
      businessName: "KhataSathi Store",
      businessAddress: "Kathmandu",
      businessPhone: "9800000000",
    },
  };

  const saved: Array<() => void> = [];
  const replace = (object: any, key: string, value: any) => {
    const original = object[key];
    saved.push(() => {
      object[key] = original;
    });
    object[key] = value;
  };

  // Lock-aware resource locking map
  // Maps resourceKey -> current holder txId and queue of waiters
  const resourceLocks = new Map<
    string,
    {
      holderTxId: string;
      waitQueue: Array<{ txId: string; resolve: () => void }>;
    }
  >();

  async function acquireLock(resourceKey: string, txId: string) {
    state.acquiredLocks.push({ resource: resourceKey, txId, timestamp: Date.now() });

    const existing = resourceLocks.get(resourceKey);
    if (!existing) {
      resourceLocks.set(resourceKey, { holderTxId: txId, waitQueue: [] });
      if (options.onAfterLock) {
        await options.onAfterLock(resourceKey, txId);
      }
      return;
    }

    if (existing.holderTxId === txId) {
      // Reentrant lock by same transaction
      return;
    }

    state.lockWaiters.push({ resource: resourceKey, txId, timestamp: Date.now() });
    state.contendedAcquisitions.push({
      resource: resourceKey,
      holderTxId: existing.holderTxId,
      waiterTxId: txId,
      timestamp: Date.now(),
    });

    if (options.onLockWait) {
      await options.onLockWait(resourceKey, txId);
    }

    // Must wait for lock release
    await new Promise<void>((resolve) => {
      existing.waitQueue.push({ txId, resolve });
    });

    if (options.onAfterLock) {
      await options.onAfterLock(resourceKey, txId);
    }
  }

  function releaseAllLocks(txId: string) {
    for (const [key, lock] of Array.from(resourceLocks.entries())) {
      if (lock.holderTxId === txId) {
        const next = lock.waitQueue.shift();
        if (next) {
          lock.holderTxId = next.txId;
          next.resolve();
        } else {
          resourceLocks.delete(key);
        }
      } else {
        lock.waitQueue = lock.waitQueue.filter((w) => w.txId !== txId);
      }
    }
  }

  let txCounter = 0;

  function client(local?: any, currentTxId?: string) {
    const txId = currentTxId || `tx-${++txCounter}`;
    const getStore = (name: string) => {
      if (local && local[name] !== undefined) return local[name];
      return state[name];
    };

    const getMutStore = (name: string) => {
      if (local) {
        if (local[name] === undefined) {
          local[name] = structuredClone(state[name]);
        }
        return local[name];
      }
      return state[name];
    };

    return {
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const queryStr = typeof strings === "string" ? strings : Array.isArray(strings) ? strings.join("?") : String(strings);
        const queries = local ? (local.rawQueries || (local.rawQueries = [])) : state.rawQueries;
        queries.push({ query: queryStr, values });

        const lockTarget = parseLockTarget(queryStr, values);
        if (lockTarget) {
          await acquireLock(lockTarget, txId);
        }
        return [];
      },
      document: {
        findFirst: async (args: any) => {
          const doc = getStore("document");
          return matches(doc, args.where) ? structuredClone(doc) : null;
        },
        findUnique: async (args: any) => {
          const doc = getStore("document");
          return matches(doc, args.where) ? structuredClone(doc) : null;
        },
        findMany: async (args: any) => {
          const doc = getStore("document");
          return matches(doc, args?.where) ? [structuredClone(doc)] : [];
        },
        updateMany: async ({ where, data }: any) => {
          if (options.failClaim && data.saleRecoveryStatus === "ATTACHED") return { count: 0 };
          const target = getMutStore("document");
          if (!matches(target, where)) return { count: 0 };
          Object.assign(target, data);
          return { count: 1 };
        },
        update: async ({ where, data }: any) => {
          const target = getMutStore("document");
          if (target && target.id === where.id) {
            Object.assign(target, data);
            return structuredClone(target);
          }
          return null;
        },
      },
      auditLog: {
        findFirst: async (args: any) => {
          if (options.corruptAuditReconciliation) {
            throw new Error("Simulated audit query read error");
          }
          if (
            options.unavailablePostingAuditReconciliation &&
            args.where?.action === "SALE_RECOVERY_POSTED"
          ) {
            throw new Error("Simulated posting audit query read error");
          }
          const audits = getStore("audits");
          if (options.contradictoryAuditReconciliation && args.where?.action === "SALE_RECOVERY_POSTED") {
            return {
              id: "audit-contradictory-post",
              actorId: "different-actor-id",
              action: "SALE_RECOVERY_POSTED",
              entityType: "Invoice",
              entityId: "inv-contradictory",
              meta: {
                operationKey: "rec_different_key",
                recoveryFingerprint: "hash_different",
              },
              createdAt: new Date(),
            };
          }
          const filtered = audits.filter((r: any) => matches(r, args.where));
          return filtered[filtered.length - 1] ? structuredClone(filtered[filtered.length - 1]) : null;
        },
        findMany: async (args: any) => {
          const audits = getStore("audits");
          return audits.filter((r: any) => matches(r, args.where)).map((a: any) => structuredClone(a));
        },
        create: async ({ data }: any) => {
          if (options.failAudit && data.action === "SALE_RECOVERY_ATTEMPT_PREPARED") {
            throw new Error("Simulated audit creation failure");
          }
          if (
            options.failPostingAudit &&
            (data.action === "SALE_RECOVERY_POSTED" || data.action === "SALE_RECOVERY_ATTACHED")
          ) {
            throw new Error("Simulated post-payment audit creation failure");
          }
          const audits = getMutStore("audits");
          const log = { id: `audit-${audits.length + 1}`, createdAt: new Date(), ...structuredClone(data) };
          audits.push(log);
          return log;
        },
      },
      checkoutOperation: {
        findUnique: async ({ where }: any) => {
          const ops = getStore("checkoutOperations");
          const op = ops[where.operationKey];
          return op ? structuredClone(op) : null;
        },
        create: async ({ data }: any) => {
          const ops = getMutStore("checkoutOperations");
          const op = { id: `op-${Object.keys(ops).length + 1}`, ...structuredClone(data), createdAt: new Date() };
          ops[data.operationKey] = op;
          return op;
        },
        update: async ({ where, data }: any) => {
          if (options.failResponseUpdate && data.responseJson !== undefined) {
            throw new Error("Simulated failure updating checkout operation response");
          }
          const ops = getMutStore("checkoutOperations");
          const key = Object.keys(ops).find((k) => ops[k].id === where.id);
          if (key) {
            Object.assign(ops[key], data);
            return ops[key];
          }
          return null;
        },
      },
      user: {
        findUnique: async ({ where }: any) => state.cashiers[where.id] || null,
        findFirst: async () => state.cashiers[managerActor.id] || null,
      },
      product: {
        findUnique: async ({ where }: any) => {
          const prods = getStore("products");
          return prods[where.id] ? structuredClone(prods[where.id]) : null;
        },
        findMany: async () => {
          const prods = getStore("products");
          return Object.values(prods).map((p: any) => structuredClone(p));
        },
        update: async ({ where, data }: any) => {
          const prods = getMutStore("products");
          const prod = prods[where.id];
          if (prod) {
            if (data.stock?.decrement) prod.stock -= data.stock.decrement;
            if (data.reservedStock?.increment) prod.reservedStock += data.reservedStock.increment;
            if (data.reservedStock?.decrement) prod.reservedStock -= data.reservedStock.decrement;
            return structuredClone(prod);
          }
          return null;
        },
        updateMany: async ({ where, data }: any) => {
          const prods = getMutStore("products");
          const prod = prods[where?.id];
          if (prod) {
            if (data.stock?.decrement) prod.stock -= data.stock.decrement;
            if (data.reservedStock?.decrement) prod.reservedStock -= data.reservedStock.decrement;
            return { count: 1 };
          }
          return { count: 0 };
        },
      },
      cashDrawer: {
        findFirst: async ({ where }: any) => {
          const drawers = getStore("cashDrawers");
          const d = Object.values(drawers).find((dr: any) => matches(dr, where));
          return d ? structuredClone(d) : null;
        },
        findUnique: async ({ where }: any) => {
          const drawers = getStore("cashDrawers");
          const d = drawers[where.id];
          return d ? structuredClone(d) : null;
        },
        findMany: async ({ where }: any = {}) => {
          const drawers = getStore("cashDrawers");
          return Object.values(drawers).filter((d: any) => matches(d, where)).map((d: any) => structuredClone(d));
        },
        create: async ({ data }: any) => {
          const drawers = getMutStore("cashDrawers");
          const id = `drawer-${Object.keys(drawers).length + 1}`;
          const d = {
            id,
            cashierId: data.cashierId,
            status: "OPEN",
            openedAt: new Date(),
            closedAt: null,
            businessDate: new Date(),
            openingFloat: data.openingFloat || 0,
            cashSalesTotal: 0,
            cashInTotal: 0,
            cashOutTotal: 0,
            expectedTotal: data.expectedTotal || data.openingFloat || 0,
            actualTotal: null,
            difference: null,
            note: data.note || null,
            ...structuredClone(data),
          };
          drawers[id] = d;
          return structuredClone(d);
        },
        update: async ({ where, data, include }: any) => {
          const drawers = getMutStore("cashDrawers");
          const d = drawers[where.id];
          if (d) {
            Object.assign(d, data);
            const result = structuredClone(d);
            if (include?.cashier) {
              result.cashier = state.cashiers[d.cashierId] ? structuredClone(state.cashiers[d.cashierId]) : null;
            }
            if (include?.events) {
              const events = getStore("cashDrawerEvents") || [];
              result.events = events.filter((e: any) => e.drawerId === d.id);
            }
            return result;
          }
          return null;
        },
      },
      cashDrawerEvent: {
        create: async ({ data }: any) => {
          const events = getMutStore("cashDrawerEvents");
          const ev = { id: `event-${events.length + 1}`, createdAt: new Date(), ...structuredClone(data) };
          events.push(ev);
          return ev;
        },
        groupBy: async ({ by, where, _sum }: any) => {
          const events = (getStore("cashDrawerEvents") || []).filter((e: any) => {
            if (where?.drawerId && e.drawerId !== where.drawerId) return false;
            return true;
          });
          const sumsByType: Record<string, number> = {};
          for (const e of events) {
            sumsByType[e.type] = (sumsByType[e.type] || 0) + (Number(e.amount) || 0);
          }
          return Object.entries(sumsByType).map(([type, amount]) => ({
            type,
            _sum: { amount },
          }));
        },
        findMany: async ({ where }: any = {}) => {
          const events = getStore("cashDrawerEvents") || [];
          return events.filter((e: any) => matches(e, where)).map((e: any) => structuredClone(e));
        },
      },
      invoice: {
        findUnique: async ({ where, include }: any) => {
          const invs = getStore("invoices");
          const inv = invs[where.id];
          if (!inv) return null;
          const cloned = structuredClone(inv);
          if (include?.items) {
            const items = getStore("invoiceItems");
            const prods = getStore("products");
            cloned.items = Object.values(items)
              .filter((it: any) => it.invoiceId === where.id)
              .map((it: any) => ({
                ...it,
                product: prods[it.productId] ? structuredClone(prods[it.productId]) : null,
              }));
          }
          if (include?.payments) {
            const pays = getStore("payments");
            cloned.payments = Object.values(pays).filter((p: any) => p.invoiceId === where.id);
          }
          if (include?.customer) {
            cloned.customer = null;
          }
          return cloned;
        },
        findUniqueOrThrow: async ({ where, include }: any) => {
          const invs = getStore("invoices");
          const inv = invs[where.id];
          if (!inv) throw new Error("Invoice not found");
          const cloned = structuredClone(inv);
          if (include?.items) {
            const items = getStore("invoiceItems");
            const prods = getStore("products");
            cloned.items = Object.values(items)
              .filter((it: any) => it.invoiceId === where.id)
              .map((it: any) => ({
                ...it,
                product: prods[it.productId] ? structuredClone(prods[it.productId]) : null,
              }));
          }
          if (include?.payments) {
            const pays = getStore("payments");
            cloned.payments = Object.values(pays).filter((p: any) => p.invoiceId === where.id);
          }
          if (include?.customer) {
            cloned.customer = null;
          }
          return cloned;
        },
        findFirst: async ({ where, include }: any) => {
          const invs = getStore("invoices");
          const inv = Object.values(invs).find((i: any) => matches(i, where)) as any;
          if (!inv) return null;
          const cloned = structuredClone(inv);
          if (include?.items) {
            const items = getStore("invoiceItems");
            const prods = getStore("products");
            cloned.items = Object.values(items)
              .filter((it: any) => it.invoiceId === inv.id)
              .map((it: any) => ({
                ...it,
                product: prods[it.productId] ? structuredClone(prods[it.productId]) : null,
              }));
          }
          return cloned;
        },
        findMany: async (args: any) =>
          Object.values(getStore("invoices"))
            .filter((i: any) => matches(i, args?.where))
            .map((i: any) => structuredClone(i)),
        create: async ({ data }: any) => {
          const invs = getMutStore("invoices");
          const inv = {
            id: `inv-${Object.keys(invs).length + 1}`,
            invoiceNo: `INV-2026-REC-00${Object.keys(invs).length + 1}`,
            status: "DRAFT",
            paymentStatus: "PENDING",
            paidTotal: 0,
            netTotal: 100,
            subTotal: 100,
            discountTotal: 0,
            finalizedAt: null,
            cancelledAt: null,
            deletedAt: null,
            ...structuredClone(data),
            items: [],
            payments: [],
          };
          invs[inv.id] = inv;
          return inv;
        },
        update: async ({ where, data }: any) => {
          if (options.failDuringFinalization && data.status === "FINALIZED") {
            throw new Error("Simulated failure during invoice finalization");
          }
          const invs = getMutStore("invoices");
          const inv = invs[where.id];
          if (inv) {
            Object.assign(inv, data);
            return structuredClone(inv);
          }
          return null;
        },
      },
      invoiceItem: {
        create: async ({ data }: any) => {
          const items = getMutStore("invoiceItems");
          const item = { id: `item-${Object.keys(items).length + 1}`, ...structuredClone(data) };
          items[item.id] = item;
          return item;
        },
        createMany: async ({ data }: any) => {
          const items = getMutStore("invoiceItems");
          const list = Array.isArray(data) ? data : [data];
          for (const it of list) {
            const item = { id: `item-${Object.keys(items).length + 1}`, ...structuredClone(it) };
            items[item.id] = item;
          }
          return { count: list.length };
        },
        findMany: async ({ where }: any) => {
          const items = getStore("invoiceItems");
          const prods = getStore("products");
          return Object.values(items)
            .filter((it: any) => matches(it, where))
            .map((it: any) => ({
              ...it,
              product: prods[it.productId] ? structuredClone(prods[it.productId]) : null,
            }));
        },
        update: async ({ where, data }: any) => {
          const items = getMutStore("invoiceItems");
          const it = items[where.id];
          if (it) Object.assign(it, data);
          return it;
        },
      },
      payment: {
        create: async ({ data }: any) => {
          if (options.failPayment) {
            throw new Error("Simulated payment record creation failure");
          }
          const pays = getMutStore("payments");
          const p = {
            id: `pay-${Object.keys(pays).length + 1}`,
            kind: "CHARGE",
            status: "SUCCESS",
            createdAt: new Date(),
            ...structuredClone(data),
          };
          pays[p.id] = p;
          return p;
        },
        aggregate: async ({ _sum, where }: any) => {
          const pays = Object.values(getStore("payments"));
          const filtered = pays.filter((p: any) => {
            if (where?.method && p.method !== where.method) return false;
            if (where?.kind && p.kind !== where.kind) return false;
            if (where?.status && p.status !== where.status) return false;
            if (where?.createdById && p.createdById !== where.createdById) return false;
            if (where?.createdAt?.gte && new Date(p.createdAt) < new Date(where.createdAt.gte)) return false;
            if (where?.createdAt?.lte && new Date(p.createdAt) > new Date(where.createdAt.lte)) return false;
            return true;
          });
          const total = filtered.reduce((acc: number, p: any) => acc + (Number(p.amount) || 0), 0);
          return { _sum: { amount: total } };
        },
        findMany: async ({ where }: any = {}) => {
          const pays = Object.values(getStore("payments"));
          return pays.filter((p: any) => matches(p, where)).map((p: any) => structuredClone(p));
        },
      },
      priceOverrideAuthorization: {
        findUnique: async ({ where }: any) => {
          const overrides = getStore("priceOverrideAuthorizations");
          const ov = Object.values(overrides).find(
            (o: any) =>
              o.id === where.id ||
              o.token === where.token ||
              o.tokenHash === where.tokenHash ||
              (where.tokenHash && hashOverrideToken(o.token) === where.tokenHash),
          );
          return ov ? structuredClone(ov) : null;
        },
        update: async ({ where, data }: any) => {
          if (options.failOverrideAuthorization) {
            throw new Error("Simulated price override authorization update failure");
          }
          const overrides = getMutStore("priceOverrideAuthorizations");
          const key = Object.keys(overrides).find(
            (k) =>
              overrides[k].id === where.id ||
              overrides[k].token === where.token ||
              overrides[k].tokenHash === where.tokenHash ||
              (where.tokenHash && hashOverrideToken(overrides[k].token) === where.tokenHash),
          );
          if (key) {
            Object.assign(overrides[key], data);
            return structuredClone(overrides[key]);
          }
          return null;
        },
      },
      billingDraftRequest: {
        findUnique: async () => null,
      },
      stockTransaction: {
        create: async ({ data }: any) => {
          const txs = getMutStore("stockTransactions");
          const st = { id: `st-${txs.length + 1}`, ...data, createdAt: new Date() };
          txs.push(st);
          return st;
        },
        findMany: async ({ where }: any = {}) => {
          const txs = getStore("stockTransactions");
          return txs.filter((st: any) => matches(st, where)).map((st: any) => structuredClone(st));
        },
      },
      invoiceSequence: {
        upsert: async ({ where, create, update }: any) => {
          const seqs = getMutStore("invoiceSequences");
          const date = where?.businessDate || create?.businessDate || "20261004";
          if (!seqs[date]) {
            seqs[date] = { id: `seq-${Object.keys(seqs).length + 1}`, businessDate: date, lastNumber: 1 };
          } else {
            seqs[date].lastNumber += update?.lastNumber?.increment || 1;
          }
          return structuredClone(seqs[date]);
        },
      },
      businessSettings: {
        findFirst: async () => structuredClone(state.businessSettings),
        findUnique: async () => structuredClone(state.businessSettings),
        upsert: async () => structuredClone(state.businessSettings),
      },
    };
  }

  const globalClient = client();
  for (const name of [
    "document",
    "auditLog",
    "checkoutOperation",
    "user",
    "product",
    "cashDrawer",
    "cashDrawerEvent",
    "invoice",
    "invoiceItem",
    "payment",
    "priceOverrideAuthorization",
    "billingDraftRequest",
    "stockTransaction",
    "invoiceSequence",
    "businessSettings",
  ] as const) {
    if (!(prisma as any)[name]) (prisma as any)[name] = {};
    for (const [method, fn] of Object.entries((globalClient as any)[name] || {})) {
      replace((prisma as any)[name], method, fn);
    }
  }

  replace(prisma, "$queryRaw", globalClient.$queryRaw);

  replace(prisma, "$transaction", async (work: any) => {
    const txId = `tx-${++txCounter}`;
    try {
      const local: any = {};
      const tx = client(local, txId);
      const result = await work(tx);

      if (options.onBeforeCommit) {
        await options.onBeforeCommit({ txId, local });
      }

      const isFinancialPostingTx =
        local.document?.saleRecoveryStatus === "ATTACHED" ||
        (local.invoices && Object.keys(local.invoices).length > Object.keys(state.invoices).length);

      // Commit staged local changes to shared state on success
      for (const [key, val] of Object.entries(local)) {
        if (key === "rawQueries") {
          state.rawQueries.push(...(val as any[]));
        } else {
          state[key] = val;
        }
      }

      if (options.failPostingAfterCommit && isFinancialPostingTx) {
        throw new Error("Simulated network timeout/disconnect right after financial posting commit");
      }

      return result;
    } finally {
      releaseAllLocks(txId);
    }
  });

  return {
    state,
    restore: () => {
      while (saved.length > 0) saved.pop()!();
      resourceLocks.clear();
    },
  };
}

test("sales evidence recovery transactions", async (t) => {
await t.test("sales evidence recovery revision lifecycle and owner validation", async () => {
  const fx = createFixture();
  try {
    const recoveryInput = {
      reference: {
        billNo: "00991",
        externalDocumentType: "PAN_INVOICE" as const,
        externalBillDate: "2026-10-04",
      },
      reason: "Recovery for power outage paper bill",
      paymentAssessment: {
        type: "CURRENT_DRAWER_CASH" as const,
        drawerId: "drawer-1",
        collectedAt: new Date().toISOString(),
        explanation: "Cash in drawer",
        alreadyAccounted: false as const,
      },
      checkout: {
        items: [{ productId: "prod-1", qty: 1 }],
        payment: {
          method: "CASH" as const,
          amount: 100,
        },
        confirmation: {
          payableTotal: 100,
          items: [{ productId: "prod-1", qty: 1, appliedUnitPrice: 100 }],
        },
      },
    };

    // Prepare attempt with matching metadata
    fx.state.document.recoveryCheckoutOperationKey = "rec_op_key_1";
    fx.state.document.recoveryCheckoutPayloadHash = "hash_1";
    fx.state.audits.push({
      id: "audit-attempt-1",
      actorId: managerActor.id,
      action: "SALE_RECOVERY_ATTEMPT_PREPARED",
      entityType: "Document",
      entityId: fx.state.document.id,
      meta: {
        operationKey: "rec_op_key_1",
        recoveryFingerprint: "hash_1",
        reason: "Initial prep",
      },
      createdAt: new Date(),
    });

    // 1. Revision with mismatched audit metadata throws UNVERIFIED_PREPARATION
    fx.state.document.recoveryCheckoutPayloadHash = "hash_different";
    await assert.rejects(
      reviseSaleEvidenceRecoveryAttempt(
        fx.state.document.id,
        {
          expectedAttemptId: "audit-attempt-1",
          reason: "Changing bill no",
          recovery: recoveryInput,
        },
        managerActor,
        capabilities,
      ),
      (err: any) => {
        assert.equal(err.code, "UNVERIFIED_PREPARATION");
        assert.equal(err.statusCode, 409);
        return true;
      },
    );
    fx.state.document.recoveryCheckoutPayloadHash = "hash_1";

    // 2. Revision with existing prior checkoutOperation throws ACTIVE_OPERATION_CONFLICT
    fx.state.checkoutOperations["rec_op_key_1"] = {
      id: "op-prior",
      operationKey: "rec_op_key_1",
      actorId: managerActor.id,
      completedAt: null,
      invoiceId: null,
    };
    await assert.rejects(
      reviseSaleEvidenceRecoveryAttempt(
        fx.state.document.id,
        {
          expectedAttemptId: "audit-attempt-1",
          reason: "Changing bill no",
          recovery: recoveryInput,
        },
        managerActor,
        capabilities,
      ),
      (err: any) => {
        assert.equal(err.code, "ACTIVE_OPERATION_CONFLICT");
        assert.equal(err.statusCode, 409);
        return true;
      },
    );
    delete fx.state.checkoutOperations["rec_op_key_1"];

    // 3. Different manager attempting to revise throws ATTEMPT_OWNER_MISMATCH
    await assert.rejects(
      reviseSaleEvidenceRecoveryAttempt(
        fx.state.document.id,
        {
          expectedAttemptId: "audit-attempt-1",
          reason: "Changing bill no",
          recovery: recoveryInput,
        },
        managerTwoActor,
        capabilities,
      ),
      (err: any) => {
        assert.equal(err.code, "ATTEMPT_OWNER_MISMATCH");
        assert.equal(err.statusCode, 403);
        return true;
      },
    );

    // 4. Stale attempt ID throws STALE_ATTEMPT_CONFLICT
    await assert.rejects(
      reviseSaleEvidenceRecoveryAttempt(
        fx.state.document.id,
        {
          expectedAttemptId: "audit-stale-id",
          reason: "Changing bill no",
          recovery: recoveryInput,
        },
        managerActor,
        capabilities,
      ),
      (err: any) => {
        assert.equal(err.code, "STALE_ATTEMPT_CONFLICT");
        assert.equal(err.statusCode, 409);
        return true;
      },
    );

    // 5. Same manager with valid expectedAttemptId revises successfully
    const revision = await reviseSaleEvidenceRecoveryAttempt(
      fx.state.document.id,
      {
        expectedAttemptId: "audit-attempt-1",
        reason: "Updated item count",
        recovery: recoveryInput,
      },
      managerActor,
      capabilities,
    );

    assert.equal(revision.status, "PREPARED");
    assert.ok(revision.attemptId);
    assert.ok(fx.state.document.recoveryCheckoutOperationKey.startsWith("rec_"));
    assert.notEqual(fx.state.document.recoveryCheckoutOperationKey, "rec_op_key_1");

    // Lock query asserted
    const docLockQuery = fx.state.rawQueries.find((q: any) => q.query.includes("Document") && q.query.includes("FOR UPDATE"));
    assert.ok(docLockQuery, "Revision must acquire Document FOR UPDATE lock");
  } finally {
    fx.restore();
  }
});

await t.test("prepareAndPostSaleEvidenceRecovery full execution, replay idempotency, and owner guard", async () => {
  const fx = createFixture();
  try {
    const recoveryInput = {
      reference: {
        billNo: "00991",
        externalDocumentType: "PAN_INVOICE" as const,
        externalBillDate: "2026-10-04",
      },
      reason: "Recovery for power outage paper bill",
      paymentAssessment: {
        type: "CURRENT_DRAWER_CASH" as const,
        drawerId: "drawer-1",
        collectedAt: new Date().toISOString(),
        explanation: "Cash in drawer",
        alreadyAccounted: false as const,
      },
      checkout: {
        items: [{ productId: "prod-1", qty: 1 }],
        payment: {
          method: "CASH" as const,
          amount: 100,
        },
        confirmation: {
          payableTotal: 100,
          items: [{ productId: "prod-1", qty: 1, appliedUnitPrice: 100 }],
        },
      },
    };

    // 1. First execution creates and finalizes invoice
    const result = await prepareAndPostSaleEvidenceRecovery(
      fx.state.document.id,
      recoveryInput,
      managerActor,
      capabilities,
    );

    assert.equal(result.replayed, false);
    assert.ok(result.invoice);
    assert.equal(result.invoice.externalBillNo, "00991");
    assert.equal(result.invoice.externalDocumentType, "PAN_INVOICE");
    assert.equal(result.document.saleRecoveryStatus, "ATTACHED");
    assert.equal(fx.state.document.saleRecoveryStatus, "ATTACHED");

    // Check audits created
    const recoveryAudits = fx.state.audits.filter((a: any) => a.action.startsWith("SALE_RECOVERY_"));
    assert.ok(recoveryAudits.some((a: any) => a.action === "SALE_RECOVERY_ATTEMPT_PREPARED"));
    assert.ok(recoveryAudits.some((a: any) => a.action === "SALE_RECOVERY_POSTED"));
    assert.ok(recoveryAudits.some((a: any) => a.action === "SALE_RECOVERY_ATTACHED"));

    // Check lock queries recorded
    const lockQueries = fx.state.rawQueries.filter((q: any) => q.query.includes("FOR UPDATE"));
    assert.ok(lockQueries.some((q: any) => q.query.includes("Document")), "Must lock Document FOR UPDATE");
    assert.ok(lockQueries.some((q: any) => q.query.includes("Product")), "Must lock Product FOR UPDATE");
    assert.ok(lockQueries.some((q: any) => q.query.includes("CashDrawer")), "Must lock CashDrawer FOR UPDATE");

    // 2. Replaying identical input by same manager returns replayed: true
    const replayedResult = await prepareAndPostSaleEvidenceRecovery(
      fx.state.document.id,
      recoveryInput,
      managerActor,
      capabilities,
    );

    assert.equal(replayedResult.replayed, true);
    assert.equal(replayedResult.invoice.id, result.invoice.id);

    // 3. Second manager attempting to POST the same completed recovery throws ATTEMPT_OWNER_MISMATCH
    await assert.rejects(
      prepareAndPostSaleEvidenceRecovery(
        fx.state.document.id,
        recoveryInput,
        managerTwoActor,
        capabilities,
      ),
      (err: any) => {
        assert.equal(err.code, "ATTEMPT_OWNER_MISMATCH");
        assert.equal(err.statusCode, 403);
        return true;
      },
    );
  } finally {
    fx.restore();
  }
});

await t.test("durable preparation persists when financial checkout rolls back due to insufficient stock", async () => {
  const fx = createFixture();
  try {
    // Make product have zero stock so checkoutInvoiceTx fails
    fx.state.products["prod-1"].stock = 0;

    const initialInvoices = structuredClone(fx.state.invoices);
    const initialPayments = structuredClone(fx.state.payments);
    const initialStockTxs = structuredClone(fx.state.stockTransactions);

    const recoveryInput = {
      reference: {
        billNo: "00992",
        externalDocumentType: "PAN_INVOICE" as const,
        externalBillDate: "2026-10-04",
      },
      reason: "Recovery attempting with insufficient stock",
      paymentAssessment: {
        type: "CURRENT_DRAWER_CASH" as const,
        drawerId: "drawer-1",
        collectedAt: new Date().toISOString(),
        explanation: "Cash in drawer",
        alreadyAccounted: false as const,
      },
      checkout: {
        items: [{ productId: "prod-1", qty: 2 }],
        payment: {
          method: "CASH" as const,
          amount: 200,
        },
        confirmation: {
          payableTotal: 200,
          items: [{ productId: "prod-1", qty: 2, appliedUnitPrice: 100 }],
        },
      },
    };

    // Attempting post should fail because stock is insufficient
    await assert.rejects(
      prepareAndPostSaleEvidenceRecovery(
        fx.state.document.id,
        recoveryInput,
        managerActor,
        capabilities,
      ),
      (err: any) => {
        assert.match(err.message, /Insufficient stock/);
        return true;
      },
    );

    // Document remains UNRESOLVED but durable preparation key & audit persisted
    assert.equal(fx.state.document.saleRecoveryStatus, "UNRESOLVED");
    assert.ok(fx.state.document.recoveryCheckoutOperationKey);
    assert.ok(fx.state.document.recoveryCheckoutPayloadHash);
    const prepAudit = fx.state.audits.find((a: any) => a.action === "SALE_RECOVERY_ATTEMPT_PREPARED");
    assert.ok(prepAudit);

    // All financial writes rolled back
    assert.deepEqual(fx.state.invoices, initialInvoices);
    assert.deepEqual(fx.state.payments, initialPayments);
    assert.deepEqual(fx.state.stockTransactions, initialStockTxs);
    assert.equal(fx.state.products["prod-1"].stock, 0);

    // Retrying with changed intent (e.g. qty 1) without revision is REJECTED with INTENT_CONFLICT
    const changedInput = {
      ...recoveryInput,
      checkout: {
        items: [{ productId: "prod-1", qty: 1 }],
        payment: {
          method: "CASH" as const,
          amount: 100,
        },
        confirmation: {
          payableTotal: 100,
          items: [{ productId: "prod-1", qty: 1, appliedUnitPrice: 100 }],
        },
      },
    };

    await assert.rejects(
      prepareAndPostSaleEvidenceRecovery(
        fx.state.document.id,
        changedInput,
        managerActor,
        capabilities,
      ),
      (err: any) => {
        assert.equal(err.code, "INTENT_CONFLICT");
        assert.equal(err.statusCode, 409);
        return true;
      },
    );
  } finally {
    fx.restore();
  }
});

await t.test("cash drawer validation rejects closed, wrong drawer, or future collection time", async () => {
  const fx = createFixture();
  try {
    // 1. Closed drawer rejection
    fx.state.cashDrawers["drawer-1"].status = "CLOSED";

    const recoveryInput = {
      reference: {
        billNo: "00993",
        externalDocumentType: "PAN_INVOICE" as const,
        externalBillDate: "2026-10-04",
      },
      reason: "Recovery testing drawer closed",
      paymentAssessment: {
        type: "CURRENT_DRAWER_CASH" as const,
        drawerId: "drawer-1",
        collectedAt: new Date().toISOString(),
        explanation: "Cash in closed drawer",
        alreadyAccounted: false as const,
      },
      checkout: {
        items: [{ productId: "prod-1", qty: 1 }],
        payment: {
          method: "CASH" as const,
          amount: 100,
        },
        confirmation: {
          payableTotal: 100,
          items: [{ productId: "prod-1", qty: 1, appliedUnitPrice: 100 }],
        },
      },
    };

    await assert.rejects(
      prepareAndPostSaleEvidenceRecovery(
        fx.state.document.id,
        recoveryInput,
        managerActor,
        capabilities,
      ),
      (err: any) => {
        assert.equal(err.code, "DRAWER_CLOSED");
        assert.equal(err.statusCode, 409);
        return true;
      },
    );

    // 2. Drawer owned by another user rejection
    fx.state.cashDrawers["drawer-1"].status = "OPEN";
    fx.state.cashDrawers["drawer-1"].cashierId = managerTwoActor.id;

    await assert.rejects(
      prepareAndPostSaleEvidenceRecovery(
        fx.state.document.id,
        recoveryInput,
        managerActor,
        capabilities,
      ),
      (err: any) => {
        assert.equal(err.code, "DRAWER_OWNER_MISMATCH");
        assert.equal(err.statusCode, 409);
        return true;
      },
    );

    // 3. Future collection timestamp rejection (no tolerance)
    fx.state.cashDrawers["drawer-1"].cashierId = managerActor.id;
    fx.state.document.saleRecoveryStatus = "UNRESOLVED";
    fx.state.document.recoveryCheckoutOperationKey = null;
    fx.state.document.recoveryCheckoutPayloadHash = null;

    const futureInput = {
      ...recoveryInput,
      paymentAssessment: {
        ...recoveryInput.paymentAssessment,
        collectedAt: new Date(Date.now() + 10000).toISOString(),
      },
    };

    await assert.rejects(
      prepareAndPostSaleEvidenceRecovery(
        fx.state.document.id,
        futureInput,
        managerActor,
        capabilities,
      ),
      (err: any) => {
        assert.equal(err.code, "INVALID_COLLECTION_TIME");
        assert.equal(err.statusCode, 409);
        return true;
      },
    );
  } finally {
    fx.restore();
  }
});

await t.test("concurrent overlapping recovery operations serialize and produce single posting under lock contention", async () => {
  let signalFirstRecoveryInPostingTx: (() => void) | null = null;
  const firstRecoveryInPostingTxPromise = new Promise<void>((resolve) => {
    signalFirstRecoveryInPostingTx = resolve;
  });

  let signalSecondRecoveryWaiting: (() => void) | null = null;
  const secondRecoveryWaitingPromise = new Promise<void>((resolve) => {
    signalSecondRecoveryWaiting = resolve;
  });

  let firstRecoveryCompleted = false;
  let secondRecoveryCompleted = false;

  const fx = createFixture({
    onLockWait: async (resource) => {
      if (resource === "Document:doc-rec-1") {
        if (signalSecondRecoveryWaiting) signalSecondRecoveryWaiting();
      }
    },
    onBeforeCommit: async ({ local }) => {
      if (local.document?.saleRecoveryStatus === "ATTACHED") {
        if (signalFirstRecoveryInPostingTx) signalFirstRecoveryInPostingTx();
        await secondRecoveryWaitingPromise;
        assert.equal(secondRecoveryCompleted, false, "Second recovery must be blocked while first holds Document lock");
      }
    },
  });

  try {
    const recoveryInput = {
      reference: {
        billNo: "00994",
        externalDocumentType: "PAN_INVOICE" as const,
        externalBillDate: "2026-10-04",
      },
      reason: "Concurrent recovery test",
      paymentAssessment: {
        type: "CURRENT_DRAWER_CASH" as const,
        drawerId: "drawer-1",
        collectedAt: new Date().toISOString(),
        explanation: "Cash in drawer",
        alreadyAccounted: false as const,
      },
      checkout: {
        items: [{ productId: "prod-1", qty: 1 }],
        payment: {
          method: "CASH" as const,
          amount: 100,
        },
        confirmation: {
          payableTotal: 100,
          items: [{ productId: "prod-1", qty: 1, appliedUnitPrice: 100 }],
        },
      },
    };

    // 1. Start first recovery
    const firstPromise = prepareAndPostSaleEvidenceRecovery(
      fx.state.document.id,
      recoveryInput,
      managerActor,
      capabilities,
    ).then((res) => {
      firstRecoveryCompleted = true;
      return res;
    });

    // 2. Wait until First Recovery has entered financial posting (Step 2) holding Document lock
    await firstRecoveryInPostingTxPromise;

    // 3. Start second recovery concurrently while first recovery holds Document lock
    const secondPromise = prepareAndPostSaleEvidenceRecovery(
      fx.state.document.id,
      recoveryInput,
      managerActor,
      capabilities,
    ).then((res) => {
      secondRecoveryCompleted = true;
      return res;
    });

    // 4. Wait for both to complete
    const [firstRes, secondRes] = await Promise.all([firstPromise, secondPromise]);

    assert.equal(firstRecoveryCompleted, true);
    assert.equal(secondRecoveryCompleted, true);
    assert.equal(firstRes.document.saleRecoveryStatus, "ATTACHED");
    assert.equal(firstRes.replayed, false);
    assert.equal(secondRes.document.saleRecoveryStatus, "ATTACHED");
    assert.equal(secondRes.replayed, true);

    // Exactly one recovery invoice is created in state (plus pre-existing seed)
    const newInvoices = Object.values(fx.state.invoices).filter((i: any) => i.id !== "inv-existing-1");
    assert.equal(newInvoices.length, 1);
    assert.equal(fx.state.document.saleRecoveryStatus, "ATTACHED");

    // Assert explicit Document lock waiters and contended acquisitions were recorded
    const docLockWaiters = fx.state.lockWaiters.filter((w: any) => w.resource === `Document:${fx.state.document.id}`);
    assert.ok(docLockWaiters.length >= 1, "Must record lock waiter on Document");

    const docContention = fx.state.contendedAcquisitions.filter(
      (c: any) => c.resource === `Document:${fx.state.document.id}`,
    );
    assert.ok(docContention.length >= 1, "Must record contended acquisition on Document");
    assert.ok(docContention[0].holderTxId && docContention[0].waiterTxId);
  } finally {
    fx.restore();
  }
});

await t.test("recovery and attach contention: overlapping execution serializes and blocks conflicting operation", async () => {
  let signalRecoveryInPostingTx: (() => void) | null = null;
  const recoveryInPostingTxPromise = new Promise<void>((resolve) => {
    signalRecoveryInPostingTx = resolve;
  });

  let signalAttachWaiting: (() => void) | null = null;
  const attachWaitingPromise = new Promise<void>((resolve) => {
    signalAttachWaiting = resolve;
  });

  let recoveryCompleted = false;
  let attachFinished = false;

  const fx = createFixture({
    onLockWait: async (resource) => {
      if (resource === "Document:doc-rec-1") {
        if (signalAttachWaiting) signalAttachWaiting();
      }
    },
    onBeforeCommit: async ({ local }) => {
      if (local.document?.saleRecoveryStatus === "ATTACHED") {
        if (signalRecoveryInPostingTx) signalRecoveryInPostingTx();
        await attachWaitingPromise;
        assert.equal(attachFinished, false, "Attach must be blocked while recovery holds Document lock");
      }
    },
  });

  try {
    const attachInput = {
      invoiceId: "inv-existing-1",
      reference: {
        billNo: "00888",
        externalDocumentType: "PAN_INVOICE" as const,
        externalBillDate: "2026-10-04",
      },
      expectedInvoice: {
        billingChannel: "MANUAL_EXTERNAL" as const,
        externalDocumentType: null,
        externalBillNo: null,
        externalBillDate: null,
        billRecordStatus: "PENDING" as const,
      },
      reason: "Attempting attach while in recovery",
    };

    const recoveryInput = {
      reference: {
        billNo: "00995-contention",
        externalDocumentType: "PAN_INVOICE" as const,
        externalBillDate: "2026-10-04",
      },
      reason: "Overlapping recovery and attach",
      paymentAssessment: {
        type: "NOT_COLLECTED" as const,
        explanation: "Unpaid credit",
      },
      checkout: {
        items: [{ productId: "prod-1", qty: 1 }],
        confirmation: {
          payableTotal: 100,
          items: [{ productId: "prod-1", qty: 1, appliedUnitPrice: 100 }],
        },
      },
    };

    // 1. Start recovery
    const recoveryPromise = prepareAndPostSaleEvidenceRecovery(
      fx.state.document.id,
      recoveryInput,
      managerActor,
      capabilities,
    ).then((res) => {
      recoveryCompleted = true;
      return res;
    });

    // 2. Wait until Recovery has entered financial posting (Step 2) holding Document lock
    await recoveryInPostingTxPromise;

    // 3. Start attach concurrently while Recovery holds Document lock
    const attachPromise = (async () => {
      try {
        await attachSaleEvidence(
          fx.state.document.id,
          attachInput,
          managerActor,
          capabilities,
        );
      } finally {
        attachFinished = true;
      }
    })();

    // 4. Wait for both to complete
    const [recResult] = await Promise.all([
      recoveryPromise,
      assert.rejects(attachPromise, (err: any) => {
        assert.ok(
          ["ACTIVE_OPERATION_CONFLICT", "ATTACHED_CONFLICT", "CLAIM_CONFLICT"].includes(err.code),
          `Rejected attach must fail with conflict code, got ${err.code}`,
        );
        return true;
      }),
    ]);

    assert.equal(recoveryCompleted, true);
    assert.equal(attachFinished, true);
    assert.equal(recResult.document.saleRecoveryStatus, "ATTACHED");

    // Assert explicit lock contention was recorded
    const docLockWaiters = fx.state.lockWaiters.filter((w: any) => w.resource === `Document:${fx.state.document.id}`);
    assert.ok(docLockWaiters.length >= 1, "Must record lock waiter on Document");

    const docContention = fx.state.contendedAcquisitions.filter(
      (c: any) => c.resource === `Document:${fx.state.document.id}`,
    );
    assert.ok(docContention.length >= 1, "Must record contended acquisition on Document");

    // 5. Prepared Document with active recovery key blocks attach directly
    const preparedDoc = structuredClone(fx.state.document);
    preparedDoc.id = "doc-rec-prepared-1";
    preparedDoc.saleRecoveryStatus = "UNRESOLVED";
    preparedDoc.linkedEntityType = null;
    preparedDoc.linkedEntityId = null;
    preparedDoc.recoveryCheckoutOperationKey = "rec_prepared_active";
    preparedDoc.recoveryCheckoutPayloadHash = "hash_active";
    fx.state.document = preparedDoc;

    await assert.rejects(
      attachSaleEvidence("doc-rec-prepared-1", attachInput, managerActor, capabilities),
      (err: any) => {
        assert.equal(err.code, "ACTIVE_OPERATION_CONFLICT");
        assert.equal(err.statusCode, 409);
        return true;
      },
    );
  } finally {
    fx.restore();
  }
});

await t.test("recovery and archive contention: overlapping execution serializes and blocks conflicting operation", async () => {
  let signalArchiveInTx: (() => void) | null = null;
  const archiveInTxPromise = new Promise<void>((resolve) => {
    signalArchiveInTx = resolve;
  });

  let signalRecoveryWaiting: (() => void) | null = null;
  const recoveryWaitingPromise = new Promise<void>((resolve) => {
    signalRecoveryWaiting = resolve;
  });

  let archiveCompleted = false;
  let recoveryFinished = false;

  const fx = createFixture({
    onLockWait: async (resource) => {
      if (resource === "Document:doc-rec-1") {
        if (signalRecoveryWaiting) {
          const cb = signalRecoveryWaiting;
          signalRecoveryWaiting = null;
          cb();
        }
      }
    },
    onBeforeCommit: async ({ local }) => {
      if (local.document?.saleRecoveryStatus === "ARCHIVED") {
        if (signalArchiveInTx) signalArchiveInTx();
        await recoveryWaitingPromise;
        assert.equal(recoveryFinished, false, "Recovery must be blocked while archive holds Document lock");
      }
    },
  });

  try {
    const recoveryInput = {
      reference: {
        billNo: "00995-arch-contention",
        externalDocumentType: "PAN_INVOICE" as const,
        externalBillDate: "2026-10-04",
      },
      reason: "Overlapping recovery and archive",
      paymentAssessment: {
        type: "NOT_COLLECTED" as const,
        explanation: "Unpaid credit",
      },
      checkout: {
        items: [{ productId: "prod-1", qty: 1 }],
        confirmation: {
          payableTotal: 100,
          items: [{ productId: "prod-1", qty: 1, appliedUnitPrice: 100 }],
        },
      },
    };

    // 1. Start archive
    const archivePromise = archiveSaleEvidence(
      fx.state.document.id,
      { reason: "Archiving evidence before recovery" },
      managerActor,
      capabilities,
    ).then((res) => {
      archiveCompleted = true;
      return res;
    });

    // 2. Wait until Archive has entered transaction holding Document lock
    await archiveInTxPromise;

    // 3. Start recovery concurrently while Archive holds Document lock
    const recoveryPromise = (async () => {
      try {
        await prepareAndPostSaleEvidenceRecovery(
          fx.state.document.id,
          recoveryInput,
          managerActor,
          capabilities,
        );
      } finally {
        recoveryFinished = true;
      }
    })();

    // 4. Wait for both to complete
    const [archResult] = await Promise.all([
      archivePromise,
      assert.rejects(recoveryPromise, (err: any) => {
        assert.equal(err.code, "ARCHIVED_CONFLICT");
        assert.equal(err.statusCode, 409);
        return true;
      }),
    ]);

    assert.equal(archiveCompleted, true);
    assert.equal(recoveryFinished, true);
    assert.equal(archResult?.document.saleRecoveryStatus, "ARCHIVED");

    // Assert explicit lock contention was recorded
    const docLockWaiters = fx.state.lockWaiters.filter((w: any) => w.resource === `Document:${fx.state.document.id}`);
    assert.ok(docLockWaiters.length >= 1, "Must record lock waiter on Document");

    const docContention = fx.state.contendedAcquisitions.filter(
      (c: any) => c.resource === `Document:${fx.state.document.id}`,
    );
    assert.ok(docContention.length >= 1, "Must record contended acquisition on Document");

    // 5. Archived document cannot enter recovery
    await assert.rejects(
      prepareAndPostSaleEvidenceRecovery(fx.state.document.id, recoveryInput, managerActor, capabilities),
      (err: any) => {
        assert.equal(err.code, "ARCHIVED_CONFLICT");
        assert.equal(err.statusCode, 409);
        return true;
      },
    );
  } finally {
    fx.restore();
  }
});

await t.test("cash drawer close concurrency with controlled barriers (Schedule A: Recovery holding lock -> Close waits)", async () => {
  let signalRecoveryAcquiredDrawer: (() => void) | null = null;
  const recoveryAcquiredDrawerPromise = new Promise<void>((resolve) => {
    signalRecoveryAcquiredDrawer = resolve;
  });

  let signalCloseWaiting: (() => void) | null = null;
  const closeWaitingPromise = new Promise<void>((resolve) => {
    signalCloseWaiting = resolve;
  });

  let releaseRecoveryLock: (() => void) | null = null;
  const recoveryReleaseBarrier = new Promise<void>((resolve) => {
    releaseRecoveryLock = resolve;
  });

  let closeCompleted = false;
  let recoveryCompleted = false;

  const fx = createFixture({
    onAfterLock: async (resource) => {
      if (resource === "CashDrawer:drawer-1") {
        if (signalRecoveryAcquiredDrawer) signalRecoveryAcquiredDrawer();
      }
    },
    onLockWait: async (resource) => {
      if (resource === "CashDrawer:drawer-1") {
        if (signalCloseWaiting) signalCloseWaiting();
      }
    },
    onBeforeCommit: async ({ local }) => {
      // In recovery financial transaction, wait until closeCashDrawer has queued on CashDrawer lock
      if (local.document?.saleRecoveryStatus === "ATTACHED") {
        await closeWaitingPromise;
        // Assert Close is blocked and has not completed while Recovery holds lock
        assert.equal(closeCompleted, false, "Close must be blocked while Recovery holds CashDrawer lock");
        await recoveryReleaseBarrier;
      }
    },
  });

  try {
    const recoveryInput = {
      reference: {
        billNo: "00996-A-BARRIER",
        externalDocumentType: "PAN_INVOICE" as const,
        externalBillDate: "2026-10-04",
      },
      reason: "Schedule A barrier test",
      paymentAssessment: {
        type: "CURRENT_DRAWER_CASH" as const,
        drawerId: "drawer-1",
        collectedAt: new Date().toISOString(),
        explanation: "Cash in drawer",
        alreadyAccounted: false as const,
      },
      checkout: {
        items: [{ productId: "prod-1", qty: 1 }],
        payment: {
          method: "CASH" as const,
          amount: 100,
        },
        confirmation: {
          payableTotal: 100,
          items: [{ productId: "prod-1", qty: 1, appliedUnitPrice: 100 }],
        },
      },
    };

    // 1. Start recovery (will pause in-flight holding drawer lock until Close is waiting)
    const recoveryPromise = prepareAndPostSaleEvidenceRecovery(
      fx.state.document.id,
      recoveryInput,
      managerActor,
      capabilities,
    ).then((res) => {
      recoveryCompleted = true;
      return res;
    });

    // 2. Wait until Recovery has acquired the CashDrawer lock in Step 2
    await recoveryAcquiredDrawerPromise;

    // 3. Start closeCashDrawer concurrently while recovery is in flight holding drawer lock
    const closePromise = closeCashDrawer(
      "drawer-1",
      managerActor.id,
      managerActor.role,
      1100,
      "Shift closing after recovery",
    ).then((res) => {
      closeCompleted = true;
      return res;
    });

    // 4. Wait until close is deterministically queued on CashDrawer lock
    await closeWaitingPromise;
    assert.equal(closeCompleted, false, "Close must be waiting in lock queue");
    assert.equal(recoveryCompleted, false, "Recovery is holding lock before commit");

    // 5. Release Recovery barrier
    releaseRecoveryLock!();

    const [recResult, closeResult] = await Promise.all([recoveryPromise, closePromise]);

    assert.equal(recoveryCompleted, true);
    assert.equal(closeCompleted, true);
    assert.equal(recResult.document.saleRecoveryStatus, "ATTACHED");
    assert.equal(closeResult.status, "CLOSED");
    assert.equal(closeResult.cashSalesTotal, 100);
    assert.equal(closeResult.expectedTotal, 1100);
    assert.equal(closeResult.actualTotal, 1100);
    assert.equal(closeResult.difference, 0);

    // Verify zero duplicate CASH_IN events were created
    const cashInEvents = fx.state.cashDrawerEvents.filter((e: any) => e.drawerId === "drawer-1" && e.type === "CASH_IN");
    assert.equal(cashInEvents.length, 0, "No duplicate CASH_IN events created for recovery payments");
  } finally {
    fx.restore();
  }
});

await t.test("cash drawer close concurrency with controlled barriers (Schedule B: Close holding lock -> Recovery waits and rejects)", async () => {
  let signalCloseAcquiredDrawer: (() => void) | null = null;
  const closeAcquiredDrawerPromise = new Promise<void>((resolve) => {
    signalCloseAcquiredDrawer = resolve;
  });

  let signalRecoveryWaiting: (() => void) | null = null;
  const recoveryWaitingPromise = new Promise<void>((resolve) => {
    signalRecoveryWaiting = resolve;
  });

  let releaseCloseLock: (() => void) | null = null;
  const closeReleaseBarrier = new Promise<void>((resolve) => {
    releaseCloseLock = resolve;
  });

  let closeCompleted = false;
  let recoveryFinished = false;

  const fx = createFixture({
    onAfterLock: async (resource) => {
      if (resource === "CashDrawer:drawer-1") {
        if (signalCloseAcquiredDrawer) signalCloseAcquiredDrawer();
      }
    },
    onLockWait: async (resource) => {
      if (resource === "CashDrawer:drawer-1") {
        if (signalRecoveryWaiting) signalRecoveryWaiting();
      }
    },
    onBeforeCommit: async ({ local }) => {
      // In closeCashDrawer transaction, wait until recovery has queued on CashDrawer lock
      if (local.cashDrawers?.["drawer-1"]?.status === "CLOSED") {
        await recoveryWaitingPromise;
        // Assert Recovery is blocked and has not completed while Close holds lock
        assert.equal(recoveryFinished, false, "Recovery must be blocked while Close holds CashDrawer lock");
        await closeReleaseBarrier;
      }
    },
  });

  try {
    const recoveryInput = {
      reference: {
        billNo: "00996-B-BARRIER",
        externalDocumentType: "PAN_INVOICE" as const,
        externalBillDate: "2026-10-04",
      },
      reason: "Schedule B barrier test",
      paymentAssessment: {
        type: "CURRENT_DRAWER_CASH" as const,
        drawerId: "drawer-1",
        collectedAt: new Date().toISOString(),
        explanation: "Cash in closed drawer",
        alreadyAccounted: false as const,
      },
      checkout: {
        items: [{ productId: "prod-1", qty: 1 }],
        payment: {
          method: "CASH" as const,
          amount: 100,
        },
        confirmation: {
          payableTotal: 100,
          items: [{ productId: "prod-1", qty: 1, appliedUnitPrice: 100 }],
        },
      },
    };

    // 1. Start closeCashDrawer (will pause in flight holding drawer lock)
    const closePromise = closeCashDrawer(
      "drawer-1",
      managerActor.id,
      managerActor.role,
      1000,
      "Shift closing first",
    ).then((res) => {
      closeCompleted = true;
      return res;
    });

    // 2. Wait until Close has acquired CashDrawer lock
    await closeAcquiredDrawerPromise;

    // 3. Start recovery concurrently while close is in flight
    const recoveryPromise = prepareAndPostSaleEvidenceRecovery(
      fx.state.document.id,
      recoveryInput,
      managerActor,
      capabilities,
    ).finally(() => {
      recoveryFinished = true;
    });

    // 4. Wait until Recovery is queued on CashDrawer lock
    await recoveryWaitingPromise;
    assert.equal(recoveryFinished, false, "Recovery must be waiting in lock queue");
    assert.equal(closeCompleted, false, "Close is holding drawer lock before commit");

    // 5. Release Close barrier
    releaseCloseLock!();

    const closeResult = await closePromise;
    assert.equal(closeCompleted, true);
    assert.equal(closeResult.status, "CLOSED");

    // Recovery must reject with DRAWER_CLOSED (409) once drawer close commits
    await assert.rejects(
      recoveryPromise,
      (err: any) => {
        assert.equal(err.code, "DRAWER_CLOSED");
        assert.equal(err.statusCode, 409);
        return true;
      },
    );
    assert.equal(recoveryFinished, true);

    // Financial state remains clean (no new invoice created)
    const newInvoices = Object.values(fx.state.invoices).filter((i: any) => i.id !== "inv-existing-1");
    assert.equal(newInvoices.length, 0);
  } finally {
    fx.restore();
  }
});

await t.test("lost-commit reconciliation recovers committed invoice and proof when return response is lost", async () => {
  const fx = createFixture({ failPostingAfterCommit: true });
  try {
    const recoveryInput = {
      reference: {
        billNo: "00997",
        externalDocumentType: "PAN_INVOICE" as const,
        externalBillDate: "2026-10-04",
      },
      reason: "Recovery with simulated transport crash after commit",
      paymentAssessment: {
        type: "CURRENT_DRAWER_CASH" as const,
        drawerId: "drawer-1",
        collectedAt: new Date().toISOString(),
        explanation: "Cash in drawer",
        alreadyAccounted: false as const,
      },
      checkout: {
        items: [{ productId: "prod-1", qty: 1 }],
        payment: {
          method: "CASH" as const,
          amount: 100,
        },
        confirmation: {
          payableTotal: 100,
          items: [{ productId: "prod-1", qty: 1, appliedUnitPrice: 100 }],
        },
      },
    };

    const initialStock = fx.state.products["prod-1"].stock;

    // Even though $transaction threw failPostingAfterCommit error after committing the financial checkout,
    // the outer catch in recovery.ts verifies committed provenance on Document + CheckoutOperation + Audits
    // and returns replayed: true!
    const res = await prepareAndPostSaleEvidenceRecovery(fx.state.document.id, recoveryInput, managerActor, capabilities);

    assert.equal(res.replayed, true);
    assert.ok(res.invoice);
    assert.equal(res.invoice.externalBillNo, "00997");
    assert.equal(res.document.saleRecoveryStatus, "ATTACHED");

    // Stock decrement and stock transactions were committed
    assert.equal(fx.state.products["prod-1"].stock, initialStock - 1);
    assert.ok(fx.state.stockTransactions.length >= 1, "Stock transaction must be committed");

    // Locks were acquired
    const lockQueries = fx.state.rawQueries.filter((q: any) => q.query.includes("FOR UPDATE"));
    assert.ok(lockQueries.some((q: any) => q.query.includes("Document")), "Must lock Document FOR UPDATE");
    assert.ok(lockQueries.some((q: any) => q.query.includes("Product")), "Must lock Product FOR UPDATE");
  } finally {
    fx.restore();
  }
});

await t.test("staged rollback on failed document claim preserves preparation identity and leaves all financial stores unchanged", async () => {
  const fx = createFixture({ failClaim: true });
  try {
    // Stage a price override authorization token to ensure token is not consumed on rollback
    fx.state.priceOverrideAuthorizations["ov-token-1"] = {
      id: "ov-auth-1",
      token: "ov-token-1",
      tokenHash: hashOverrideToken("ov-token-1"),
      cashierId: managerActor.id,
      productId: "prod-1",
      customerId: null,
      qty: 1,
      originalUnitPrice: 100,
      overrideUnitPrice: 80,
      overrideReason: "Price match",
      isConsumed: false,
      usedAt: null,
      expiresAt: new Date(Date.now() + 3600000),
      consumedAt: null,
      consumedInvoiceId: null,
      createdAt: new Date(),
    };

    const recoveryInput = {
      reference: {
        billNo: "00998",
        externalDocumentType: "PAN_INVOICE" as const,
        externalBillDate: "2026-10-04",
      },
      reason: "Recovery with simulated claim failure",
      paymentAssessment: {
        type: "NOT_COLLECTED" as const,
        explanation: "Unpaid credit bill",
      },
      checkout: {
        items: [
          {
            productId: "prod-1",
            qty: 1,
            overrideUnitPrice: 80,
            overrideReason: "Price match",
            overrideAuthorizationToken: "ov-token-1",
          },
        ],
        confirmation: {
          payableTotal: 80,
          items: [{ productId: "prod-1", qty: 1, appliedUnitPrice: 80 }],
        },
      },
    };

    const initialProducts = structuredClone(fx.state.products);
    const initialInvoices = structuredClone(fx.state.invoices);
    const initialInvoiceItems = structuredClone(fx.state.invoiceItems);
    const initialPayments = structuredClone(fx.state.payments);
    const initialStockTransactions = structuredClone(fx.state.stockTransactions);
    const initialInvoiceSequences = structuredClone(fx.state.invoiceSequences);
    const initialCheckoutOperations = structuredClone(fx.state.checkoutOperations);
    const initialOverrides = structuredClone(fx.state.priceOverrideAuthorizations);
    const initialProofBytes = fs.readFileSync(path.join(storage, "documents", "paper_bill.jpg"));

    await assert.rejects(
      prepareAndPostSaleEvidenceRecovery(fx.state.document.id, recoveryInput, managerActor, capabilities),
      (err: any) => {
        assert.equal(err.code, "CLAIM_CONFLICT");
        assert.equal(err.statusCode, 409);
        return true;
      },
    );

    // Document remains UNRESOLVED with durable preparation identity
    assert.equal(fx.state.document.saleRecoveryStatus, "UNRESOLVED");
    assert.ok(fx.state.document.recoveryCheckoutOperationKey);
    assert.ok(fx.state.document.recoveryCheckoutPayloadHash);

    // Financial writes 100% rolled back: all stores unchanged
    assert.deepEqual(fx.state.products, initialProducts);
    assert.deepEqual(fx.state.invoices, initialInvoices);
    assert.deepEqual(fx.state.invoiceItems, initialInvoiceItems);
    assert.deepEqual(fx.state.payments, initialPayments);
    assert.deepEqual(fx.state.stockTransactions, initialStockTransactions);
    assert.deepEqual(fx.state.invoiceSequences, initialInvoiceSequences);
    assert.deepEqual(fx.state.checkoutOperations, initialCheckoutOperations);
    assert.deepEqual(fx.state.priceOverrideAuthorizations, initialOverrides);

    // Proof file bytes on disk unmodified
    const currentProofBytes = fs.readFileSync(path.join(storage, "documents", "paper_bill.jpg"));
    assert.deepEqual(currentProofBytes, initialProofBytes);
  } finally {
    fx.restore();
  }
});

await t.test("fault matrix: failAudit during preparation rolls back preparation completely", async () => {
  const fx = createFixture({ failAudit: true });
  try {
    const recoveryInput = {
      reference: {
        billNo: "00999-FAIL-AUDIT",
        externalDocumentType: "PAN_INVOICE" as const,
        externalBillDate: "2026-10-04",
      },
      reason: "Testing preparation audit failure rollback",
      paymentAssessment: {
        type: "NOT_COLLECTED" as const,
        explanation: "Unpaid credit bill",
      },
      checkout: {
        items: [{ productId: "prod-1", qty: 1 }],
        confirmation: {
          payableTotal: 100,
          items: [{ productId: "prod-1", qty: 1, appliedUnitPrice: 100 }],
        },
      },
    };

    await assert.rejects(
      prepareAndPostSaleEvidenceRecovery(fx.state.document.id, recoveryInput, managerActor, capabilities),
      /Simulated audit creation failure/,
    );

    // Document remains UNPREPARED with null recovery keys
    assert.equal(fx.state.document.saleRecoveryStatus, "UNRESOLVED");
    assert.equal(fx.state.document.recoveryCheckoutOperationKey, null);
    assert.equal(fx.state.document.recoveryCheckoutPayloadHash, null);
    assert.equal(fx.state.audits.length, 0);
  } finally {
    fx.restore();
  }
});

await t.test("fault matrix: post-payment audit creation failure rolls back financial transaction completely", async () => {
  const fx = createFixture({ failPostingAudit: true });
  try {
    const recoveryInput = {
      reference: {
        billNo: "00999-FAIL-POST-AUDIT",
        externalDocumentType: "PAN_INVOICE" as const,
        externalBillDate: "2026-10-04",
      },
      reason: "Testing post-payment audit failure rollback",
      paymentAssessment: {
        type: "CURRENT_DRAWER_CASH" as const,
        drawerId: "drawer-1",
        collectedAt: new Date().toISOString(),
        explanation: "Cash in drawer",
        alreadyAccounted: false as const,
      },
      checkout: {
        items: [{ productId: "prod-1", qty: 1 }],
        payment: {
          method: "CASH" as const,
          amount: 100,
        },
        confirmation: {
          payableTotal: 100,
          items: [{ productId: "prod-1", qty: 1, appliedUnitPrice: 100 }],
        },
      },
    };

    const initialProducts = structuredClone(fx.state.products);
    const initialInvoices = structuredClone(fx.state.invoices);
    const initialPayments = structuredClone(fx.state.payments);
    const initialStockTransactions = structuredClone(fx.state.stockTransactions);

    await assert.rejects(
      prepareAndPostSaleEvidenceRecovery(fx.state.document.id, recoveryInput, managerActor, capabilities),
      /Simulated post-payment audit creation failure/,
    );

    // Document remains UNRESOLVED with durable preparation identity from step 1
    assert.equal(fx.state.document.saleRecoveryStatus, "UNRESOLVED");
    assert.ok(fx.state.document.recoveryCheckoutOperationKey);
    assert.ok(fx.state.document.recoveryCheckoutPayloadHash);

    // Financial writes created prior to post-payment audit in transaction are rolled back cleanly
    assert.deepEqual(fx.state.products, initialProducts);
    assert.deepEqual(fx.state.invoices, initialInvoices);
    assert.deepEqual(fx.state.payments, initialPayments);
    assert.deepEqual(fx.state.stockTransactions, initialStockTransactions);

    // No posting or attachment audits were persisted
    const postingAudits = fx.state.audits.filter((a: any) =>
      ["SALE_RECOVERY_POSTED", "SALE_RECOVERY_ATTACHED"].includes(a.action),
    );
    assert.equal(postingAudits.length, 0);
  } finally {
    fx.restore();
  }
});

await t.test("fault matrix: checkout operation response update failure rolls back financial transaction completely", async () => {
  const fx = createFixture({ failResponseUpdate: true });
  try {
    const recoveryInput = {
      reference: {
        billNo: "00999-FAIL-RESP-UPDATE",
        externalDocumentType: "PAN_INVOICE" as const,
        externalBillDate: "2026-10-04",
      },
      reason: "Testing response update failure rollback",
      paymentAssessment: {
        type: "CURRENT_DRAWER_CASH" as const,
        drawerId: "drawer-1",
        collectedAt: new Date().toISOString(),
        explanation: "Cash in drawer",
        alreadyAccounted: false as const,
      },
      checkout: {
        items: [{ productId: "prod-1", qty: 1 }],
        payment: {
          method: "CASH" as const,
          amount: 100,
        },
        confirmation: {
          payableTotal: 100,
          items: [{ productId: "prod-1", qty: 1, appliedUnitPrice: 100 }],
        },
      },
    };

    const initialProducts = structuredClone(fx.state.products);
    const initialInvoices = structuredClone(fx.state.invoices);
    const initialPayments = structuredClone(fx.state.payments);

    await assert.rejects(
      prepareAndPostSaleEvidenceRecovery(fx.state.document.id, recoveryInput, managerActor, capabilities),
      /Simulated failure updating checkout operation response/,
    );

    // Document remains UNRESOLVED with durable preparation identity
    assert.equal(fx.state.document.saleRecoveryStatus, "UNRESOLVED");
    assert.ok(fx.state.document.recoveryCheckoutOperationKey);

    // Financial writes rolled back cleanly
    assert.deepEqual(fx.state.products, initialProducts);
    assert.deepEqual(fx.state.invoices, initialInvoices);
    assert.deepEqual(fx.state.payments, initialPayments);
  } finally {
    fx.restore();
  }
});

await t.test("fault matrix: payment record creation failure rolls back financial transaction completely", async () => {
  const fx = createFixture({ failPayment: true });
  try {
    const recoveryInput = {
      reference: {
        billNo: "00999-FAIL-PAYMENT",
        externalDocumentType: "PAN_INVOICE" as const,
        externalBillDate: "2026-10-04",
      },
      reason: "Testing payment creation failure rollback",
      paymentAssessment: {
        type: "CURRENT_DRAWER_CASH" as const,
        drawerId: "drawer-1",
        collectedAt: new Date().toISOString(),
        explanation: "Cash in drawer",
        alreadyAccounted: false as const,
      },
      checkout: {
        items: [{ productId: "prod-1", qty: 1 }],
        payment: {
          method: "CASH" as const,
          amount: 100,
        },
        confirmation: {
          payableTotal: 100,
          items: [{ productId: "prod-1", qty: 1, appliedUnitPrice: 100 }],
        },
      },
    };

    const initialProducts = structuredClone(fx.state.products);
    const initialInvoices = structuredClone(fx.state.invoices);
    const initialPayments = structuredClone(fx.state.payments);

    await assert.rejects(
      prepareAndPostSaleEvidenceRecovery(fx.state.document.id, recoveryInput, managerActor, capabilities),
      /Simulated payment record creation failure/,
    );

    // Document remains UNRESOLVED with durable preparation identity
    assert.equal(fx.state.document.saleRecoveryStatus, "UNRESOLVED");
    assert.ok(fx.state.document.recoveryCheckoutOperationKey);

    // Financial writes rolled back cleanly (stock restored, zero new payments/invoices)
    assert.deepEqual(fx.state.products, initialProducts);
    assert.deepEqual(fx.state.invoices, initialInvoices);
    assert.deepEqual(fx.state.payments, initialPayments);
  } finally {
    fx.restore();
  }
});

await t.test("fault matrix: price override authorization failure rolls back financial transaction completely", async () => {
  const fx = createFixture({ failOverrideAuthorization: true });
  try {
    fx.state.priceOverrideAuthorizations["ov-token-fail"] = {
      id: "ov-auth-fail",
      token: "ov-token-fail",
      tokenHash: hashOverrideToken("ov-token-fail"),
      cashierId: managerActor.id,
      productId: "prod-1",
      customerId: null,
      qty: 1,
      originalUnitPrice: 100,
      overrideUnitPrice: 85,
      overrideReason: "Supervisor override",
      isConsumed: false,
      usedAt: null,
      expiresAt: new Date(Date.now() + 3600000),
      consumedAt: null,
      consumedInvoiceId: null,
      createdAt: new Date(),
    };

    const recoveryInput = {
      reference: {
        billNo: "00999-FAIL-OVERRIDE",
        externalDocumentType: "PAN_INVOICE" as const,
        externalBillDate: "2026-10-04",
      },
      reason: "Testing price override update failure rollback",
      paymentAssessment: {
        type: "NOT_COLLECTED" as const,
        explanation: "Unpaid credit bill",
      },
      checkout: {
        items: [
          {
            productId: "prod-1",
            qty: 1,
            overrideUnitPrice: 85,
            overrideReason: "Supervisor override",
            overrideAuthorizationToken: "ov-token-fail",
          },
        ],
        confirmation: {
          payableTotal: 85,
          items: [{ productId: "prod-1", qty: 1, appliedUnitPrice: 85 }],
        },
      },
    };

    await assert.rejects(
      prepareAndPostSaleEvidenceRecovery(fx.state.document.id, recoveryInput, managerActor, capabilities),
      /Simulated price override authorization update failure/,
    );

    // Token remains unconsumed
    assert.equal(fx.state.priceOverrideAuthorizations["ov-token-fail"].isConsumed, false);
    assert.equal(fx.state.products["prod-1"].stock, 50);
  } finally {
    fx.restore();
  }
});

await t.test("fault matrix: unavailable and contradictory lost-commit reconciliation returns UNCERTAIN safely", async () => {
  // Case A: Unavailable posting audit read during reconciliation after lost commit
  const fx1 = createFixture({
    failPostingAfterCommit: true,
    unavailablePostingAuditReconciliation: true,
  });
  try {
    const recoveryInput1 = {
      reference: {
        billNo: "00999-LOST-COMMIT-UNAVAIL",
        externalDocumentType: "PAN_INVOICE" as const,
        externalBillDate: "2026-10-04",
      },
      reason: "Testing lost-commit with unavailable posting audit reconciliation",
      paymentAssessment: {
        type: "CURRENT_DRAWER_CASH" as const,
        drawerId: "drawer-1",
        collectedAt: new Date().toISOString(),
        explanation: "Cash in drawer",
        alreadyAccounted: false as const,
      },
      checkout: {
        items: [{ productId: "prod-1", qty: 1 }],
        payment: {
          method: "CASH" as const,
          amount: 100,
        },
        confirmation: {
          payableTotal: 100,
          items: [{ productId: "prod-1", qty: 1, appliedUnitPrice: 100 }],
        },
      },
    };

    const initialStock = fx1.state.products["prod-1"].stock;
    const initialProofBytes = fs.readFileSync(path.join(storage, "documents", "paper_bill.jpg"));

    // Financial transaction commits, but network fails after commit.
    // Catch-reconciliation attempts verifyRecoveryCommittedProvenance and fails on posting audit read error,
    // so prepareAndPostSaleEvidenceRecovery throws the simulated network disconnect error!
    await assert.rejects(
      prepareAndPostSaleEvidenceRecovery(fx1.state.document.id, recoveryInput1, managerActor, capabilities),
      /Simulated network timeout\/disconnect right after financial posting commit/,
    );

    // Subsequent independent reconciliation via getSaleEvidenceRecoveryOutcome:
    // Preparation audit query succeeds, but posting audit query fails -> returns UNCERTAIN
    const outcome1 = await getSaleEvidenceRecoveryOutcome(
      fx1.state.document.id,
      managerActor,
      capabilities,
    );

    assert.ok(outcome1);
    assert.equal(outcome1.status, "UNCERTAIN");
    assert.equal(outcome1.retryEligible, false);
    assert.ok(
      outcome1.uncertainExplanation?.includes("Failed to query posting audit") ||
      outcome1.uncertainExplanation?.includes("Failed to query"),
    );

    // Assert committed financial state is intact and was NOT rolled back or reposted
    assert.equal(fx1.state.document.saleRecoveryStatus, "ATTACHED");
    assert.equal(fx1.state.document.linkedEntityType, "Invoice");
    assert.ok(fx1.state.document.linkedEntityId);
    assert.equal(fx1.state.products["prod-1"].stock, initialStock - 1);
    assert.equal(fx1.state.stockTransactions.length, 1);

    const committedInvoices = (Object.values(fx1.state.invoices) as any[]).filter((i: any) => i.id !== "inv-existing-1");
    assert.equal(committedInvoices.length, 1, "Exactly one committed invoice in state without repost");
    assert.equal((committedInvoices[0] as any).externalBillNo, "00999-LOST-COMMIT-UNAVAIL");
    assert.equal((committedInvoices[0] as any).status, "FINALIZED");
    assert.equal((committedInvoices[0] as any).billRecordStatus, "RECORDED");

    const committedPayments = Object.values(fx1.state.payments) as any[];
    assert.equal(committedPayments.length, 1);
    assert.equal((committedPayments[0] as any).amount, 100);

    const opKey = fx1.state.document.recoveryCheckoutOperationKey!;
    assert.ok(fx1.state.checkoutOperations[opKey]?.completedAt);

    // Proof file bytes unmodified
    const currentProofBytes = fs.readFileSync(path.join(storage, "documents", "paper_bill.jpg"));
    assert.deepEqual(currentProofBytes, initialProofBytes);
  } finally {
    fx1.restore();
  }

  // Case B: Contradictory audit reconciliation after lost commit
  const fx2 = createFixture({
    failPostingAfterCommit: true,
    contradictoryAuditReconciliation: true,
  });
  try {
    const recoveryInput2 = {
      reference: {
        billNo: "00999-LOST-COMMIT-CONTRADICT",
        externalDocumentType: "PAN_INVOICE" as const,
        externalBillDate: "2026-10-04",
      },
      reason: "Testing lost-commit with contradictory audit reconciliation",
      paymentAssessment: {
        type: "CURRENT_DRAWER_CASH" as const,
        drawerId: "drawer-1",
        collectedAt: new Date().toISOString(),
        explanation: "Cash in drawer",
        alreadyAccounted: false as const,
      },
      checkout: {
        items: [{ productId: "prod-1", qty: 1 }],
        payment: {
          method: "CASH" as const,
          amount: 100,
        },
        confirmation: {
          payableTotal: 100,
          items: [{ productId: "prod-1", qty: 1, appliedUnitPrice: 100 }],
        },
      },
    };

    const initialStock = fx2.state.products["prod-1"].stock;
    const initialProofBytes = fs.readFileSync(path.join(storage, "documents", "paper_bill.jpg"));

    // Financial transaction commits, but post-commit network fails and catch-reconciliation detects contradictory audit
    await assert.rejects(
      prepareAndPostSaleEvidenceRecovery(fx2.state.document.id, recoveryInput2, managerActor, capabilities),
      /Simulated network timeout\/disconnect right after financial posting commit/,
    );

    // Subsequent independent reconciliation via getSaleEvidenceRecoveryOutcome:
    // Preparation audit query succeeds, but posting audit returns contradictory audit -> returns UNCERTAIN
    const outcome2 = await getSaleEvidenceRecoveryOutcome(
      fx2.state.document.id,
      managerActor,
      capabilities,
    );

    assert.ok(outcome2);
    assert.equal(outcome2.status, "UNCERTAIN");
    assert.equal(outcome2.retryEligible, false);
    assert.ok(
      outcome2.uncertainExplanation?.includes("Posting audit") ||
      outcome2.uncertainExplanation?.includes("contradictory") ||
      outcome2.uncertainExplanation?.includes("does not match"),
    );

    // Assert committed financial state is intact and was NOT rolled back or reposted
    assert.equal(fx2.state.document.saleRecoveryStatus, "ATTACHED");
    assert.equal(fx2.state.document.linkedEntityType, "Invoice");
    assert.ok(fx2.state.document.linkedEntityId);
    assert.equal(fx2.state.products["prod-1"].stock, initialStock - 1);
    assert.equal(fx2.state.stockTransactions.length, 1);

    const committedInvoices = (Object.values(fx2.state.invoices) as any[]).filter((i: any) => i.id !== "inv-existing-1");
    assert.equal(committedInvoices.length, 1, "Exactly one committed invoice in state without repost");
    assert.equal((committedInvoices[0] as any).externalBillNo, "00999-LOST-COMMIT-CONTRADICT");

    const committedPayments = Object.values(fx2.state.payments) as any[];
    assert.equal(committedPayments.length, 1);

    const opKey = fx2.state.document.recoveryCheckoutOperationKey!;
    assert.ok(fx2.state.checkoutOperations[opKey]?.completedAt);

    // Proof file bytes unmodified
    const currentProofBytes = fs.readFileSync(path.join(storage, "documents", "paper_bill.jpg"));
    assert.deepEqual(currentProofBytes, initialProofBytes);
  } finally {
    fx2.restore();
  }
});

await t.test("fault matrix: corruptAuditReconciliation during outcome GET returns UNCERTAIN", async () => {
  const fx = createFixture({ corruptAuditReconciliation: true });
  try {
    fx.state.document.recoveryCheckoutOperationKey = "rec_prep_corrupt";
    fx.state.document.recoveryCheckoutPayloadHash = "hash_corrupt";

    const outcome = await getSaleEvidenceRecoveryOutcome(
      fx.state.document.id,
      managerActor,
      capabilities,
    );

    assert.ok(outcome);
    assert.equal(outcome.status, "UNCERTAIN");
    assert.equal(outcome.retryEligible, false);
    assert.ok(outcome.uncertainExplanation);
  } finally {
    fx.restore();
  }
});

await t.test("fault matrix: failure during invoice finalization rolls back financial transaction cleanly", async () => {
  const fx = createFixture({ failDuringFinalization: true });
  try {
    const recoveryInput = {
      reference: {
        billNo: "00999-FAIL-FINALIZE",
        externalDocumentType: "PAN_INVOICE" as const,
        externalBillDate: "2026-10-04",
      },
      reason: "Testing pre-payment finalization failure rollback",
      paymentAssessment: {
        type: "CURRENT_DRAWER_CASH" as const,
        drawerId: "drawer-1",
        collectedAt: new Date().toISOString(),
        explanation: "Cash in drawer",
        alreadyAccounted: false as const,
      },
      checkout: {
        items: [{ productId: "prod-1", qty: 1 }],
        payment: {
          method: "CASH" as const,
          amount: 100,
        },
        confirmation: {
          payableTotal: 100,
          items: [{ productId: "prod-1", qty: 1, appliedUnitPrice: 100 }],
        },
      },
    };

    const initialInvoices = structuredClone(fx.state.invoices);
    const initialPayments = structuredClone(fx.state.payments);
    const initialStock = fx.state.products["prod-1"].stock;

    await assert.rejects(
      prepareAndPostSaleEvidenceRecovery(fx.state.document.id, recoveryInput, managerActor, capabilities),
      /Simulated failure during invoice finalization/,
    );

    // Document retains durable preparation identity
    assert.equal(fx.state.document.saleRecoveryStatus, "UNRESOLVED");
    assert.ok(fx.state.document.recoveryCheckoutOperationKey);
    assert.ok(fx.state.document.recoveryCheckoutPayloadHash);

    // Financial writes rolled back completely
    assert.deepEqual(fx.state.invoices, initialInvoices);
    assert.deepEqual(fx.state.payments, initialPayments);
    assert.equal(fx.state.products["prod-1"].stock, initialStock);
  } finally {
    fx.restore();
  }
});

await t.test("Nepal business day boundary: same Nepal day crossing UTC midnight succeeds", async () => {
  const RealDate = global.Date;
  function setMockDate(isoString: string) {
    const fixedTime = new RealDate(isoString).getTime();
    class MockDate extends RealDate {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(fixedTime);
        } else {
          super(...(args as [any]));
        }
      }
      static now() {
        return fixedTime;
      }
    }
    global.Date = MockDate as any;
  }
  function restoreDate() {
    global.Date = RealDate;
  }

  const fx = createFixture();
  try {
    // Current simulated time: 2026-10-05 02:00:00 UTC = 2026-10-05 07:45:00 NPT (Nepal Day 2026-10-05)
    setMockDate("2026-10-05T02:00:00.000Z");

    // Drawer opened before UTC midnight: 2026-10-04 20:00:00 UTC = 2026-10-05 01:45:00 NPT (Same Nepal Day 2026-10-05)
    fx.state.cashDrawers["drawer-1"].openedAt = new RealDate("2026-10-04T20:00:00.000Z");

    // Collection time after UTC midnight: 2026-10-05 01:00:00 UTC = 2026-10-05 06:45:00 NPT (Same Nepal Day 2026-10-05)
    const recoveryInput = {
      reference: {
        billNo: "00999-NEPAL-UTC-CROSS",
        externalDocumentType: "PAN_INVOICE" as const,
        externalBillDate: "2026-10-05",
      },
      reason: "Testing same Nepal day crossing UTC midnight",
      paymentAssessment: {
        type: "CURRENT_DRAWER_CASH" as const,
        drawerId: "drawer-1",
        collectedAt: "2026-10-05T01:00:00.000Z",
        explanation: "Cash collected in same Nepal day after UTC midnight",
        alreadyAccounted: false as const,
      },
      checkout: {
        items: [{ productId: "prod-1", qty: 1 }],
        payment: {
          method: "CASH" as const,
          amount: 100,
        },
        confirmation: {
          payableTotal: 100,
          items: [{ productId: "prod-1", qty: 1, appliedUnitPrice: 100 }],
        },
      },
    };

    // Both drawer opening and collection are within Nepal Day 2026-10-05 -> Posting succeeds
    const res = await prepareAndPostSaleEvidenceRecovery(
      fx.state.document.id,
      recoveryInput,
      managerActor,
      capabilities,
    );
    assert.equal(res.document.saleRecoveryStatus, "ATTACHED");
    assert.equal(res.invoice.paymentStatus, "PAID");
    assert.equal(res.invoice.netTotal, 100);
  } finally {
    restoreDate();
    fx.restore();
  }
});

await t.test("Nepal business day boundary: previous Nepal day across Nepal midnight is rejected with DRAWER_DAY_MISMATCH and zero financial effects", async () => {
  const RealDate = global.Date;
  function setMockDate(isoString: string) {
    const fixedTime = new RealDate(isoString).getTime();
    class MockDate extends RealDate {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(fixedTime);
        } else {
          super(...(args as [any]));
        }
      }
      static now() {
        return fixedTime;
      }
    }
    global.Date = MockDate as any;
  }
  function restoreDate() {
    global.Date = RealDate;
  }

  const fx = createFixture();
  try {
    // Current simulated time: 2026-10-04 19:00:00 UTC = 2026-10-05 00:45:00 NPT (Nepal Day 2026-10-05, just after Nepal midnight)
    setMockDate("2026-10-04T19:00:00.000Z");

    // Drawer was opened yesterday in Nepal: 2026-10-04 12:00:00 UTC = 2026-10-04 17:45:00 NPT (Nepal Day 2026-10-04)
    fx.state.cashDrawers["drawer-1"].openedAt = new RealDate("2026-10-04T12:00:00.000Z");

    const recoveryInput = {
      reference: {
        billNo: "00999-NEPAL-MIDNIGHT-FAIL",
        externalDocumentType: "PAN_INVOICE" as const,
        externalBillDate: "2026-10-04",
      },
      reason: "Testing drawer across Nepal midnight boundary rejection",
      paymentAssessment: {
        type: "CURRENT_DRAWER_CASH" as const,
        drawerId: "drawer-1",
        collectedAt: "2026-10-04T13:00:00.000Z", // Yesterday Nepal time
        explanation: "Cash from previous Nepal day",
        alreadyAccounted: false as const,
      },
      checkout: {
        items: [{ productId: "prod-1", qty: 1 }],
        payment: {
          method: "CASH" as const,
          amount: 100,
        },
        confirmation: {
          payableTotal: 100,
          items: [{ productId: "prod-1", qty: 1, appliedUnitPrice: 100 }],
        },
      },
    };

    const initialProducts = structuredClone(fx.state.products);
    const initialInvoices = structuredClone(fx.state.invoices);
    const initialPayments = structuredClone(fx.state.payments);
    const initialDrawer = structuredClone(fx.state.cashDrawers["drawer-1"]);

    await assert.rejects(
      prepareAndPostSaleEvidenceRecovery(
        fx.state.document.id,
        recoveryInput,
        managerActor,
        capabilities,
      ),
      (err: any) => {
        assert.equal(err.code, "DRAWER_DAY_MISMATCH");
        assert.equal(err.statusCode, 409);
        return true;
      },
    );

    // Zero financial effects:
    assert.deepEqual(fx.state.products, initialProducts);
    assert.deepEqual(fx.state.invoices, initialInvoices);
    assert.deepEqual(fx.state.payments, initialPayments);
    assert.deepEqual(fx.state.cashDrawers["drawer-1"], initialDrawer);
    assert.equal(fx.state.document.saleRecoveryStatus, "UNRESOLVED");
  } finally {
    restoreDate();
    fx.restore();
  }
});

await t.test("Nepal business day boundary: collection time from previous Nepal day is rejected with INVALID_COLLECTION_TIME and zero financial effects", async () => {
  const RealDate = global.Date;
  function setMockDate(isoString: string) {
    const fixedTime = new RealDate(isoString).getTime();
    class MockDate extends RealDate {
      constructor(...args: any[]) {
        if (args.length === 0) {
          super(fixedTime);
        } else {
          super(...(args as [any]));
        }
      }
      static now() {
        return fixedTime;
      }
    }
    global.Date = MockDate as any;
  }
  function restoreDate() {
    global.Date = RealDate;
  }

  const fx = createFixture();
  try {
    // Current simulated time: 2026-10-05 02:00:00 UTC = 2026-10-05 07:45:00 NPT (Nepal Day 2026-10-05)
    setMockDate("2026-10-05T02:00:00.000Z");

    // Drawer opened today in Nepal: 2026-10-05 01:00:00 UTC = 2026-10-05 06:45:00 NPT (Nepal Day 2026-10-05)
    fx.state.cashDrawers["drawer-1"].openedAt = new RealDate("2026-10-05T01:00:00.000Z");

    // Collection time was from previous Nepal day: 2026-10-04 15:00:00 UTC = 2026-10-04 20:45:00 NPT
    const recoveryInput = {
      reference: {
        billNo: "00999-NEPAL-PREV-COLLECTION",
        externalDocumentType: "PAN_INVOICE" as const,
        externalBillDate: "2026-10-04",
      },
      reason: "Testing collection time from previous Nepal day",
      paymentAssessment: {
        type: "CURRENT_DRAWER_CASH" as const,
        drawerId: "drawer-1",
        collectedAt: "2026-10-04T15:00:00.000Z",
        explanation: "Old cash from yesterday",
        alreadyAccounted: false as const,
      },
      checkout: {
        items: [{ productId: "prod-1", qty: 1 }],
        payment: {
          method: "CASH" as const,
          amount: 100,
        },
        confirmation: {
          payableTotal: 100,
          items: [{ productId: "prod-1", qty: 1, appliedUnitPrice: 100 }],
        },
      },
    };

    const initialProducts = structuredClone(fx.state.products);
    const initialInvoices = structuredClone(fx.state.invoices);
    const initialPayments = structuredClone(fx.state.payments);

    await assert.rejects(
      prepareAndPostSaleEvidenceRecovery(
        fx.state.document.id,
        recoveryInput,
        managerActor,
        capabilities,
      ),
      (err: any) => {
        assert.equal(err.code, "INVALID_COLLECTION_TIME");
        assert.equal(err.statusCode, 409);
        return true;
      },
    );

    // Zero financial writes
    assert.deepEqual(fx.state.products, initialProducts);
    assert.deepEqual(fx.state.invoices, initialInvoices);
    assert.deepEqual(fx.state.payments, initialPayments);
  } finally {
    restoreDate();
    fx.restore();
  }
});
});
