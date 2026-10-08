export type ManualReceiptPayload = {
  method: "FONEPAY" | "BANK_TRANSFER";
  amount: number;
  reference: string;
  status: "SUCCESS";
  receivingAccountId: string;
  receivingAccountVersion: number;
  manualReceiptConfirmed: true;
  manualOperationKey: string;
};

export type ManualPaymentFollowup = {
  actorId: string;
  invoiceId: string;
  payload: ManualReceiptPayload;
};

const PREFIX = "khatasathi:manualReceipt:";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function manualReceiptStorageKey(actorId: string, invoiceId: string) {
  return `${PREFIX}${encodeURIComponent(actorId)}:${encodeURIComponent(invoiceId)}`;
}

function parse(raw: string | null): ManualPaymentFollowup | null {
  try {
    const value = JSON.parse(raw || "null");
    const p = value?.payload;
    if (!value || typeof value.actorId !== "string" || !value.actorId ||
      typeof value.invoiceId !== "string" || !value.invoiceId || !p ||
      !["FONEPAY", "BANK_TRANSFER"].includes(p.method) || p.status !== "SUCCESS" ||
      !Number.isFinite(p.amount) || p.amount <= 0 ||
      typeof p.reference !== "string" || !p.reference.trim() || p.reference.length > 160 ||
      !uuid.test(p.receivingAccountId) || !Number.isInteger(p.receivingAccountVersion) || p.receivingAccountVersion < 1 ||
      p.manualReceiptConfirmed !== true || typeof p.manualOperationKey !== "string" ||
      !/^[A-Za-z0-9_-]{16,120}$/.test(p.manualOperationKey) ||
      Object.keys(p).some((key) => !["method", "amount", "reference", "status", "receivingAccountId", "receivingAccountVersion", "manualReceiptConfirmed", "manualOperationKey"].includes(key))) return null;
    return { actorId: value.actorId, invoiceId: value.invoiceId, payload: p };
  } catch { return null; }
}

export function readManualPaymentFollowups(storage: Storage, actorId: string): ManualPaymentFollowup[] {
  const items: ManualPaymentFollowup[] = [];
  const actorPrefix = `${PREFIX}${encodeURIComponent(actorId)}:`;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(actorPrefix)) continue;
    const item = parse(storage.getItem(key));
    if (item?.actorId === actorId && key === manualReceiptStorageKey(actorId, item.invoiceId)) items.push(item);
  }
  return items;
}

export function retainManualPaymentFollowup(storage: Storage, item: ManualPaymentFollowup): void {
  if (!parse(JSON.stringify(item))) throw new Error("Invalid manual receipt request");
  const key = manualReceiptStorageKey(item.actorId, item.invoiceId);
  const existing = storage.getItem(key);
  if (existing !== null && existing !== JSON.stringify(item)) throw new Error("A different receipt request is already unresolved for this invoice");
  storage.setItem(key, JSON.stringify(item));
  if (storage.getItem(key) !== JSON.stringify(item)) throw new Error("Receipt recovery could not be retained. No payment was sent.");
}

export function clearMatchingManualPaymentFollowup(storage: Storage, item: ManualPaymentFollowup): boolean {
  const key = manualReceiptStorageKey(item.actorId, item.invoiceId);
  if (storage.getItem(key) !== JSON.stringify(item)) return false;
  storage.removeItem(key);
  return true;
}
