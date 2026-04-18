import { Prisma } from "@prisma/client";
import {
  buildBusinessDateRange,
  toBusinessClock,
} from "../../lib/businessDate";
import prisma from "../../db/prisma";
import {
  getBusinessSettings,
  resolveWholesaleQtyThreshold,
} from "../settings/service";

const MAX_CREATE_DRAFT_RETRIES = 5; // retry limit for when the auto-generated invoice number collides with an existing one

// we use this to round any currency value to 2 decimal places
// without this, JavaScript floating point math can produce results like 10.0000000001
// and when we compare totals later (like checking if paidTotal equals netTotal), those tiny
// differences cause the comparison to fail even though they should be equal
function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
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

// building a clear error message when there is not enough stock for a product
// we include the product name, available stock, and requested quantity so the cashier knows exactly what happened
function buildInsufficientStockMessage(
  productName: string,
  availableStock: number,
  requestedQty: number,
) {
  return `Insufficient stock for "${productName}". Available: ${availableStock}, Requested: ${requestedQty}`;
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
) {
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
async function generateInvoiceNo() {
  const now = toBusinessClock(new Date()); // converting current time to Nepal timezone
  const dateStr =
    now.getUTCFullYear().toString() +
    String(now.getUTCMonth() + 1).padStart(2, "0") +
    String(now.getUTCDate()).padStart(2, "0");

  const prefix = `INV-${dateStr}-`;
  const count = await prisma.invoice.count({
    where: { invoiceNo: { startsWith: prefix } }, // counting how many invoices already exist for today
  });

  return `${prefix}${String(count + 1).padStart(4, "0")}`; // next sequential number, padded to 4 digits
}

// recalculating the invoice subtotal by summing all line item totals
// we call this after every item add, update, or remove so the invoice subtotal stays accurate
async function recomputeSubtotal(invoiceId: string) {
  const items = await prisma.invoiceItem.findMany({ where: { invoiceId } });
  const subTotal = roundCurrency(
    items.reduce((sum, item) => sum + item.lineTotal, 0),
  );

  await prisma.invoice.update({ where: { id: invoiceId }, data: { subTotal } });
}

// --

// creating a new draft invoice for a cashier
// we retry up to 5 times in case the auto-generated invoice number collides with an existing one
// this can happen when two cashiers create invoices at the exact same moment
export async function createDraft(cashierId: string, customerId?: string) {
  for (let attempt = 0; attempt < MAX_CREATE_DRAFT_RETRIES; attempt += 1) {
    const invoiceNo = await generateInvoiceNo();

    try {
      return await prisma.invoice.create({
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

// --

// defining the shape of filters for listing invoices
interface InvoiceFilters {
  status?: string;
  cashierId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
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
    },
  });
}

// --

// adding a product item to a draft invoice
// if the product already exists in the invoice, we increase the quantity instead of creating a duplicate row
// we also recalculate the unit price because the new total quantity might change the pricing tier (retail vs wholesale)
export async function addItem(invoiceId: string, productId: string, qty: number) {
  const normalizedQty = normalizePositiveInteger(qty, "qty");
  const settings = await getBusinessSettings(); // needed to resolve wholesale qty thresholds

  // fetching the invoice with its customer data to determine which pricing rules apply
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      customer: {
        select: { id: true, loyaltyPercent: true, wholesalePercent: true },
      },
    },
  });

  if (!invoice) throw new Error("Invoice not found");
  if (invoice.status !== "DRAFT") throw new Error("Cannot modify a finalized invoice");

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) throw new Error("Product not found");
  if (!product.isActive) throw new Error("Product is inactive");
  if (product.stock <= 0) throw new Error("Product is out of stock");

  // checking if this product is already in the invoice — if so, we merge the quantities
  const existing = await prisma.invoiceItem.findFirst({ where: { invoiceId, productId } });

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
    )
      ? product.wholesalePrice
      : product.retailPrice;
    const newLineTotal = roundCurrency(recalculatedUnitPrice * newQty);

    const item = await prisma.invoiceItem.update({
      where: { id: existing.id },
      data: {
        qty: newQty,
        appliedUnitPrice: recalculatedUnitPrice,
        lineTotal: newLineTotal,
      },
    });

    await recomputeSubtotal(invoiceId); // updating the invoice subtotal after changing the item
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
  )
    ? product.wholesalePrice
    : product.retailPrice;
  const lineTotal = roundCurrency(appliedUnitPrice * normalizedQty);

  const item = await prisma.invoiceItem.create({
    data: {
      invoiceId,
      productId,
      qty: normalizedQty,
      appliedUnitPrice,
      lineTotal,
    },
  });

  await recomputeSubtotal(invoiceId);
  return item;
}

// updating the quantity of an existing item in a draft invoice
// we recalculate the unit price because changing the quantity might switch between retail and wholesale pricing
export async function updateItem(invoiceId: string, itemId: string, qty: number) {
  const normalizedQty = normalizePositiveInteger(qty, "qty");
  const settings = await getBusinessSettings();

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      customer: {
        select: { id: true, loyaltyPercent: true, wholesalePercent: true },
      },
    },
  });

  if (!invoice) throw new Error("Invoice not found");
  if (invoice.status !== "DRAFT") throw new Error("Cannot modify a finalized invoice");

  const item = await prisma.invoiceItem.findUnique({
    where: { id: itemId },
    include: { product: true }, // we need the product's stock and pricing info
  });

  if (!item) throw new Error("Item not found");
  if (item.invoiceId !== invoiceId) throw new Error("Item does not belong to this invoice");
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
  )
    ? item.product.wholesalePrice
    : item.product.retailPrice;
  const lineTotal = roundCurrency(appliedUnitPrice * normalizedQty);

  const updated = await prisma.invoiceItem.update({
    where: { id: itemId },
    data: { qty: normalizedQty, appliedUnitPrice, lineTotal },
  });

  await recomputeSubtotal(invoiceId); // updating the invoice subtotal
  return updated;
}

// removing an item from a draft invoice — validates that the invoice is still a draft
// and that the item actually belongs to this invoice
export async function removeItem(invoiceId: string, itemId: string) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new Error("Invoice not found");
  if (invoice.status !== "DRAFT") throw new Error("Cannot modify a finalized invoice");

  const item = await prisma.invoiceItem.findUnique({ where: { id: itemId } });
  if (!item) throw new Error("Item not found");
  if (item.invoiceId !== invoiceId) throw new Error("Item does not belong to this invoice");

  await prisma.invoiceItem.delete({ where: { id: itemId } }); // removing the item from the database
  await recomputeSubtotal(invoiceId); // updating the invoice subtotal after removal
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

        throw new Error(
          buildInsufficientStockMessage(
            latestProduct?.name || item.product.name,
            latestProduct?.stock ?? 0,
            item.qty,
          ),
        );
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

    // fetching the actor info for the audit log
    const actor = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, role: true },
    });

    // counting payment statuses so the audit log shows payment details at the time of cancellation
    const successfulPaymentCount = invoice.payments.filter(
      (payment) => payment.status === "SUCCESS",
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
