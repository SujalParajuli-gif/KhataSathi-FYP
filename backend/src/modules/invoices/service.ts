import { createHash, randomBytes } from "crypto";
import { Prisma } from "@prisma/client";
import {
  buildBusinessDateRange,
  toBusinessClock,
} from "../../lib/businessDate";
import prisma from "../../db/prisma";
import {
  assertCashierOverrideAllowed,
  getBusinessSettings,
  resolveWholesaleQtyThreshold,
} from "../settings/service";
import { createEsewaPaymentIntentTx } from "../payments/service";
import {
  buildInsufficientStockMessage,
  buildStockConflict,
  type StockConflict,
  StockConflictError,
} from "./stockConflicts";

export { StockConflictError } from "./stockConflicts";

const MAX_CREATE_DRAFT_RETRIES = 5; // retry limit for when the auto-generated invoice number collides with an existing one
const ACTIVE_RETURN_STATUSES = ["PENDING", "APPROVED"] as const;
const PRICE_OVERRIDE_AUTH_TTL_MS = 5 * 60 * 1000;

// we use this to round any currency value to 2 decimal places
// without this, JavaScript floating point math can produce results like 10.0000000001
// and when we compare totals later (like checking if paidTotal equals netTotal), those tiny
// differences cause the comparison to fail even though they should be equal
function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}

export function buildActiveReturnBlockMessage(
  actionLabel: string,
  status: string,
) {
  const normalizedStatus = String(status || "active").toLowerCase();
  const article = /^[aeiou]/i.test(normalizedStatus) ? "an" : "a";
  return `Cannot ${actionLabel} because this invoice has ${article} ${normalizedStatus} return/refund request. Finish or reject returns before changing the invoice.`;
}

async function assertNoActiveReturnRequestsTx(
  tx: any,
  invoiceId: string,
  actionLabel: string,
) {
  const activeReturn = await tx.returnRequest.findFirst({
    where: {
      invoiceId,
      status: { in: ACTIVE_RETURN_STATUSES },
    },
    select: {
      id: true,
      status: true,
    },
  });

  if (activeReturn) {
    throw new Error(
      buildActiveReturnBlockMessage(actionLabel, activeReturn.status),
    );
  }
}

// this makes sure a discount percent stays within the valid range of 0 to 100
// customer fields like loyaltyPercent and wholesalePercent are optional in our database,
// so they can be null or undefined — we handle that here by defaulting to 0
function clampPercent(value?: number | null) {
  const normalized = Number(value || 0);
  if (!Number.isFinite(normalized)) return 0;
  if (normalized < 0) return 0; // negative discounts are not valid
  if (normalized > 100) return 100; // discount cannot go above 100%
  return normalized;
}

// we use this to validate that quantities are whole numbers and at least 1
// this runs before any cart or invoice item operation to make sure invalid data
// like 0, negative numbers, or decimals never reach the database
function normalizePositiveInteger(value: number, label: string) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1) {
    throw new Error(`${label} must be a whole number greater than 0`);
  }
  return normalized;
}

function normalizePositiveQuantity(value: number, label: string) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`${label} must be greater than 0`);
  }
  return Math.round(normalized * 1000) / 1000;
}

function isQuantityStepAligned(qty: number, step?: number | null) {
  const normalizedStep = Number(step || 1);
  if (!Number.isFinite(normalizedStep) || normalizedStep <= 0) return true;
  const ratio = qty / normalizedStep;
  return Math.abs(ratio - Math.round(ratio)) < 0.000001;
}

function assertProductQuantityAllowed(product: any, qty: number) {
  if (!product.allowFractionalQty && !Number.isInteger(qty)) {
    throw new Error(`Quantity for "${product.name}" must be a whole number.`);
  }

  if (!isQuantityStepAligned(qty, product.quantityStep)) {
    throw new Error(
      `Quantity for "${product.name}" must use steps of ${product.quantityStep || 1}.`,
    );
  }
}

// normalizing the discount amount — if the frontend sent a manual discount, we use that
// otherwise we fall back to the auto-computed discount from customer percentages
// we also cap the discount at the subtotal so it never exceeds the total bill
function normalizeDiscountAmount(
  discountAmount: number | undefined,
  subTotal: number,
  fallbackDiscount: number,
) {
  if (discountAmount === undefined) {
    return fallbackDiscount; // no manual discount was sent, using the auto-computed one
  }

  const normalized = Number(discountAmount);
  if (!Number.isFinite(normalized)) {
    throw new Error("Discount amount must be a valid number");
  }

  if (normalized < 0) {
    throw new Error("Discount amount cannot be negative");
  }

  return Math.min(subTotal, roundCurrency(normalized)); // capping at subtotal to prevent negative totals
}

// checking if a Prisma error is a unique constraint violation on the invoiceNo field
// we use this to detect when our generated invoice number collides with an existing one
// so we can retry with a new number instead of crashing
function isInvoiceNoConflict(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }

  if (error.code !== "P2002") {
    return false; // P2002 is Prisma's unique constraint violation error code
  }

  // checking if the violation is specifically on the invoiceNo field
  const target = Array.isArray(error.meta?.target)
    ? error.meta?.target
    : typeof error.meta?.target === "string"
      ? [error.meta.target]
      : [];

  return (
    target.includes("invoiceNo") ||
    target.some((value) => String(value).includes("invoiceNo")) ||
    error.message.includes("invoiceNo")
  );
}

// determining which subtotal discount applies for a given customer
// wholesale percent takes priority over loyalty — they cannot be used together
// if neither is set, no discount is applied
function resolveSubtotalDiscountPercent(customer?: {
  loyaltyPercent?: number | null;
  wholesalePercent?: number | null;
} | null) {
  const wholesalePercent = clampPercent(customer?.wholesalePercent);
  if (wholesalePercent > 0) {
    return {
      percent: wholesalePercent,
      source: "CUSTOMER_WHOLESALE" as const, // wholesale percent was set by admin on this customer
    };
  }

  const loyaltyPercent = clampPercent(customer?.loyaltyPercent);
  if (loyaltyPercent > 0) {
    return {
      percent: loyaltyPercent,
      source: "LOYALTY" as const,
    };
  }

  return {
    percent: 0,
    source: "NONE" as const, // no discount applies for this customer
  };
}

// wholesale pricing has two modes that cannot both be active at the same time:
// 1. customer-level wholesale % — admin assigns a discount percent to the customer,
//    this is applied on the subtotal and it disables qty-based pricing entirely
// 2. qty-based wholesale — the product switches from retail to wholesale price
//    when the quantity in the cart meets or exceeds the product's threshold
// this function only handles case 2, and it returns false when case 1 is active
// because both modes applying together would give a double discount
function shouldUseQuantityWholesalePrice(
  customer: { wholesalePercent?: number | null } | null | undefined,
  qty: number,
  threshold?: number | null,
  wholesaleEligible = true,
) {
  if (!wholesaleEligible) return false;

  // checking if this customer already has a wholesale percent set by the admin
  // when this is active, we skip qty-based pricing because the two modes do not stack
  if (clampPercent(customer?.wholesalePercent) > 0) {
    return false;
  }

  // if no threshold is set on the product, it defaults to 1
  // meaning wholesale price applies starting from quantity 1 and above
  return qty >= Math.max(1, Number(threshold || 1));
}

// --

// generating invoice numbers in the format INV-YYYYMMDD-0001
// the date part uses Nepal business time instead of UTC, so the number
// matches the actual business day the cashier is working in
// we increment one database counter per business day, so concurrent cashiers cannot receive the same number
async function generateInvoiceNo(tx?: any) {
  const client = tx || prisma;
  const now = toBusinessClock(new Date());
  const dateStr =
    now.getUTCFullYear().toString() +
    String(now.getUTCMonth() + 1).padStart(2, "0") +
    String(now.getUTCDate()).padStart(2, "0");
  const prefix = `INV-${dateStr}-`;

  const latest = await client.invoice.findFirst({
    where: { invoiceNo: { startsWith: prefix } },
    orderBy: { invoiceNo: "desc" },
    select: { invoiceNo: true },
  });

  let initialSequence = 1;
  if (latest?.invoiceNo) {
    const parsed = parseInt(latest.invoiceNo.slice(prefix.length), 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      initialSequence = parsed + 1;
    }
  }

  const counter = await client.invoiceSequence.upsert({
    where: { businessDate: dateStr },
    create: { businessDate: dateStr, lastNumber: initialSequence },
    update: { lastNumber: { increment: 1 } },
    select: { lastNumber: true },
  });

  return `${prefix}${String(counter.lastNumber).padStart(4, "0")}`;
}

async function generateParkedDraftNo(tx?: any) {
  const client = tx || prisma;
  const now = toBusinessClock(new Date());
  const dateStr =
    now.getUTCFullYear().toString() +
    String(now.getUTCMonth() + 1).padStart(2, "0") +
    String(now.getUTCDate()).padStart(2, "0");

  for (let attempt = 0; attempt < MAX_CREATE_DRAFT_RETRIES; attempt += 1) {
    const draftNo = `PARKED-${dateStr}-${randomBytes(4)
      .toString("hex")
      .toUpperCase()}`;
    const existing = await client.invoice.findUnique({
      where: { invoiceNo: draftNo },
      select: { id: true },
    });

    if (!existing) return draftNo;
  }

  throw new Error("Could not create a unique parked draft number. Please try again.");
}

export function shouldAssignFinalInvoiceNo(invoiceNo: string) {
  return String(invoiceNo || "").startsWith("PARKED-");
}

async function generateCreditNoteNo(tx?: any) {
  const client = tx || prisma;
  const now = toBusinessClock(new Date());
  const dateStr =
    now.getUTCFullYear().toString() +
    String(now.getUTCMonth() + 1).padStart(2, "0") +
    String(now.getUTCDate()).padStart(2, "0");
  const prefix = `CN-${dateStr}-`;

  const latest = await client.creditNote.findFirst({
    where: { creditNoteNo: { startsWith: prefix } },
    orderBy: { creditNoteNo: "desc" },
    select: { creditNoteNo: true },
  });

  let initialSequence = 1;
  if (latest?.creditNoteNo) {
    const parsed = parseInt(latest.creditNoteNo.slice(prefix.length), 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      initialSequence = parsed + 1;
    }
  }

  const counter = await client.creditNoteSequence.upsert({
    where: { businessDate: dateStr },
    create: { businessDate: dateStr, lastNumber: initialSequence },
    update: { lastNumber: { increment: 1 } },
    select: { lastNumber: true },
  });

  return `${prefix}${String(counter.lastNumber).padStart(4, "0")}`;
}

async function legacyGenerateInvoiceNo(tx?: any) {
  const client = tx || prisma;
  const now = toBusinessClock(new Date()); // converting current time to Nepal timezone
  const dateStr =
    now.getUTCFullYear().toString() +
    String(now.getUTCMonth() + 1).padStart(2, "0") +
    String(now.getUTCDate()).padStart(2, "0");

  const prefix = `INV-${dateStr}-`;

  // finding the latest invoice for today by sorting descending — this gives us the highest sequence number
  // using the transaction client ensures we read inside the same isolation context as the insert
  const latest = await client.invoice.findFirst({
    where: { invoiceNo: { startsWith: prefix } },
    orderBy: { invoiceNo: "desc" },
    select: { invoiceNo: true },
  });

  let nextSequence = 1;
  if (latest?.invoiceNo) {
    // extracting the numeric suffix from the last invoice number (e.g., "INV-20260611-0003" → 3)
    const lastSuffix = latest.invoiceNo.slice(prefix.length);
    const parsed = parseInt(lastSuffix, 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      nextSequence = parsed + 1;
    }
  }

  return `${prefix}${String(nextSequence).padStart(4, "0")}`;
}

// recalculating the invoice subtotal by summing all line item totals
// we call this after every item add, update, or remove so the invoice subtotal stays accurate
// accepts an optional transaction client so it can run inside the same transaction as item operations
async function recomputeSubtotal(invoiceId: string, tx?: any) {
  const client = tx || prisma;
  const items = await client.invoiceItem.findMany({ where: { invoiceId } });
  const subTotal = roundCurrency(
    items.reduce((sum, item) => sum + item.lineTotal, 0),
  );

  await client.invoice.update({ where: { id: invoiceId }, data: { subTotal } });
}

// --

// creating a new draft invoice for a cashier
// we wrap the number generation and invoice creation inside a single transaction
// so that the invoice number lookup and insert happen atomically — preventing collisions
// we still retry up to 5 times as a safety net in case of extremely rare conflicts
export async function createDraft(cashierId: string, customerId?: string) {
  for (let attempt = 0; attempt < MAX_CREATE_DRAFT_RETRIES; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const invoiceNo = await generateInvoiceNo(tx);

        return tx.invoice.create({
          data: {
            invoiceNo,
            status: "DRAFT",
            cashierId,
            customerId: customerId || null, // customer is optional — can be linked later
          },
          include: {
            items: { include: { product: true } },
            payments: true,
            customer: true,
          },
        });
      });
    } catch (error) {
      // if the error is a duplicate invoiceNo and we still have retries left, try again with a new number
      if (isInvoiceNoConflict(error) && attempt < MAX_CREATE_DRAFT_RETRIES - 1) {
        continue;
      }
      throw error; // if it is a different error or we ran out of retries, let it fail
    }
  }

  throw new Error("Could not create a unique invoice number. Please try again.");
}

type CheckoutItemInput = {
  productId: string;
  qty: number;
  overrideUnitPrice?: number | null;
  overrideReason?: string | null;
  overrideAuthorizationToken?: string | null;
};

type CheckoutPaymentInput = {
  method?: "CASH" | "ESEWA" | "NONE";
  amount?: number;
  reference?: string;
  tenderedAmount?: number;
};

type CheckoutInput = {
  draftInvoiceId?: string | null;
  customerId?: string | null;
  discountAmount?: number;
  overridePin?: string | null;
  notes?: string | null;
  items: CheckoutItemInput[];
  payment?: CheckoutPaymentInput | null;
  payments?: CheckoutPaymentInput[] | null;
};

type ParkDraftInput = {
  replaceDraftInvoiceId?: string | null;
  customerId?: string | null;
  label?: string | null;
  items: CheckoutItemInput[];
};

type ModifyFinalizedInvoiceInput = {
  customerId?: string | null;
  discountAmount?: number;
  overridePin?: string | null;
  reason?: string | null;
  items: CheckoutItemInput[];
};

function normalizeParkedLabel(value?: string | null) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  return normalized.slice(0, 80);
}

function normalizeInvoiceNotes(value?: string | null) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  return normalized.slice(0, 1000);
}

function normalizeOverrideReason(value?: string | null) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  return normalized.slice(0, 240);
}

function normalizeOverrideUnitPrice(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;

  const normalized = roundCurrency(Number(value));
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error("Override price must be greater than zero");
  }

  if (normalized > 10_000_000) {
    throw new Error("Override price is too high");
  }

  return normalized;
}

function normalizeCheckoutItems(items: CheckoutItemInput[]) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Checkout requires at least one item");
  }

  const merged = new Map<
    string,
    {
      productId: string;
      qty: number;
      overrideUnitPrice?: number;
      overrideReason?: string | null;
      overrideAuthorizationToken?: string | null;
    }
  >();
  for (const rawItem of items) {
    const productId = String(rawItem?.productId || "").trim();
    if (!productId) {
      throw new Error("productId is required for every checkout item");
    }

    const qty = normalizePositiveQuantity(Number(rawItem?.qty), "qty");
    const overrideUnitPrice = normalizeOverrideUnitPrice(
      rawItem?.overrideUnitPrice,
    );
    const overrideReason = normalizeOverrideReason(rawItem?.overrideReason);
    const overrideAuthorizationToken =
      typeof rawItem?.overrideAuthorizationToken === "string"
        ? rawItem.overrideAuthorizationToken.trim()
        : undefined;
    if (overrideUnitPrice !== undefined && !overrideReason) {
      throw new Error("Override reason is required when changing item price");
    }

    const existing = merged.get(productId);
    if (!existing) {
      merged.set(productId, {
        productId,
        qty,
        overrideUnitPrice,
        overrideReason,
        overrideAuthorizationToken,
      });
      continue;
    }

    if (
      existing.overrideUnitPrice !== overrideUnitPrice ||
      (existing.overrideReason || null) !== (overrideReason || null) ||
      (existing.overrideAuthorizationToken || null) !==
        (overrideAuthorizationToken || null)
    ) {
      throw new Error(
        "Duplicate checkout item overrides must use the same override price and reason",
      );
    }

    existing.qty = normalizePositiveQuantity(existing.qty + qty, "qty");
  }

  return Array.from(merged.values());
}

function hashOverrideToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function assertPricesMatch(left: number, right: number, label: string) {
  if (Math.abs(roundCurrency(left) - roundCurrency(right)) > 0.001) {
    throw new Error(`${label} no longer matches the verified override`);
  }
}

async function resolveOriginalUnitPriceForOverride(
  product: any,
  customerId?: string | null,
) {
  const settings = await getBusinessSettings();
  const customer = customerId
    ? await prisma.customer.findUnique({
        where: { id: customerId },
        select: {
          id: true,
          isActive: true,
          loyaltyPercent: true,
          wholesalePercent: true,
        },
      })
    : null;

  if (customerId && (!customer || !customer.isActive)) {
    throw new Error("Customer not found");
  }

  return {
    customer,
    settings,
  };
}

export async function createPriceOverrideAuthorization(
  cashierId: string,
  data: {
    productId?: string;
    customerId?: string | null;
    qty?: number;
    overrideUnitPrice?: number;
    overrideReason?: string | null;
    pin?: string | null;
  },
) {
  const productId = String(data.productId || "").trim();
  if (!productId) throw new Error("Product is required for price override");

  const qty = normalizePositiveQuantity(Number(data.qty), "qty");
  const overrideUnitPrice = normalizeOverrideUnitPrice(data.overrideUnitPrice);
  if (overrideUnitPrice === undefined) {
    throw new Error("Override price must be greater than zero");
  }
  const overrideReason = normalizeOverrideReason(data.overrideReason);
  if (!overrideReason) {
    throw new Error("Override reason is required when changing item price");
  }

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product || !product.isActive) {
    throw new Error("Product not found or inactive");
  }
  assertProductQuantityAllowed(product, qty);

  const { customer, settings } = await resolveOriginalUnitPriceForOverride(
    product,
    data.customerId,
  );
  const originalUnitPrice = roundCurrency(
    shouldUseQuantityWholesalePrice(
      customer,
      qty,
      resolveWholesaleQtyThreshold(product, settings),
      product.wholesaleEligible,
    )
      ? product.wholesalePrice
      : product.retailPrice,
  );

  if (Math.abs(overrideUnitPrice - originalUnitPrice) < 0.001) {
    throw new Error("Price matches the normal rate. No override is needed.");
  }

  await assertCashierOverrideAllowed(cashierId, "PRICE_OVERRIDE", data.pin);

  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PRICE_OVERRIDE_AUTH_TTL_MS);

  await prisma.priceOverrideAuthorization.create({
    data: {
      tokenHash: hashOverrideToken(token),
      cashierId,
      productId,
      customerId: data.customerId || null,
      qty,
      originalUnitPrice,
      overrideUnitPrice,
      overrideReason,
      expiresAt,
    },
  });

  return {
    token,
    expiresAt,
    productId,
    qty,
    originalUnitPrice,
    overrideUnitPrice,
    overrideReason,
  };
}

function normalizeCheckoutPayment(payment?: CheckoutPaymentInput | null) {
  if (!payment || !payment.method || payment.method === "NONE") {
    return { method: "NONE" as const };
  }

  if (payment.method !== "CASH" && payment.method !== "ESEWA") {
    throw new Error("payment.method must be CASH, ESEWA, or NONE");
  }

  const amount = roundCurrency(Number(payment.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Payment amount must be greater than zero");
  }

  const tenderedAmount =
    payment.tenderedAmount === undefined ||
    payment.tenderedAmount === null
      ? undefined
      : roundCurrency(Number(payment.tenderedAmount));

  if (tenderedAmount !== undefined) {
    if (payment.method !== "CASH") {
      throw new Error("Tendered amount only applies to cash payments");
    }
    if (!Number.isFinite(tenderedAmount) || tenderedAmount < amount) {
      throw new Error("Cash tendered cannot be less than the cash amount");
    }
  }

  return {
    method: payment.method,
    amount,
    reference: payment.reference?.trim() || undefined,
    tenderedAmount,
  };
}

function normalizeCheckoutPayments(input: CheckoutInput) {
  const rawPayments = Array.isArray(input.payments)
    ? input.payments
    : input.payment
      ? [input.payment]
      : [];

  const normalized = rawPayments
    .map((payment) => normalizeCheckoutPayment(payment))
    .filter((payment) => payment.method !== "NONE");

  const esewaCount = normalized.filter(
    (payment) => payment.method === "ESEWA",
  ).length;
  if (esewaCount > 1) {
    throw new Error("Only one eSewa payment can be created during checkout");
  }

  return normalized;
}

async function validateCheckoutProductsTx(
  tx: any,
  checkoutItems: Array<{ productId: string; qty: number }>,
  ownReservedQtyByProduct = new Map<string, number>(),
) {
  const productIds = checkoutItems.map((line) => line.productId);
  const products = await tx.product.findMany({
    where: { id: { in: productIds } },
  });
  const productsById = new Map<string, any>(
    products.map((product: any) => [product.id, product]),
  );
  const conflicts: StockConflict[] = [];

  for (const line of checkoutItems) {
    const product = productsById.get(line.productId);

    if (!product) {
      conflicts.push(
        buildStockConflict({
          productId: line.productId,
          productName: "Unknown product",
          requestedQty: line.qty,
          availableStock: 0,
          reason: "NOT_FOUND",
        }),
      );
      continue;
    }

    if (!product.isActive) {
      conflicts.push(
        buildStockConflict({
          productId: line.productId,
          productName: product.name,
          sku: product.sku,
          barcode: product.barcode,
          requestedQty: line.qty,
          availableStock: 0,
          reason: "INACTIVE",
        }),
      );
      continue;
    }

    assertProductQuantityAllowed(product, line.qty);

    const availableStock = getAvailableStock(
      product,
      ownReservedQtyByProduct.get(line.productId) || 0,
    );

    if (availableStock <= 0) {
      conflicts.push(
        buildStockConflict({
          productId: line.productId,
          productName: product.name,
          sku: product.sku,
          barcode: product.barcode,
          requestedQty: line.qty,
          availableStock: 0,
          reason: "OUT_OF_STOCK",
        }),
      );
      continue;
    }

    if (line.qty > availableStock) {
      conflicts.push(
        buildStockConflict({
          productId: line.productId,
          productName: product.name,
          sku: product.sku,
          barcode: product.barcode,
          requestedQty: line.qty,
          availableStock,
          reason: "INSUFFICIENT_STOCK",
        }),
      );
    }
  }

  if (conflicts.length > 0) {
    throw new StockConflictError(conflicts);
  }

  return productsById;
}

async function consumePriceOverrideAuthorizationTx(
  tx: any,
  data: {
    cashierId: string;
    invoiceId: string;
    customerId: string | null;
    productId: string;
    qty: number;
    originalUnitPrice: number;
    overrideUnitPrice: number;
    overrideReason: string;
    token?: string | null;
  },
) {
  const token = String(data.token || "").trim();
  if (!token) {
    throw new Error("Verify the override PIN before changing this item price.");
  }

  const authorization = await tx.priceOverrideAuthorization.findUnique({
    where: { tokenHash: hashOverrideToken(token) },
  });

  if (!authorization) {
    throw new Error("Price override verification was not found.");
  }
  if (authorization.cashierId !== data.cashierId) {
    throw new Error("Price override verification belongs to another cashier.");
  }
  if (authorization.productId !== data.productId) {
    throw new Error("Price override verification belongs to another product.");
  }
  if ((authorization.customerId || null) !== (data.customerId || null)) {
    throw new Error("Customer changed after price override verification.");
  }
  if (authorization.usedAt) {
    throw new Error("Price override verification was already used.");
  }
  if (authorization.expiresAt.getTime() < Date.now()) {
    throw new Error("Price override verification expired. Enter PIN again.");
  }

  assertPricesMatch(authorization.qty, data.qty, "Quantity");
  assertPricesMatch(
    authorization.originalUnitPrice,
    data.originalUnitPrice,
    "Original price",
  );
  assertPricesMatch(
    authorization.overrideUnitPrice,
    data.overrideUnitPrice,
    "Override price",
  );

  if (authorization.overrideReason !== data.overrideReason) {
    throw new Error("Override reason no longer matches the verified override.");
  }

  await tx.priceOverrideAuthorization.update({
    where: { id: authorization.id },
    data: {
      usedAt: new Date(),
      usedInvoiceId: data.invoiceId,
    },
  });
}

function getAvailableStock(
  product: { stock?: number | null; reservedStock?: number | null },
  ownReservedQty = 0,
) {
  return Math.max(
    0,
    Number(product.stock || 0) -
      Math.max(0, Number(product.reservedStock || 0)) +
      Math.max(0, Number(ownReservedQty || 0)),
  );
}

function buildReservedQtyByProduct(
  items: Array<{ productId: string; qty: number }>,
) {
  const reserved = new Map<string, number>();
  for (const item of items) {
    reserved.set(item.productId, (reserved.get(item.productId) || 0) + item.qty);
  }
  return reserved;
}

async function adjustReservedStockTx(
  tx: any,
  items: Array<{ productId: string; qty: number }>,
  direction: "reserve" | "release",
) {
  for (const [productId, qty] of buildReservedQtyByProduct(items)) {
    if (qty <= 0) continue;
    await tx.product.update({
      where: { id: productId },
      data: {
        reservedStock:
          direction === "reserve"
            ? { increment: qty }
            : { decrement: qty },
      },
    });
  }
}

async function finalizeCheckoutInvoiceTx(
  tx: any,
  invoiceId: string,
  userId: string,
  discountAmount?: number,
  overridePin?: string | null,
) {
  const invoice = await tx.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      items: { include: { product: true } },
      customer: true,
    },
  });

  if (!invoice) throw new Error("Invoice not found");
  if (invoice.status !== "DRAFT") throw new Error("Invoice is already finalized");
  if (invoice.items.length === 0) throw new Error("Cannot finalize an empty invoice");

  const subTotal = roundCurrency(
    invoice.items.reduce((sum: number, item: any) => sum + item.lineTotal, 0),
  );
  const resolvedDiscount = resolveSubtotalDiscountPercent(invoice.customer);
  const computedDiscount = roundCurrency(
    (subTotal * resolvedDiscount.percent) / 100,
  );
  const normalizedDiscount = normalizeDiscountAmount(
    discountAmount,
    subTotal,
    computedDiscount,
  );
  const appliedDiscountPercent =
    subTotal > 0 ? roundCurrency((normalizedDiscount / subTotal) * 100) : 0;
  const netTotal = roundCurrency(subTotal - normalizedDiscount);
  const isManualDiscountOverride =
    Math.abs(normalizedDiscount - computedDiscount) > 0.001;

  const actor = await tx.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, role: true },
  });

  if (isManualDiscountOverride) {
    await assertCashierOverrideAllowed(
      userId,
      "MANUAL_DISCOUNT",
      overridePin,
      tx,
    );
  }

  for (const item of invoice.items) {
    const updated = await tx.product.updateMany({
      where: {
        id: item.productId,
        stock: { gte: item.qty },
      },
      data: { stock: { decrement: item.qty } },
    });

    if (updated.count === 0) {
      const latestProduct = await tx.product.findUnique({
        where: { id: item.productId },
        select: { name: true, stock: true },
      });

      throw new StockConflictError([
        buildStockConflict({
          productId: item.productId,
          productName: latestProduct?.name || item.product.name,
          requestedQty: item.qty,
          availableStock: latestProduct?.stock ?? 0,
          reason:
            (latestProduct?.stock ?? 0) <= 0
              ? "OUT_OF_STOCK"
              : "INSUFFICIENT_STOCK",
        }),
      ]);
    }

    await tx.stockTransaction.create({
      data: {
        productId: item.productId,
        type: "SALE",
        qtyDelta: -item.qty,
        reason: `Sale via invoice ${invoice.invoiceNo}`,
        refInvoiceId: invoiceId,
        createdById: userId,
      },
    });
  }

  const finalized = await tx.invoice.update({
    where: { id: invoiceId },
    data: {
      status: "FINALIZED",
      subTotal,
      loyaltyDiscountPercent: appliedDiscountPercent,
      loyaltyDiscountAmount: normalizedDiscount,
      netTotal,
      paidTotal: 0,
      paymentStatus: netTotal <= 0 ? "PAID" : "UNPAID",
      finalizedAt: new Date(),
    },
    include: { payments: true },
  });

  await tx.auditLog.create({
    data: {
      actorId: userId,
      action: "INVOICE_FINALIZED",
      entityType: "Invoice",
      entityId: invoiceId,
      meta: {
        invoiceNo: invoice.invoiceNo,
        actorName: actor?.name || null,
        actorRole: actor?.role || null,
        subTotal,
        discountAmount: normalizedDiscount,
        discountPercent: appliedDiscountPercent,
        discountSource: resolvedDiscount.source,
        netTotal,
        itemCount: invoice.items.length,
        autoMarkedPaid: netTotal <= 0,
      },
    },
  });

  if (isManualDiscountOverride) {
    await tx.auditLog.create({
      data: {
        actorId: userId,
        action: "CASHIER_MANUAL_DISCOUNT_APPLIED",
        entityType: "Invoice",
        entityId: invoiceId,
        meta: {
          invoiceNo: invoice.invoiceNo,
          actorName: actor?.name || null,
          actorRole: actor?.role || null,
          subTotal,
          automaticDiscountAmount: computedDiscount,
          manualDiscountAmount: normalizedDiscount,
          discountDifference: roundCurrency(
            normalizedDiscount - computedDiscount,
          ),
          discountPercent: appliedDiscountPercent,
          netTotal,
        },
      },
    });
  }

  return finalized;
}

async function recordCheckoutCashPaymentTx(
  tx: any,
  invoice: {
    id: string;
    invoiceNo: string;
    paymentStatus: string;
    netTotal: number;
    paidTotal?: number;
  },
  amount: number,
  createdById: string,
  reference?: string,
  tenderedAmount?: number,
) {
  const normalizedAmount = roundCurrency(amount);
  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
    throw new Error("Payment amount must be greater than zero");
  }
  if (invoice.netTotal <= 0) {
    throw new Error("Zero-total invoice does not need a payment");
  }
  const currentPaid = roundCurrency(Number(invoice.paidTotal || 0));
  if (currentPaid + normalizedAmount > invoice.netTotal) {
    throw new Error(
      `Overpayment! Current paid: Rs ${currentPaid}, new: Rs ${normalizedAmount}, net total: Rs ${invoice.netTotal}. Max allowed: Rs ${roundCurrency(invoice.netTotal - currentPaid)}`,
    );
  }

  const normalizedTendered =
    tenderedAmount === undefined || tenderedAmount === null
      ? null
      : roundCurrency(Number(tenderedAmount));
  if (normalizedTendered !== null) {
    if (!Number.isFinite(normalizedTendered) || normalizedTendered < normalizedAmount) {
      throw new Error("Cash tendered cannot be less than the cash amount");
    }
  }
  const changeAmount =
    normalizedTendered === null
      ? null
      : roundCurrency(normalizedTendered - normalizedAmount);

  const actor = await tx.user.findUnique({
    where: { id: createdById },
    select: { id: true, name: true, role: true },
  });
  const nextPaymentStatus =
    currentPaid + normalizedAmount >= invoice.netTotal
      ? "PAID"
      : "PARTIALLY_PAID";

  await tx.payment.create({
    data: {
      invoiceId: invoice.id,
      method: "CASH",
      amount: normalizedAmount,
      cashTendered: normalizedTendered,
      changeAmount,
      status: "SUCCESS",
      reference: reference || null,
      createdById,
    },
  });

  await tx.invoice.update({
    where: { id: invoice.id },
    data: {
      paidTotal: roundCurrency(currentPaid + normalizedAmount),
      paymentStatus: nextPaymentStatus,
    },
  });

  await tx.auditLog.create({
    data: {
      actorId: createdById,
      action: "INVOICE_PAYMENT_UPDATED",
      entityType: "Invoice",
      entityId: invoice.id,
      meta: {
        invoiceNo: invoice.invoiceNo,
        actorName: actor?.name || null,
        actorRole: actor?.role || null,
        method: "CASH",
        reference: reference || null,
        amountAdded: normalizedAmount,
        cashTendered: normalizedTendered,
        changeAmount,
        previousStatus: invoice.paymentStatus,
        nextStatus: nextPaymentStatus,
        paidTotal: roundCurrency(currentPaid + normalizedAmount),
        netTotal: invoice.netTotal,
        remainingDue: roundCurrency(
          Math.max(0, invoice.netTotal - currentPaid - normalizedAmount),
        ),
      },
    },
  });
}

async function prepareCheckoutInvoiceTx(
  tx: any,
  cashierId: string,
  input: CheckoutInput,
  customerId: string | null,
) {
  const draftInvoiceId = String(input.draftInvoiceId || "").trim();
  const notes = normalizeInvoiceNotes(input.notes);

  if (!draftInvoiceId) {
    const invoiceNo = await generateInvoiceNo(tx);
    return tx.invoice.create({
      data: {
        invoiceNo,
        status: "DRAFT",
        cashierId,
        customerId,
        notes,
      },
    });
  }

  const existingDraft = await tx.invoice.findUnique({
    where: { id: draftInvoiceId },
    include: { items: true },
  });

  if (!existingDraft) throw new Error("Parked bill not found");
  if (existingDraft.cashierId !== cashierId) {
    throw new Error("Parked bill belongs to another cashier");
  }
  if (existingDraft.status !== "DRAFT") {
    throw new Error("Only draft invoices can be checked out");
  }

  const invoiceNo = shouldAssignFinalInvoiceNo(existingDraft.invoiceNo)
    ? await generateInvoiceNo(tx)
    : existingDraft.invoiceNo;

  if (existingDraft.items.length > 0) {
    await adjustReservedStockTx(tx, existingDraft.items, "release");
  }

  await tx.invoiceItem.deleteMany({ where: { invoiceId: existingDraft.id } });

  return tx.invoice.update({
    where: { id: existingDraft.id },
    data: {
      invoiceNo,
      customerId,
      notes,
      parkedLabel: null,
      parkedAt: null,
      subTotal: 0,
      loyaltyDiscountPercent: 0,
      loyaltyDiscountAmount: 0,
      netTotal: 0,
      paidTotal: 0,
      paymentStatus: "UNPAID",
      finalizedAt: null,
    },
  });
}

// atomic checkout for the POS billing screen: create invoice, add items, finalize stock, and record initial payment
export async function checkoutInvoice(cashierId: string, input: CheckoutInput) {
  const checkoutItems = normalizeCheckoutItems(input.items);
  const checkoutPayments = normalizeCheckoutPayments(input);
  const settings = await getBusinessSettings();

  return prisma.$transaction(async (tx) => {
    const customerId = input.customerId ? String(input.customerId) : null;
    const customer = customerId
      ? await tx.customer.findUnique({
          where: { id: customerId },
          select: {
            id: true,
            isActive: true,
            loyaltyPercent: true,
            wholesalePercent: true,
          },
        })
      : null;

    if (customerId && (!customer || !customer.isActive)) {
      throw new Error("Customer not found");
    }

    const draftInvoiceId = String(input.draftInvoiceId || "").trim();
    const ownReservedItems = draftInvoiceId
      ? await tx.invoiceItem.findMany({
          where: { invoiceId: draftInvoiceId },
          select: { productId: true, qty: true },
        })
      : [];
    const checkoutProductsById = await validateCheckoutProductsTx(
      tx,
      checkoutItems,
      buildReservedQtyByProduct(ownReservedItems),
    );
    const invoice = await prepareCheckoutInvoiceTx(
      tx,
      cashierId,
      input,
      customerId,
    );

    const priceOverrideLines: Array<{
      productId: string;
      productName: string;
      sku?: string | null;
      qty: number;
      originalUnitPrice: number;
      overrideUnitPrice: number;
      overrideReason: string;
      lineDifference: number;
      overrideAuthorizationToken?: string | null;
    }> = [];
    const pricedCheckoutLines = checkoutItems.map((line) => {
      const product = checkoutProductsById.get(line.productId);

      const originalUnitPrice = roundCurrency(
        shouldUseQuantityWholesalePrice(
          customer,
          line.qty,
          resolveWholesaleQtyThreshold(product, settings),
          product.wholesaleEligible,
        )
          ? product.wholesalePrice
          : product.retailPrice,
      );
      const hasPriceOverride =
        line.overrideUnitPrice !== undefined &&
        Math.abs(line.overrideUnitPrice - originalUnitPrice) > 0.001;
      const appliedUnitPrice = hasPriceOverride
        ? Number(line.overrideUnitPrice)
        : originalUnitPrice;

      if (hasPriceOverride) {
        priceOverrideLines.push({
          productId: line.productId,
          productName: product.name,
          sku: product.sku || null,
          qty: line.qty,
          originalUnitPrice,
          overrideUnitPrice: appliedUnitPrice,
          overrideReason: line.overrideReason || "Price corrected at billing",
          lineDifference: roundCurrency(
            (appliedUnitPrice - originalUnitPrice) * line.qty,
          ),
          overrideAuthorizationToken: line.overrideAuthorizationToken,
        });
      }

      return {
        ...line,
        product,
        appliedUnitPrice,
        originalUnitPrice,
        hasPriceOverride,
      };
    });

    for (const overrideLine of priceOverrideLines) {
      await consumePriceOverrideAuthorizationTx(tx, {
        cashierId,
        invoiceId: invoice.id,
        customerId,
        productId: overrideLine.productId,
        qty: overrideLine.qty,
        originalUnitPrice: overrideLine.originalUnitPrice,
        overrideUnitPrice: overrideLine.overrideUnitPrice,
        overrideReason: overrideLine.overrideReason,
        token: overrideLine.overrideAuthorizationToken,
      });
    }

    for (const line of checkoutItems) {
      const pricedLine = pricedCheckoutLines.find(
        (item) => item.productId === line.productId,
      )!;

      await tx.invoiceItem.create({
        data: {
          invoiceId: invoice.id,
          productId: line.productId,
          qty: line.qty,
          appliedUnitPrice: pricedLine.appliedUnitPrice,
          originalUnitPrice: pricedLine.hasPriceOverride
            ? pricedLine.originalUnitPrice
            : null,
          overrideUnitPrice: pricedLine.hasPriceOverride
            ? pricedLine.appliedUnitPrice
            : null,
          overrideReason: pricedLine.hasPriceOverride
            ? line.overrideReason || "Price corrected at billing"
            : null,
          overrideById: pricedLine.hasPriceOverride ? cashierId : null,
          overrideAt: pricedLine.hasPriceOverride ? new Date() : null,
          lineTotal: roundCurrency(pricedLine.appliedUnitPrice * line.qty),
        },
      });
    }

    const finalized = await finalizeCheckoutInvoiceTx(
      tx,
      invoice.id,
      cashierId,
      input.discountAmount,
      input.overridePin,
    );

    if (priceOverrideLines.length > 0) {
      const actor = await tx.user.findUnique({
        where: { id: cashierId },
        select: { id: true, name: true, role: true },
      });

      await tx.auditLog.create({
        data: {
          actorId: cashierId,
          action: "CASHIER_PRICE_OVERRIDE_APPLIED",
          entityType: "Invoice",
          entityId: invoice.id,
          meta: {
            invoiceNo: invoice.invoiceNo,
            actorName: actor?.name || null,
            actorRole: actor?.role || null,
            overrideCount: priceOverrideLines.length,
            totalDifference: roundCurrency(
              priceOverrideLines.reduce(
                (sum, item) => sum + item.lineDifference,
                0,
              ),
            ),
            items: priceOverrideLines,
          },
        },
      });
    }

    let esewaPaymentIntent:
      | Awaited<ReturnType<typeof createEsewaPaymentIntentTx>>
      | null = null;

    let invoiceForPayments = finalized;
    for (const payment of checkoutPayments) {
      if (payment.method === "CASH") {
        await recordCheckoutCashPaymentTx(
          tx,
          invoiceForPayments,
          payment.amount,
          cashierId,
          payment.reference,
          payment.tenderedAmount,
        );
        invoiceForPayments = await tx.invoice.findUniqueOrThrow({
          where: { id: invoice.id },
          include: { payments: true },
        });
      } else if (payment.method === "ESEWA") {
        esewaPaymentIntent = await createEsewaPaymentIntentTx(
          tx,
          invoiceForPayments,
          payment.amount,
          cashierId,
        );
        invoiceForPayments = await tx.invoice.findUniqueOrThrow({
          where: { id: invoice.id },
          include: { payments: true },
        });
      }
    }

    const savedInvoice = await tx.invoice.findUnique({
      where: { id: invoice.id },
      include: {
        items: {
          include: {
            product: { select: { id: true, name: true, sku: true, barcode: true } },
          },
        },
        payments: {
          include: { createdBy: { select: { id: true, name: true } } },
          orderBy: { createdAt: "desc" },
        },
        cashier: { select: { id: true, name: true, email: true } },
        customer: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            loyaltyPercent: true,
            wholesalePercent: true,
          },
        },
        cancelledBy: {
          select: {
            id: true,
            name: true,
            role: true,
          },
        },
      },
    });

    return { invoice: savedInvoice, esewaPaymentIntent };
  });
}

export async function modifyFinalizedInvoice(
  invoiceId: string,
  userId: string,
  input: ModifyFinalizedInvoiceInput,
) {
  const replacementItems = normalizeCheckoutItems(input.items);
  const settings = await getBusinessSettings();

  return prisma.$transaction(async (tx) => {
    const original = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        items: {
          include: {
            product: {
              select: { id: true, name: true, sku: true },
            },
          },
        },
        payments: true,
        customer: true,
      },
    });

    if (!original) throw new Error("Invoice not found");
    if (original.status !== "FINALIZED") {
      throw new Error("Only finalized invoices can be modified");
    }
    if (original.paymentStatus === "CANCELLED") {
      throw new Error("Cancelled invoices cannot be modified");
    }
    await assertNoActiveReturnRequestsTx(
      tx,
      original.id,
      "modify this invoice",
    );

    const customerId =
      input.customerId === undefined
        ? original.customerId
        : input.customerId
          ? String(input.customerId)
          : null;
    const customer = customerId
      ? await tx.customer.findUnique({
          where: { id: customerId },
          select: {
            id: true,
            isActive: true,
            loyaltyPercent: true,
            wholesalePercent: true,
          },
        })
      : null;

    if (customerId && (!customer || !customer.isActive)) {
      throw new Error("Customer not found");
    }

    const actor = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, role: true },
    });
    const creditNoteNo = await generateCreditNoteNo(tx);

    for (const item of original.items) {
      await tx.product.update({
        where: { id: item.productId },
        data: { stock: { increment: item.qty } },
      });

      await tx.stockTransaction.create({
        data: {
          productId: item.productId,
          type: "RESTOCK",
          qtyDelta: item.qty,
          reason: `Credit note ${creditNoteNo} reversing ${original.invoiceNo}`,
          refInvoiceId: original.id,
          createdById: userId,
        },
      });
    }

    await tx.invoice.update({
      where: { id: original.id },
      data: {
        paymentStatus: "CANCELLED",
        cancelledAt: new Date(),
        cancelledById: userId,
      },
    });

    const replacementProductsById = await validateCheckoutProductsTx(
      tx,
      replacementItems,
    );
    const replacementInvoiceNo = await generateInvoiceNo(tx);
    const replacement = await tx.invoice.create({
      data: {
        invoiceNo: replacementInvoiceNo,
        status: "DRAFT",
        cashierId: userId,
        customerId,
      },
    });

    for (const line of replacementItems) {
      const product = replacementProductsById.get(line.productId);

      const appliedUnitPrice = shouldUseQuantityWholesalePrice(
        customer,
        line.qty,
        resolveWholesaleQtyThreshold(product, settings),
        product.wholesaleEligible,
      )
        ? product.wholesalePrice
        : product.retailPrice;

      await tx.invoiceItem.create({
        data: {
          invoiceId: replacement.id,
          productId: line.productId,
          qty: line.qty,
          appliedUnitPrice,
          lineTotal: roundCurrency(appliedUnitPrice * line.qty),
        },
      });
    }

    const finalizedReplacement = await finalizeCheckoutInvoiceTx(
      tx,
      replacement.id,
      userId,
      input.discountAmount,
      input.overridePin,
    );

    const creditedAmount = roundCurrency(
      Math.min(original.paidTotal, finalizedReplacement.netTotal),
    );
    if (creditedAmount > 0) {
      const successfulOriginalPayment = original.payments.find(
        (payment) =>
          payment.status === "SUCCESS" &&
          String((payment as any).kind || "CHARGE").toUpperCase() !== "REFUND",
      );
      const paymentMethod = successfulOriginalPayment?.method || "CASH";
      const nextPaymentStatus =
        creditedAmount >= finalizedReplacement.netTotal
          ? "PAID"
          : "PARTIALLY_PAID";

      await tx.payment.create({
        data: {
          invoiceId: finalizedReplacement.id,
          method: paymentMethod,
          amount: creditedAmount,
          status: "SUCCESS",
          reference: `Credit transfer ${creditNoteNo}`,
          createdById: userId,
        },
      });

      await tx.invoice.update({
        where: { id: finalizedReplacement.id },
        data: {
          paidTotal: creditedAmount,
          paymentStatus: nextPaymentStatus,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: userId,
          action: "INVOICE_PAYMENT_UPDATED",
          entityType: "Invoice",
          entityId: finalizedReplacement.id,
          meta: {
            invoiceNo: finalizedReplacement.invoiceNo,
            actorName: actor?.name || null,
            actorRole: actor?.role || null,
            method: paymentMethod,
            reference: `Credit transfer ${creditNoteNo}`,
            amountAdded: creditedAmount,
            previousStatus: finalizedReplacement.paymentStatus,
            nextStatus: nextPaymentStatus,
            paidTotal: creditedAmount,
            netTotal: finalizedReplacement.netTotal,
            remainingDue: roundCurrency(
              Math.max(0, finalizedReplacement.netTotal - creditedAmount),
            ),
          },
        },
      });
    }

    const creditNote = await tx.creditNote.create({
      data: {
        creditNoteNo,
        originalInvoiceId: original.id,
        replacementInvoiceId: finalizedReplacement.id,
        reason: normalizeParkedLabel(input.reason) || "Invoice modified",
        originalNetTotal: original.netTotal,
        originalPaidTotal: original.paidTotal,
        replacementNetTotal: finalizedReplacement.netTotal,
        creditedAmount,
        createdById: userId,
      },
      include: {
        originalInvoice: { select: { id: true, invoiceNo: true } },
        replacementInvoice: { select: { id: true, invoiceNo: true } },
        createdBy: { select: { id: true, name: true, role: true } },
      },
    });

    await tx.auditLog.create({
      data: {
        actorId: userId,
        action: "INVOICE_MODIFIED_WITH_CREDIT_NOTE",
        entityType: "Invoice",
        entityId: original.id,
        meta: {
          creditNoteNo,
          originalInvoiceNo: original.invoiceNo,
          replacementInvoiceNo: finalizedReplacement.invoiceNo,
          reason: creditNote.reason,
          originalNetTotal: original.netTotal,
          replacementNetTotal: finalizedReplacement.netTotal,
          creditedAmount,
          actorName: actor?.name || null,
          actorRole: actor?.role || null,
        },
      },
    });

    const replacementInvoice = await tx.invoice.findUnique({
      where: { id: finalizedReplacement.id },
      include: {
        items: {
          include: {
            product: { select: { id: true, name: true, sku: true, barcode: true } },
          },
        },
        payments: {
          include: { createdBy: { select: { id: true, name: true } } },
          orderBy: { createdAt: "desc" },
        },
        cashier: { select: { id: true, name: true, email: true } },
        customer: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            loyaltyPercent: true,
            wholesalePercent: true,
          },
        },
        cancelledBy: {
          select: {
            id: true,
            name: true,
            role: true,
          },
        },
      },
    });

    return { creditNote, replacementInvoice };
  });
}

const parkedDraftInclude = {
  items: {
    include: {
      product: {
        select: {
          id: true,
          name: true,
          sku: true,
          barcode: true,
          retailPrice: true,
          wholesalePrice: true,
          wholesaleQtyThreshold: true,
          stock: true,
          reservedStock: true,
          isActive: true,
          imageUrl: true,
        },
      },
    },
  },
  customer: {
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      loyaltyPercent: true,
      wholesalePercent: true,
    },
  },
  cashier: { select: { id: true, name: true, email: true } },
} satisfies Prisma.InvoiceInclude;

function buildParkedDraftResumeWarnings(invoice: any) {
  return invoice.items
    .map((item: any) => {
      const product = item.product;
      const availableStock = product ? getAvailableStock(product, item.qty) : 0;
      const currentUnitPrice =
        product && item.qty >= Math.max(1, Number(product.wholesaleQtyThreshold || 1))
          ? Number(product.wholesalePrice || 0)
          : Number(product?.retailPrice || 0);
      const warnings: string[] = [];

      if (!product) {
        warnings.push("Product no longer exists");
      } else {
        if (product.isActive === false) warnings.push("Product is inactive");
        if (roundCurrency(Number(item.appliedUnitPrice || 0)) !== roundCurrency(currentUnitPrice)) {
          warnings.push("Price changed");
        }
        if (availableStock < Number(item.qty || 0)) {
          warnings.push("Stock changed");
        }
      }

      if (warnings.length === 0) return null;

      return {
        productId: item.productId,
        productName: product?.name || "Unknown product",
        sku: product?.sku || null,
        qty: item.qty,
        parkedUnitPrice: roundCurrency(Number(item.appliedUnitPrice || 0)),
        currentUnitPrice: roundCurrency(currentUnitPrice),
        availableStock,
        warnings,
      };
    })
    .filter(Boolean);
}

export async function parkDraft(cashierId: string, input: ParkDraftInput) {
  const draftItems = normalizeCheckoutItems(input.items);
  const settings = await getBusinessSettings();

  return prisma.$transaction(async (tx) => {
    const customerId = input.customerId ? String(input.customerId) : null;
    const customer = customerId
      ? await tx.customer.findUnique({
          where: { id: customerId },
          select: {
            id: true,
            isActive: true,
            loyaltyPercent: true,
            wholesalePercent: true,
          },
        })
      : null;

    if (customerId && (!customer || !customer.isActive)) {
      throw new Error("Customer not found");
    }

    const replaceDraftInvoiceId = String(input.replaceDraftInvoiceId || "").trim();
    if (replaceDraftInvoiceId) {
      const existingDraft = await tx.invoice.findUnique({
        where: { id: replaceDraftInvoiceId },
        include: { items: true },
      });

      if (!existingDraft) throw new Error("Parked bill not found");
      if (existingDraft.cashierId !== cashierId) {
        throw new Error("Parked bill belongs to another cashier");
      }
      if (existingDraft.status !== "DRAFT" || !existingDraft.parkedAt) {
        throw new Error("Only parked draft invoices can be replaced");
      }

      await adjustReservedStockTx(tx, existingDraft.items, "release");
      await tx.invoiceItem.deleteMany({ where: { invoiceId: existingDraft.id } });
      await tx.invoice.delete({ where: { id: existingDraft.id } });
    }

    const draftProductsById = await validateCheckoutProductsTx(tx, draftItems);
    const invoiceNo = await generateParkedDraftNo(tx);
    const invoice = await tx.invoice.create({
      data: {
        invoiceNo,
        status: "DRAFT",
        cashierId,
        customerId,
        parkedLabel: normalizeParkedLabel(input.label),
        parkedAt: new Date(),
      },
    });

    let subTotal = 0;
    for (const line of draftItems) {
      const product = draftProductsById.get(line.productId);

      const appliedUnitPrice = shouldUseQuantityWholesalePrice(
        customer,
        line.qty,
        resolveWholesaleQtyThreshold(product, settings),
        product.wholesaleEligible,
      )
        ? product.wholesalePrice
        : product.retailPrice;
      const lineTotal = roundCurrency(appliedUnitPrice * line.qty);
      subTotal = roundCurrency(subTotal + lineTotal);

      await tx.invoiceItem.create({
        data: {
          invoiceId: invoice.id,
          productId: line.productId,
          qty: line.qty,
          appliedUnitPrice,
          lineTotal,
        },
      });
    }

    await adjustReservedStockTx(tx, draftItems, "reserve");

    await tx.invoice.update({
      where: { id: invoice.id },
      data: { subTotal },
    });

    await tx.auditLog.create({
      data: {
        actorId: cashierId,
        action: "INVOICE_DRAFT_PARKED",
        entityType: "Invoice",
        entityId: invoice.id,
        meta: {
          invoiceNo,
          label: normalizeParkedLabel(input.label),
          itemCount: draftItems.length,
          subTotal,
        },
      },
    });

    return tx.invoice.findUnique({
      where: { id: invoice.id },
      include: parkedDraftInclude,
    });
  });
}

export async function listParkedDrafts(userId: string, role?: string) {
  const normalizedRole = String(role || "").toUpperCase();
  const canSeeAllParked = normalizedRole === "ADMIN" || normalizedRole === "MANAGER";
  return prisma.invoice.findMany({
    where: {
      status: "DRAFT",
      ...(canSeeAllParked ? {} : { cashierId: userId }),
      parkedAt: { not: null },
    },
    include: parkedDraftInclude,
    orderBy: { parkedAt: "desc" },
  });
}

export async function resumeParkedDraft(invoiceId: string, cashierId: string) {
  return prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: parkedDraftInclude,
    });

    if (!invoice) throw new Error("Parked bill not found");
    if (invoice.cashierId !== cashierId) throw new Error("Parked bill belongs to another cashier");
    if (invoice.status !== "DRAFT" || !invoice.parkedAt) {
      throw new Error("Only parked draft invoices can be resumed");
    }

    const payload = {
      id: invoice.id,
      invoiceNo: invoice.invoiceNo,
      parkedLabel: invoice.parkedLabel,
      customerId: invoice.customerId,
      staleWarnings: buildParkedDraftResumeWarnings(invoice),
      items: invoice.items.map((item) => ({
        productId: item.productId,
        qty: item.qty,
      })),
    };

    await tx.auditLog.create({
      data: {
        actorId: cashierId,
        action: "INVOICE_DRAFT_RESUMED",
        entityType: "Invoice",
        entityId: invoice.id,
        meta: {
          invoiceNo: invoice.invoiceNo,
          label: invoice.parkedLabel,
          itemCount: invoice.items.length,
        },
      },
    });

    return payload;
  });
}

export async function discardParkedDraft(
  invoiceId: string,
  userId: string,
  role?: string,
) {
  await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: { items: true },
    });

    if (!invoice) throw new Error("Parked bill not found");
    const normalizedRole = String(role || "").toUpperCase();
    const canDiscardAny = normalizedRole === "ADMIN" || normalizedRole === "MANAGER";
    if (invoice.cashierId !== userId && !canDiscardAny) {
      throw new Error("Parked bill belongs to another cashier");
    }
    if (invoice.status !== "DRAFT" || !invoice.parkedAt) {
      throw new Error("Only parked draft invoices can be discarded");
    }

    await tx.auditLog.create({
      data: {
        actorId: userId,
        action: "INVOICE_DRAFT_DISCARDED",
        entityType: "Invoice",
        entityId: invoice.id,
        meta: {
          invoiceNo: invoice.invoiceNo,
          label: invoice.parkedLabel,
          itemCount: invoice.items.length,
        },
      },
    });

    await adjustReservedStockTx(tx, invoice.items, "release");
    await tx.invoiceItem.deleteMany({ where: { invoiceId: invoice.id } });
    await tx.invoice.delete({ where: { id: invoice.id } });
  });

  return { message: "Parked bill discarded" };
}

export async function transferParkedDraft(
  invoiceId: string,
  adminId: string,
  targetCashierId: string,
) {
  return prisma.$transaction(async (tx) => {
    const [invoice, targetCashier] = await Promise.all([
      tx.invoice.findUnique({
        where: { id: invoiceId },
        include: { items: true, cashier: { select: { id: true, name: true } } },
      }),
      tx.user.findUnique({
        where: { id: targetCashierId },
        select: { id: true, name: true, role: true, isActive: true },
      }),
    ]);

    if (!invoice) throw new Error("Parked bill not found");
    if (invoice.status !== "DRAFT" || !invoice.parkedAt) {
      throw new Error("Only parked draft invoices can be transferred");
    }
    if (!targetCashier || targetCashier.role !== "CASHIER" || !targetCashier.isActive) {
      throw new Error("Target cashier is not active");
    }

    const updated = await tx.invoice.update({
      where: { id: invoice.id },
      data: { cashierId: targetCashier.id },
      include: parkedDraftInclude,
    });

    await tx.auditLog.create({
      data: {
        actorId: adminId,
        action: "INVOICE_DRAFT_TRANSFERRED",
        entityType: "Invoice",
        entityId: invoice.id,
        meta: {
          invoiceNo: invoice.invoiceNo,
          fromCashierId: invoice.cashierId,
          fromCashierName: invoice.cashier?.name || null,
          toCashierId: targetCashier.id,
          toCashierName: targetCashier.name,
          itemCount: invoice.items.length,
        },
      },
    });

    return updated;
  });
}

// --

// defining the shape of filters for listing invoices
interface InvoiceFilters {
  status?: string;
  cashierId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
  includeDeleted?: boolean;
}

// listing invoices with optional filters for status, cashier, date range, and pagination
// includes related data like cashier info, customer data, items, and payments
export async function listInvoices(filters: InvoiceFilters) {
  // safely validating pagination values — defaulting to page 1 and 20 items per page
  const safePage =
    Number.isInteger(filters.page) && Number(filters.page) > 0
      ? Number(filters.page)
      : 1;
  const safePageSize =
    Number.isInteger(filters.pageSize) && Number(filters.pageSize) > 0
      ? Number(filters.pageSize)
      : 20;

  const where: Prisma.InvoiceWhereInput = {};

  // soft-deleted invoices are excluded from results by default
  // passing includeDeleted: true explicitly includes them (for admin audit views)
  if (!filters.includeDeleted) {
    where.deletedAt = null;
  }

  if (filters.status) where.status = filters.status as any; // filtering by invoice status (DRAFT, FINALIZED)
  if (filters.cashierId) where.cashierId = filters.cashierId; // filtering by which cashier created the invoice

  // building the date range filter using our business date utilities
  // this converts the YYYY-MM-DD strings to proper Nepal timezone UTC ranges
  const createdAt = buildBusinessDateRange({
    from: filters.from,
    to: filters.to,
  });
  if (createdAt) {
    where.createdAt = createdAt;
  }

  const skip = (safePage - 1) * safePageSize; // calculating pagination offset

  // running query and count in parallel for better performance
  const [invoices, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      include: {
        cashier: { select: { id: true, name: true, email: true } },
        customer: {
          select: {
            id: true,
            name: true,
            phone: true,
            loyaltyPercent: true,
            wholesalePercent: true,
          },
        },
        cancelledBy: {
          select: {
            id: true,
            name: true,
            role: true,
          },
        },
        items: {
          select: {
            id: true,
            qty: true,
            appliedUnitPrice: true,
            lineTotal: true,
            product: {
              select: { id: true, name: true, sku: true, barcode: true },
            },
          },
        },
        payments: {
          select: {
            id: true,
            method: true,
            status: true,
            amount: true,
            reference: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" }, // newest payments first
        },
        _count: { select: { items: true, payments: true } }, // including counts for quick display
      },
      orderBy: { createdAt: "desc" }, // newest invoices first
      skip,
      take: safePageSize,
    }),
    prisma.invoice.count({ where }), // getting total count for pagination
  ]);

  return { invoices, total, page: safePage, pageSize: safePageSize };
}

// fetching a single invoice with all its related data — items, payments, cashier, customer
// we include full details here because this is used for the invoice detail view and print page
export async function getInvoice(id: string) {
  return prisma.invoice.findUnique({
    where: { id },
    include: {
      items: {
        include: {
          product: { select: { id: true, name: true, sku: true, barcode: true } },
        },
      },
      payments: {
        include: { createdBy: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
      },
      cashier: { select: { id: true, name: true, email: true } },
      customer: {
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          loyaltyPercent: true,
          wholesalePercent: true,
        },
      },
      cancelledBy: {
        select: {
          id: true,
          name: true,
          role: true,
        },
      },
      creditNotesAsOriginal: {
        include: {
          replacementInvoice: { select: { id: true, invoiceNo: true } },
          createdBy: { select: { id: true, name: true, role: true } },
        },
        orderBy: { createdAt: "desc" },
      },
      creditNoteAsReplacement: {
        include: {
          originalInvoice: { select: { id: true, invoiceNo: true } },
          createdBy: { select: { id: true, name: true, role: true } },
        },
      },
    },
  });
}

// --

// adding a product item to a draft invoice
// if the product already exists in the invoice, we increase the quantity instead of creating a duplicate row
// we also recalculate the unit price because the new total quantity might change the pricing tier (retail vs wholesale)
// the entire operation is wrapped in a transaction so the item mutation and subtotal recomputation are atomic
export async function addItem(invoiceId: string, productId: string, qty: number) {
  const normalizedQty = normalizePositiveQuantity(qty, "qty");
  const settings = await getBusinessSettings(); // needed to resolve wholesale qty thresholds

  return prisma.$transaction(async (tx) => {
    // fetching the invoice with its customer data to determine which pricing rules apply
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        customer: {
          select: { id: true, loyaltyPercent: true, wholesalePercent: true },
        },
      },
    });

    if (!invoice) throw new Error("Invoice not found");
    if (invoice.status !== "DRAFT") throw new Error("Cannot modify a finalized invoice");

    const product = await tx.product.findUnique({ where: { id: productId } });
    if (!product) throw new Error("Product not found");
    if (!product.isActive) throw new Error("Product is inactive");
    if (product.stock <= 0) throw new Error("Product is out of stock");
    assertProductQuantityAllowed(product, normalizedQty);

    // checking if this product is already in the invoice — if so, we merge the quantities
    const existing = await tx.invoiceItem.findFirst({ where: { invoiceId, productId } });

    if (existing) {
      const newQty = existing.qty + normalizedQty; // combining old and new quantity
      // making sure the combined quantity does not exceed available stock
      if (newQty > product.stock) {
        throw new Error(
          buildInsufficientStockMessage(product.name, product.stock, newQty),
        );
      }

      // recalculating the unit price because the new total quantity might qualify for wholesale pricing
      const recalculatedUnitPrice = shouldUseQuantityWholesalePrice(
        invoice.customer,
        newQty,
        resolveWholesaleQtyThreshold(product, settings),
        product.wholesaleEligible,
      )
        ? product.wholesalePrice
        : product.retailPrice;
      const newLineTotal = roundCurrency(recalculatedUnitPrice * newQty);

      const item = await tx.invoiceItem.update({
        where: { id: existing.id },
        data: {
          qty: newQty,
          appliedUnitPrice: recalculatedUnitPrice,
          lineTotal: newLineTotal,
        },
      });

      await recomputeSubtotal(invoiceId, tx); // updating the invoice subtotal after changing the item
      return item;
    }

    // if the product is not already in the invoice, validate stock and create a new item
    if (normalizedQty > product.stock) {
      throw new Error(
        buildInsufficientStockMessage(product.name, product.stock, normalizedQty),
      );
    }

    // determining whether to use wholesale or retail price based on the quantity and customer settings
    const appliedUnitPrice = shouldUseQuantityWholesalePrice(
      invoice.customer,
      normalizedQty,
      resolveWholesaleQtyThreshold(product, settings),
      product.wholesaleEligible,
    )
      ? product.wholesalePrice
      : product.retailPrice;
    const lineTotal = roundCurrency(appliedUnitPrice * normalizedQty);

    const item = await tx.invoiceItem.create({
      data: {
        invoiceId,
        productId,
        qty: normalizedQty,
        appliedUnitPrice,
        lineTotal,
      },
    });

    await recomputeSubtotal(invoiceId, tx);
    return item;
  });
}

// updating the quantity of an existing item in a draft invoice
// we recalculate the unit price because changing the quantity might switch between retail and wholesale pricing
// wrapped in a transaction so the item update and subtotal recomputation are atomic
export async function updateItem(invoiceId: string, itemId: string, qty: number) {
  const normalizedQty = normalizePositiveQuantity(qty, "qty");
  const settings = await getBusinessSettings();

  return prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        customer: {
          select: { id: true, loyaltyPercent: true, wholesalePercent: true },
        },
      },
    });

    if (!invoice) throw new Error("Invoice not found");
    if (invoice.status !== "DRAFT") throw new Error("Cannot modify a finalized invoice");

    const item = await tx.invoiceItem.findUnique({
      where: { id: itemId },
      include: { product: true }, // we need the product's stock and pricing info
    });

    if (!item) throw new Error("Item not found");
    if (item.invoiceId !== invoiceId) throw new Error("Item does not belong to this invoice");
    assertProductQuantityAllowed(item.product, normalizedQty);
    // checking that the new quantity does not exceed available stock
    if (normalizedQty > item.product.stock) {
      throw new Error(
        buildInsufficientStockMessage(
          item.product.name,
          item.product.stock,
          normalizedQty,
        ),
      );
    }

    // recalculating unit price based on the new quantity
    const appliedUnitPrice = shouldUseQuantityWholesalePrice(
      invoice.customer,
      normalizedQty,
      resolveWholesaleQtyThreshold(item.product, settings),
      item.product.wholesaleEligible,
    )
      ? item.product.wholesalePrice
      : item.product.retailPrice;
    const lineTotal = roundCurrency(appliedUnitPrice * normalizedQty);

    const updated = await tx.invoiceItem.update({
      where: { id: itemId },
      data: { qty: normalizedQty, appliedUnitPrice, lineTotal },
    });

    await recomputeSubtotal(invoiceId, tx); // updating the invoice subtotal
    return updated;
  });
}

// removing an item from a draft invoice — validates that the invoice is still a draft
// and that the item actually belongs to this invoice
// wrapped in a transaction so the delete and subtotal recomputation are atomic
export async function removeItem(invoiceId: string, itemId: string) {
  await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new Error("Invoice not found");
    if (invoice.status !== "DRAFT") throw new Error("Cannot modify a finalized invoice");

    const item = await tx.invoiceItem.findUnique({ where: { id: itemId } });
    if (!item) throw new Error("Item not found");
    if (item.invoiceId !== invoiceId) throw new Error("Item does not belong to this invoice");

    await tx.invoiceItem.delete({ where: { id: itemId } }); // removing the item from the database
    await recomputeSubtotal(invoiceId, tx); // updating the invoice subtotal after removal
  });
}

// --

// finalizing an invoice — this is the most critical operation in the billing flow
// wrapping everything inside a prisma transaction because we need stock deduction,
// invoice update, and audit log creation to either all succeed together or all fail together
// if any one step fails, none of the changes get saved to the database
export async function finalizeInvoice(
  invoiceId: string,
  userId: string,
  discountAmount?: number,
) {
  await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        items: { include: { product: true } }, // we need product data to check stock and get prices
        customer: true, // we need customer data to figure out which discount rules apply
      },
    });

    if (!invoice) throw new Error("Invoice not found");
    if (invoice.status !== "DRAFT") throw new Error("Invoice is already finalized");
    if (invoice.items.length === 0) throw new Error("Cannot finalize an empty invoice");

    // recalculating subtotal from all line items instead of using the stored value
    // we do this because items might have been added or changed since the last subtotal update
    const subTotal = roundCurrency(
      invoice.items.reduce((sum, item) => sum + item.lineTotal, 0),
    );

    // resolving which discount type applies for this customer
    const resolvedDiscount = resolveSubtotalDiscountPercent(invoice.customer);
    const computedDiscount = roundCurrency(
      (subTotal * resolvedDiscount.percent) / 100,
    );

    // if the frontend sent a manual discount amount, we use that instead of the auto-computed one
    // normalizeDiscountAmount also makes sure the discount does not exceed the subtotal,
    // because a discount larger than the bill total is not valid
    const normalizedDiscount = normalizeDiscountAmount(
      discountAmount,
      subTotal,
      computedDiscount,
    );

    // we back-calculate the percentage from the final discount amount
    // this is stored on the invoice so we can display "X% discount" later in history and reports
    const appliedDiscountPercent =
      subTotal > 0 ? roundCurrency((normalizedDiscount / subTotal) * 100) : 0;
    const netTotal = roundCurrency(subTotal - normalizedDiscount); // this is the final amount the customer needs to pay

    // fetching the user who is performing this action so we can log their name and role in the audit
    const actor = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, role: true },
    });

    // looping through each item in the invoice to deduct stock
    // we use updateMany with a condition (stock >= qty) so the database only deducts
    // if there is enough stock at this exact moment — this prevents overselling
    for (const item of invoice.items) {
      const updated = await tx.product.updateMany({
        where: {
          id: item.productId,
          stock: { gte: item.qty }, // only deduct if current stock is enough for the requested quantity
        },
        data: { stock: { decrement: item.qty } },
      });

      // this handles when stock is insufficient — updateMany returns count 0 when the where
      // condition does not match, which means the product does not have enough stock right now
      // this can happen because draft invoices do not reserve stock, so another sale could
      // have reduced it between when the draft was created and when finalize is called
      if (updated.count === 0) {
        const latestProduct = await tx.product.findUnique({
          where: { id: item.productId },
          select: { name: true, stock: true },
        });

        throw new StockConflictError([
          buildStockConflict({
            productId: item.productId,
            productName: latestProduct?.name || item.product.name,
            requestedQty: item.qty,
            availableStock: latestProduct?.stock ?? 0,
            reason:
              (latestProduct?.stock ?? 0) <= 0
                ? "OUT_OF_STOCK"
                : "INSUFFICIENT_STOCK",
          }),
        ]);
      }

      // for every product sold, we create a stock transaction record with type "SALE"
      // this is how we keep a full history of every stock change — so later we can see
      // exactly when and why stock went up or down for any product
      await tx.stockTransaction.create({
        data: {
          productId: item.productId,
          type: "SALE",
          qtyDelta: -item.qty, // negative value because stock is being reduced (items going out)
          reason: `Sale via invoice ${invoice.invoiceNo}`,
          refInvoiceId: invoiceId, // linking back to the invoice that caused this stock change
          createdById: userId,
        },
      });
    }

    // updating the invoice record to mark it as finalized and saving all the computed totals
    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        status: "FINALIZED",
        subTotal,
        loyaltyDiscountPercent: appliedDiscountPercent,
        loyaltyDiscountAmount: normalizedDiscount,
        netTotal,
        paidTotal: 0, // no payment has been recorded yet at the time of finalization
        paymentStatus: netTotal <= 0 ? "PAID" : "UNPAID", // if the discount covers everything, we mark it as paid automatically
        finalizedAt: new Date(),
      },
    });

    // creating an audit log entry so the admin can see who finalized which invoice,
    // what the totals were, what discount was applied, and whether it was auto-marked as paid
    await tx.auditLog.create({
      data: {
        actorId: userId,
        action: "INVOICE_FINALIZED",
        entityType: "Invoice",
        entityId: invoiceId,
        meta: {
          invoiceNo: invoice.invoiceNo,
          actorName: actor?.name || null,
          actorRole: actor?.role || null,
          subTotal,
          discountAmount: normalizedDiscount,
          discountPercent: appliedDiscountPercent,
          discountSource: resolvedDiscount.source,
          netTotal,
          itemCount: invoice.items.length,
          autoMarkedPaid: netTotal <= 0,
        },
      },
    });
  });

  return getInvoice(invoiceId); // returning the full updated invoice with all its relations included
}

// cancelling a finalized invoice — reverses the stock deductions and marks it as cancelled
// this is a serious action so we wrap it in a transaction and log everything in the audit
export async function cancelInvoice(invoiceId: string, userId: string) {
  await prisma.$transaction(async (tx) => {
    // fetching the invoice with its items and payments — we need all of this for the reversal
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        items: {
          include: {
            product: {
              select: { id: true, name: true, sku: true },
            },
          },
        },
        payments: true,
      },
    });

    if (!invoice) throw new Error("Invoice not found");
    if (invoice.status !== "FINALIZED") {
      throw new Error("Only finalized invoices can be cancelled");
    }
    if (invoice.paymentStatus === "CANCELLED") {
      throw new Error("Invoice is already cancelled");
    }
    await assertNoActiveReturnRequestsTx(tx, invoice.id, "cancel this invoice");

    // fetching the actor info for the audit log
    const actor = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, role: true },
    });

    // counting payment statuses so the audit log shows payment details at the time of cancellation
    const successfulPaymentCount = invoice.payments.filter(
      (payment) =>
        payment.status === "SUCCESS" &&
        String((payment as any).kind || "CHARGE").toUpperCase() !== "REFUND",
    ).length;
    const pendingPaymentCount = invoice.payments.filter(
      (payment) => payment.status === "PENDING",
    ).length;

    // building a list of items that will have their stock restored — used in the audit log
    const restoredItems = invoice.items.map((item) => ({
      productId: item.productId,
      productName: item.product.name,
      sku: item.product.sku,
      qty: item.qty,
    }));

    // reversing the stock deduction for each item — adding the quantities back to the products
    for (const item of invoice.items) {
      await tx.product.update({
        where: { id: item.productId },
        data: { stock: { increment: item.qty } }, // adding the quantity back to stock
      });

      // creating a RESTOCK transaction so we can track that this stock increase came from an invoice cancellation
      await tx.stockTransaction.create({
        data: {
          productId: item.productId,
          type: "RESTOCK",
          qtyDelta: item.qty, // positive value because stock is being added back
          reason: `INVOICE_CANCEL_REVERSE for ${invoice.invoiceNo}`,
          refInvoiceId: invoiceId,
          createdById: userId,
        },
      });
    }

    // marking the invoice as cancelled with the cancellation timestamp and who did it
    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        paymentStatus: "CANCELLED",
        cancelledAt: new Date(),
        cancelledById: userId,
      },
    });

    // creating a detailed audit log entry with all the context about the cancellation
    await tx.auditLog.create({
      data: {
        actorId: userId,
        action: "INVOICE_CANCELLED",
        entityType: "Invoice",
        entityId: invoiceId,
        meta: {
          invoiceNo: invoice.invoiceNo,
          actorName: actor?.name || null,
          actorRole: actor?.role || null,
          previousStatus: invoice.paymentStatus,
          paidTotal: invoice.paidTotal,
          netTotal: invoice.netTotal,
          successfulPaymentCount,
          pendingPaymentCount,
          paymentHistoryPreserved: true, // we keep payment records for auditing even after cancellation
          restoredItems,
        },
      },
    });
  });

  return getInvoice(invoiceId); // returning the updated invoice
}

// soft-deleting a cancelled invoice — sets the deletedAt timestamp so the invoice
// no longer appears in default listings but the database record is fully preserved
// only cancelled invoices can be soft-deleted because active or finalized invoices
// should remain visible for billing and payment operations
export async function softDeleteInvoice(invoiceId: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        invoiceNo: true,
        paymentStatus: true,
        deletedAt: true,
      },
    });

    if (!invoice) throw new Error("Invoice not found");
    if (invoice.paymentStatus !== "CANCELLED") {
      throw new Error("Only cancelled invoices can be deleted");
    }
    if (invoice.deletedAt) {
      throw new Error("Invoice is already deleted");
    }

    const actor = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, role: true },
    });

    await tx.invoice.update({
      where: { id: invoiceId },
      data: { deletedAt: new Date() },
    });

    await tx.auditLog.create({
      data: {
        actorId: userId,
        action: "INVOICE_SOFT_DELETED",
        entityType: "Invoice",
        entityId: invoiceId,
        meta: {
          invoiceNo: invoice.invoiceNo,
          actorName: actor?.name || null,
          actorRole: actor?.role || null,
        },
      },
    });

    return { message: "Invoice deleted" };
  });
}
