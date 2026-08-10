import type {
  ProductLookupEditHandoff,
  ProductLookupSnapshot,
} from "./products.types";

type TimedValue<T> = {
  value: T;
  expiresAt: number;
};

const HANDOFF_TTL_MS = 5 * 60 * 1000;
const editHandoffs = new Map<string, TimedValue<ProductLookupEditHandoff>>();
const restoreHandoffs = new Map<string, TimedValue<ProductLookupSnapshot>>();

function newHandoffKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function pruneExpired<T>(store: Map<string, TimedValue<T>>) {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
}

export function stageProductLookupEdit(handoff: ProductLookupEditHandoff) {
  pruneExpired(editHandoffs);
  const key = newHandoffKey();
  editHandoffs.set(key, {
    value: handoff,
    expiresAt: Date.now() + HANDOFF_TTL_MS,
  });
  return key;
}

export function readProductLookupEdit(
  key: string | undefined,
  productId: string | null,
) {
  if (!key || !productId) return undefined;
  const entry = editHandoffs.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    editHandoffs.delete(key);
    return undefined;
  }
  return entry.value.product.id === productId ? entry.value : undefined;
}

export function stageProductLookupRestore(snapshot: ProductLookupSnapshot) {
  pruneExpired(restoreHandoffs);
  const key = newHandoffKey();
  restoreHandoffs.set(key, {
    value: snapshot,
    expiresAt: Date.now() + HANDOFF_TTL_MS,
  });
  return key;
}

export function readProductLookupRestore(key: string | undefined) {
  if (!key) return undefined;
  const entry = restoreHandoffs.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    restoreHandoffs.delete(key);
    return undefined;
  }
  return entry.value;
}
