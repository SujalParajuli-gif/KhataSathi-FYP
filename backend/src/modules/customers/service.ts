import prisma from "../../db/prisma";
import { getCashierPrivilege } from "../settings/service";

// defining the shape of data needed to create a new customer
type CustomerInput = {
  name: string;
  phone?: string;
  email?: string;
  loyaltyPercent?: number;
  wholesalePercent?: number;
  createdById?: string;
  createdByRole?: "ADMIN" | "MANAGER" | "CASHIER";
};

// extending CustomerInput with optional isActive field for updates
// Partial makes all fields optional so we can update just the ones that changed
type CustomerUpdateInput = Partial<CustomerInput> & { isActive?: boolean };

type DiscountRequestInput = {
  name: string;
  phone: string;
  email?: string;
  discountType: "LOYALTY" | "WHOLESALE";
  discountPercent: number;
  reason?: string;
};

export type CustomerDiscountKind = "LOYALTY" | "WHOLESALE";

const discountRequestInclude = {
  requestedBy: { select: { id: true, name: true, email: true } },
  reviewedBy: { select: { id: true, name: true, email: true } },
  approvedCustomer: { select: { id: true, name: true, phone: true } },
};

function normalizeDiscountPercent(value: unknown) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error("Discount percent must be greater than 0.");
  }
  if (normalized > 100) {
    throw new Error("Discount percent cannot exceed 100%.");
  }
  return Math.round(normalized * 100) / 100;
}

function normalizeDiscountReason(value: unknown) {
  const normalized = String(value || "").trim();
  return normalized ? normalized.slice(0, 1000) : null;
}

// listing all customers, optionally filtered to show only active ones
// sorted alphabetically by name so the frontend displays them in a consistent order
export async function listCustomers(activeOnly?: boolean) {
  const where = activeOnly ? { isActive: true } : {};
  const completedInvoiceWhere = {
    status: "FINALIZED" as const,
    paymentStatus: { not: "CANCELLED" as const },
  };

  const [customers, finalizedCounts] = await Promise.all([
    prisma.customer.findMany({
      where,
      orderBy: { name: "asc" },
      include: {
        _count: {
          select: { invoices: { where: completedInvoiceWhere } },
        },
        invoices: {
          where: completedInvoiceWhere,
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { createdAt: true, netTotal: true },
        },
      },
    }),
    prisma.invoice.groupBy({
      by: ["customerId"],
      where: {
        customerId: { not: null },
        status: "FINALIZED",
      },
      _count: { _all: true },
    }),
  ]);

  const finalizedCountByCustomer = new Map<string, number>();
  finalizedCounts.forEach((row) => {
    if (row.customerId) {
      finalizedCountByCustomer.set(row.customerId, row._count._all);
    }
  });

  return customers.map(({ _count, invoices, ...customer }) => {
    const latest = invoices[0];
    const completedCount = _count.invoices;
    const finalizedCount = finalizedCountByCustomer.get(customer.id) || 0;
    return {
      ...customer,
      purchaseSummary: {
        completedCount,
        finalizedCount,
        state:
          completedCount > 0
            ? ("history" as const)
            : finalizedCount > 0
              ? ("cancelled_only" as const)
              : ("none" as const),
        latestCompletedAt: latest?.createdAt || null,
        latestCompletedNetTotal: latest?.netTotal ?? null,
      },
    };
  });
}

// fetching a single customer record by their ID
export async function getCustomer(id: string) {
  return prisma.customer.findUnique({ where: { id } });
}

// creating a new customer in the database
// optional fields default to null or 0 if not provided, so the database always has valid values
export async function createCustomer(data: CustomerInput) {
  return prisma.$transaction(async (tx) => {
    const customer = await tx.customer.create({
      data: {
        name: data.name,
        phone: data.phone || null,
        email: data.email || null,
        loyaltyPercent: data.loyaltyPercent || 0, // defaults to 0 if no loyalty discount is assigned
        wholesalePercent: data.wholesalePercent || 0, // defaults to 0 if no wholesale discount is assigned
        createdById: data.createdById || null,
        createdByRole: data.createdByRole || null,
      },
    });

    if (data.createdById) {
      await tx.auditLog.create({
        data: {
          actorId: data.createdById,
          action:
            data.createdByRole === "CASHIER"
              ? "CUSTOMER_DISCOUNT_CREATED_BY_CASHIER"
              : "CUSTOMER_CREATED",
          entityType: "Customer",
          entityId: customer.id,
          meta: {
            customerName: customer.name,
            phone: customer.phone,
            loyaltyPercent: customer.loyaltyPercent,
            wholesalePercent: customer.wholesalePercent,
          },
        },
      });
    }

    return customer;
  });
}

export async function createDiscountedCustomerByCashier(
  cashierId: string,
  data: {
    name: string;
    phone: string;
    email?: string;
    discountType: "LOYALTY" | "WHOLESALE";
    discountPercent: number;
  },
) {
  const privilege = await getCashierPrivilege(cashierId);
  if (!privilege.canCreateDiscountedCustomer) {
    throw new Error("You are not authorized to create discounted customers.");
  }

  const discountPercent = Number(data.discountPercent);
  if (!Number.isFinite(discountPercent) || discountPercent <= 0) {
    throw new Error("Discount percent must be greater than 0.");
  }

  if (data.discountType === "LOYALTY" && discountPercent > privilege.maxCustomerLoyaltyPercent) {
    throw new Error(
      `Loyalty discount cannot exceed ${privilege.maxCustomerLoyaltyPercent}%.`,
    );
  }

  if (data.discountType === "WHOLESALE" && discountPercent > privilege.maxCustomerWholesalePercent) {
    throw new Error(
      `Wholesale discount cannot exceed ${privilege.maxCustomerWholesalePercent}%.`,
    );
  }

  return createCustomer({
    name: data.name,
    phone: data.phone,
    email: data.email,
    loyaltyPercent: data.discountType === "LOYALTY" ? discountPercent : 0,
    wholesalePercent: data.discountType === "WHOLESALE" ? discountPercent : 0,
    createdById: cashierId,
    createdByRole: "CASHIER",
  });
}

// updating an existing customer record — only the fields included in the data object will be changed
export async function createCustomerDiscountRequest(
  cashierId: string,
  data: DiscountRequestInput,
) {
  const privilege = await getCashierPrivilege(cashierId);
  if (!privilege.canRequestCustomerDiscount) {
    throw new Error("You are not authorized to request customer discounts.");
  }

  const discountPercent = normalizeDiscountPercent(data.discountPercent);
  const existingPending = await prisma.customerDiscountRequest.findFirst({
    where: { phone: data.phone, status: "PENDING" },
    select: { id: true },
  });

  if (existingPending) {
    throw new Error("A pending discount request already exists for this phone number.");
  }

  return prisma.$transaction(async (tx) => {
    const request = await tx.customerDiscountRequest.create({
      data: {
        customerName: data.name,
        phone: data.phone,
        email: data.email || null,
        discountType: data.discountType,
        discountPercent,
        reason: normalizeDiscountReason(data.reason),
        requestedById: cashierId,
      },
      include: discountRequestInclude,
    });

    await tx.auditLog.create({
      data: {
        actorId: cashierId,
        action: "CUSTOMER_DISCOUNT_REQUEST_CREATED",
        entityType: "CustomerDiscountRequest",
        entityId: request.id,
        meta: {
          requestId: request.id,
          customerName: request.customerName,
          phone: request.phone,
          discountType: request.discountType,
          discountPercent: request.discountPercent,
          cashierId,
          cashierName: request.requestedBy.name,
          reason: request.reason,
        },
      },
    });

    return request;
  });
}

export async function listCustomerDiscountRequests(
  actorId: string,
  actorRole: string,
  status?: string,
) {
  const normalizedStatus = String(status || "").trim().toUpperCase();
  const where: any = {};

  if (["PENDING", "APPROVED", "REJECTED"].includes(normalizedStatus)) {
    where.status = normalizedStatus;
  }

  const canSeeAllRequests = actorRole === "ADMIN" || actorRole === "MANAGER";
  if (!canSeeAllRequests) {
    where.requestedById = actorId;
  }

  return prisma.customerDiscountRequest.findMany({
    where,
    include: discountRequestInclude,
    orderBy: { createdAt: "desc" },
    take: canSeeAllRequests ? 100 : 20,
  });
}

export async function approveCustomerDiscountRequest(
  requestId: string,
  adminId: string,
  data: { discountPercent?: number; adminNote?: string } = {},
) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.customerDiscountRequest.findUnique({
      where: { id: requestId },
      include: { requestedBy: { select: { id: true, name: true } } },
    });

    if (!request) throw new Error("Discount request not found.");
    if (request.status !== "PENDING") {
      throw new Error("Only pending discount requests can be approved.");
    }

    const discountPercent =
      data.discountPercent === undefined
        ? request.discountPercent
        : normalizeDiscountPercent(data.discountPercent);

    const existingCustomer = await tx.customer.findUnique({
      where: { phone: request.phone },
    });

    const customerPayload = {
      name: request.customerName,
      email: request.email || null,
      isActive: true,
      loyaltyPercent: request.discountType === "LOYALTY" ? discountPercent : 0,
      wholesalePercent: request.discountType === "WHOLESALE" ? discountPercent : 0,
    };

    const customer = existingCustomer
      ? await tx.customer.update({
          where: { id: existingCustomer.id },
          data: customerPayload,
        })
      : await tx.customer.create({
          data: {
            ...customerPayload,
            phone: request.phone,
            createdById: request.requestedById,
            createdByRole: "CASHIER",
          },
        });

    const approved = await tx.customerDiscountRequest.update({
      where: { id: requestId },
      data: {
        status: "APPROVED",
        discountPercent,
        reviewedById: adminId,
        reviewedAt: new Date(),
        adminNote: normalizeDiscountReason(data.adminNote),
        approvedCustomerId: customer.id,
      },
      include: discountRequestInclude,
    });

    await tx.auditLog.create({
      data: {
        actorId: adminId,
        action: "CUSTOMER_DISCOUNT_REQUEST_APPROVED",
        entityType: "CustomerDiscountRequest",
        entityId: requestId,
        meta: {
          requestId,
          customerId: customer.id,
          customerName: customer.name,
          phone: customer.phone,
          discountType: request.discountType,
          discountPercent,
          cashierId: request.requestedById,
          cashierName: request.requestedBy.name,
          adminNote: approved.adminNote,
          existingCustomerUpdated: Boolean(existingCustomer),
        },
      },
    });

    return approved;
  });
}

export async function rejectCustomerDiscountRequest(
  requestId: string,
  adminId: string,
  adminNote?: string,
) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.customerDiscountRequest.findUnique({
      where: { id: requestId },
      include: { requestedBy: { select: { id: true, name: true } } },
    });

    if (!request) throw new Error("Discount request not found.");
    if (request.status !== "PENDING") {
      throw new Error("Only pending discount requests can be rejected.");
    }

    const rejected = await tx.customerDiscountRequest.update({
      where: { id: requestId },
      data: {
        status: "REJECTED",
        reviewedById: adminId,
        reviewedAt: new Date(),
        adminNote: normalizeDiscountReason(adminNote),
      },
      include: discountRequestInclude,
    });

    await tx.auditLog.create({
      data: {
        actorId: adminId,
        action: "CUSTOMER_DISCOUNT_REQUEST_REJECTED",
        entityType: "CustomerDiscountRequest",
        entityId: requestId,
        meta: {
          requestId,
          customerName: request.customerName,
          phone: request.phone,
          discountType: request.discountType,
          discountPercent: request.discountPercent,
          cashierId: request.requestedById,
          cashierName: request.requestedBy.name,
          adminNote: rejected.adminNote,
        },
      },
    });

    return rejected;
  });
}

export async function updateCustomer(id: string, data: CustomerUpdateInput) {
  return prisma.customer.update({ where: { id }, data });
}

export async function getCustomerDiscountDeleteSafety(
  customerId: string,
  discountType: CustomerDiscountKind,
) {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: {
      id: true,
      name: true,
      phone: true,
      loyaltyPercent: true,
      wholesalePercent: true,
    },
  });

  if (!customer) {
    throw new Error("Customer not found.");
  }

  const purchaseCount = await prisma.invoice.count({
    where: { customerId, status: "FINALIZED" },
  });
  const currentPercent =
    discountType === "LOYALTY"
      ? Number(customer.loyaltyPercent || 0)
      : Number(customer.wholesalePercent || 0);
  const references = purchaseCount > 0 ? [`${purchaseCount} purchase(s)`] : [];
  const reason =
    purchaseCount > 0
      ? "This customer has purchase history, so the discount must be preserved for audit clarity."
      : currentPercent <= 0
        ? `No active ${discountType.toLowerCase()} discount is set for this customer.`
        : null;

  return {
    customer,
    discountType,
    currentPercent,
    purchaseCount,
    references,
    canDelete: purchaseCount === 0 && currentPercent > 0,
    reason,
  };
}

export async function deleteCustomerDiscount(
  customerId: string,
  discountType: CustomerDiscountKind,
  actorId: string,
) {
  const safety = await getCustomerDiscountDeleteSafety(customerId, discountType);

  if (safety.purchaseCount > 0) {
    const error = new Error(
      "Cannot delete this discount because the customer has purchase history.",
    );
    (error as any).statusCode = 409;
    (error as any).safety = safety;
    throw error;
  }

  if (safety.currentPercent <= 0) {
    return {
      changed: false,
      message: `No active ${discountType.toLowerCase()} discount found for ${safety.customer.name}.`,
      safety,
      customer: safety.customer,
    };
  }

  const discountField =
    discountType === "LOYALTY" ? "loyaltyPercent" : "wholesalePercent";

  return prisma.$transaction(async (tx) => {
    const customer = await tx.customer.update({
      where: { id: customerId },
      data: { [discountField]: 0 },
      select: {
        id: true,
        name: true,
        phone: true,
        loyaltyPercent: true,
        wholesalePercent: true,
      },
    });

    await tx.auditLog.create({
      data: {
        actorId,
        action: "CUSTOMER_DISCOUNT_DELETED",
        entityType: "Customer",
        entityId: customer.id,
        meta: {
          customerName: customer.name,
          phone: customer.phone,
          discountType,
          previousPercent: safety.currentPercent,
        },
      },
    });

    return {
      changed: true,
      message: `${discountType === "LOYALTY" ? "Loyalty" : "Wholesale"} discount deleted for ${customer.name}.`,
      customer,
      safety: {
        ...safety,
        currentPercent: 0,
        canDelete: false,
        reason: `No active ${discountType.toLowerCase()} discount is set for this customer.`,
      },
    };
  });
}

// soft-deactivating a customer by setting isActive to false
// we do not delete the record because the customer might be linked to existing invoices
export async function deactivateCustomer(id: string, actorId?: string) {
  return prisma.$transaction(async (tx) => {
    const customer = await tx.customer.update({
      where: { id },
      data: { isActive: false },
      select: { id: true, name: true, phone: true, isActive: true },
    });

    if (actorId) {
      await tx.auditLog.create({
        data: {
          actorId,
          action: "CUSTOMER_DEACTIVATED",
          entityType: "Customer",
          entityId: customer.id,
          meta: {
            customerName: customer.name,
            phone: customer.phone,
          },
        },
      });
    }

    return customer;
  });
}
