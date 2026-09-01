// Shared product utility functions used by both CRUD operations and import logic.
// Extracted from service.ts to avoid circular dependencies between service.ts and importService.ts.

import prisma from "../../db/prisma";

// normalizing a unit label to uppercase, falling back to a default if blank
export function normalizeUnitLabel(value: unknown, fallback: string) {
    const normalized = String(value || "").trim().toUpperCase();
    return normalized || fallback;
}

// converting any value to a positive number, returning the fallback if invalid
export function normalizePositiveNumber(value: unknown, fallback: number) {
    const normalized = Number(value ?? fallback);
    if (!Number.isFinite(normalized) || normalized <= 0) return fallback;
    return normalized;
}

// rounding a currency value to two decimal places
export function roundCurrency(value: number) {
    return Math.round(Number(value || 0) * 100) / 100;
}

export function normalizeSellingPrice(value: unknown) {
    if (value === undefined || value === null || value === "") return null;
    const normalized = Number(value);
    return Number.isFinite(normalized) && normalized > 0
        ? roundCurrency(normalized)
        : null;
}

// A product may be useful in catalog mode before the shop has approved its
// customer-facing prices. Billing must only use products whose two selling
// prices are explicitly present.
export function resolveSellingPriceStatus(
    retailPrice: unknown,
    wholesalePrice: unknown,
) {
    return normalizeSellingPrice(retailPrice) !== null &&
        normalizeSellingPrice(wholesalePrice) !== null
        ? "READY" as const
        : "PENDING" as const;
}

export function buildInitialSupplierStock(packageQuantity: unknown) {
    return 0;
}

// the minimal transaction interface needed by allocateProductIdentifiers
// this allows the function to work with both full Prisma transactions and test mocks
export type ProductIdentifierTransaction = {
    productSequence: {
        upsert: (args: any) => Promise<{ lastNumber: number }>;
    };
    product: {
        findUnique: (args: any) => Promise<{ id: string } | null>;
    };
};

// allocating unique SKU and barcode identifiers for a new product
// when no SKU is provided, a sequential KS-XXXXXX identifier is generated
// when no barcode is provided, a sequential KSB-XXXXXXXXXX internal barcode is generated
export async function allocateProductIdentifiers(
    tx: ProductIdentifierTransaction,
    requestedSku?: string | null,
    requestedBarcode?: string | null,
) {
    let sku = String(requestedSku || "").trim().toUpperCase();
    let generatedNumber: number | null = null;
    while (!sku) {
        const counter = await tx.productSequence.upsert({
            where: { id: "product" },
            create: { id: "product", lastNumber: 1 },
            update: { lastNumber: { increment: 1 } },
            select: { lastNumber: true },
        });
        generatedNumber = counter.lastNumber;
        const candidate = `KS-${String(counter.lastNumber).padStart(6, "0")}`;
        const exists = await tx.product.findUnique({ where: { sku: candidate }, select: { id: true } });
        if (!exists) sku = candidate;
    }

    const normalizedRequestedBarcode = String(requestedBarcode || "").trim();
    let barcode = normalizedRequestedBarcode;
    while (!barcode) {
        if (generatedNumber === null) {
            const counter = await tx.productSequence.upsert({
                where: { id: "product" },
                create: { id: "product", lastNumber: 1 },
                update: { lastNumber: { increment: 1 } },
                select: { lastNumber: true },
            });
            generatedNumber = counter.lastNumber;
        }
        const candidate = `KSB${String(generatedNumber).padStart(10, "0")}`;
        const exists = await tx.product.findUnique({ where: { barcode: candidate }, select: { id: true } });
        if (!exists) barcode = candidate;
        else generatedNumber = null;
    }

    return {
        sku,
        barcode,
        barcodeOrigin: normalizedRequestedBarcode ? "MANUFACTURER" : "INTERNAL",
    } as const;
}
