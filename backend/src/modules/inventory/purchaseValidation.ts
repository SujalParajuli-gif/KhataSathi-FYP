import crypto from "crypto";
import { Prisma } from "@prisma/client";

export const PurchaseDecimal = Prisma.Decimal.clone({ precision: 64 });
const Decimal = PurchaseDecimal;

export const MAX_QTY = new Decimal("999999999999999.999"); // Decimal(18, 3)
export const MAX_CONVERSION_FACTOR = new Decimal("999999999999.999999"); // Decimal(18, 6)
export const MAX_ACQUISITION_COST = new Decimal("99999999999999.999999"); // Decimal(20, 6)
export const MAX_MONEY_DECIMAL = new Decimal("999999999999999999.99"); // Decimal(20, 2)

export function parseDecimalString(
    raw: unknown,
    label: string,
    options: {
        maxDecimals: number;
        allowZero?: boolean;
        min?: InstanceType<typeof Decimal>;
        max?: InstanceType<typeof Decimal>;
    }
): InstanceType<typeof Decimal> {
    if (raw === null || raw === undefined || raw === "") {
        throw new Error(`${label} is required`);
    }

    if (
        typeof raw === "object" &&
        !Prisma.Decimal.isDecimal(raw) &&
        !(raw instanceof Decimal)
    ) {
        throw new Error(`${label} must be a valid numeric string or number`);
    }

    if (typeof raw === "number") {
        if (!Number.isFinite(raw)) {
            throw new Error(`${label} must be a finite number`);
        }
        if (Number.isNaN(raw)) {
            throw new Error(`${label} cannot be NaN`);
        }
    }

    const str = String(raw).trim();
    if (!str) {
        throw new Error(`${label} is required`);
    }

    // Strict regex check: prevent exponential notation like 1e5, hex, leading junk
    if (!/^-?\d+(\.\d+)?$/.test(str)) {
        throw new Error(`${label} contains an invalid numeric format`);
    }

    let parsed: InstanceType<typeof Decimal>;
    try {
        parsed = new Decimal(str);
    } catch {
        throw new Error(`${label} contains an invalid decimal value`);
    }

    if (parsed.isNaN() || !parsed.isFinite()) {
        throw new Error(`${label} must be a finite valid number`);
    }

    // Check decimal places
    const decPlaces = parsed.decimalPlaces();
    if (decPlaces > options.maxDecimals) {
        throw new Error(
            `${label} exceeds maximum allowed precision of ${options.maxDecimals} decimal places`
        );
    }

    if (options.min !== undefined && parsed.lt(options.min)) {
        throw new Error(`${label} cannot be less than ${options.min.toString()}`);
    }

    if (options.max !== undefined && parsed.gt(options.max)) {
        throw new Error(`${label} cannot exceed ${options.max.toString()}`);
    }

    if (!options.allowZero && parsed.isZero()) {
        throw new Error(`${label} must be greater than zero`);
    }

    return parsed;
}

export function validateScalarId(raw: unknown, label: string): string {
    if (raw === null || raw === undefined || raw === "") {
        throw new Error(`${label} is required`);
    }
    if (typeof raw !== "string") {
        throw new Error(`${label} must be a string`);
    }
    const trimmed = raw.trim();
    if (!trimmed) {
        throw new Error(`${label} is required`);
    }
    if (trimmed.length > 120) {
        throw new Error(`${label} cannot exceed 120 characters`);
    }
    return trimmed;
}

export function validateDocumentIds(rawDocIds: unknown): string[] {
    if (rawDocIds === undefined || rawDocIds === null) {
        return [];
    }
    if (!Array.isArray(rawDocIds)) {
        throw new Error("documentIds must be an array of strings");
    }
    if (rawDocIds.length > 10) {
        throw new Error("Cannot attach more than 10 documents");
    }
    const seen = new Set<string>();
    const result: string[] = [];
    for (let i = 0; i < rawDocIds.length; i++) {
        const item = rawDocIds[i];
        if (typeof item !== "string") {
            throw new Error(`Invalid document ID at index ${i}: must be a non-empty string`);
        }
        const trimmed = item.trim();
        if (!trimmed) {
            throw new Error(`Invalid document ID at index ${i}: cannot be empty`);
        }
        if (trimmed.length > 120) {
            throw new Error(`Invalid document ID at index ${i}: cannot exceed 120 characters`);
        }
        if (!seen.has(trimmed)) {
            seen.add(trimmed);
            result.push(trimmed);
        }
    }
    return result.sort();
}

export function validateBillDate(raw: unknown): string | null {
    if (raw === null || raw === undefined || raw === "") {
        return null;
    }
    if (raw instanceof Date) {
        if (Number.isNaN(raw.getTime())) {
            throw new Error("Invalid bill date");
        }
        return raw.toISOString().slice(0, 10);
    }
    if (typeof raw !== "string") {
        throw new Error("Bill date must be a valid YYYY-MM-DD string or Date object");
    }
    const str = raw.trim();
    if (!str) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) {
        throw new Error(`Invalid bill date format "${str}". Expected YYYY-MM-DD`);
    }
    const [y, m, d] = str.split("-").map(Number);
    const dateObj = new Date(Date.UTC(y, m - 1, d));
    if (
        dateObj.getUTCFullYear() !== y ||
        dateObj.getUTCMonth() + 1 !== m ||
        dateObj.getUTCDate() !== d
    ) {
        throw new Error(`Invalid real calendar date "${str}"`);
    }
    return str;
}

export type AllowedPurchaseActorRole = "ADMIN" | "MANAGER";

export function validatePurchaseActorRole(role: unknown): AllowedPurchaseActorRole {
    if (typeof role !== "string") {
        throw new Error("Actor role is required and must be ADMIN or MANAGER");
    }
    const normalized = role.trim().toUpperCase();
    if (normalized !== "ADMIN" && normalized !== "MANAGER") {
        throw new Error(
            `Unauthorized actor role "${role}". Only ADMIN or MANAGER can access purchase operations`
        );
    }
    return normalized as AllowedPurchaseActorRole;
}

export type ValidatedPurchaseLine = {
    lineOrder: number;
    productId: string;
    inputUnit: string;
    inputQty: InstanceType<typeof Decimal>;
    conversionFactor: InstanceType<typeof Decimal>;
    stockQty: InstanceType<typeof Decimal>;
    unitAcquisitionCost: InstanceType<typeof Decimal>;
    lineAmount: InstanceType<typeof Decimal>;
};

export type ValidatedSupplierInput = {
    name: string;
    contact: string | null;
    phone: string | null;
    panNo: string | null;
    address: string | null;
    isActive: boolean;
};

export function validateSupplierInput(input: any): ValidatedSupplierInput {
    if (!input || typeof input !== "object") {
        throw new Error("Supplier data is required");
    }

    const name = String(input.name || "").trim();
    if (!name) {
        throw new Error("Supplier name is required");
    }
    if (name.length > 160) {
        throw new Error("Supplier name cannot exceed 160 characters");
    }

    const contact =
        input.contact !== undefined && input.contact !== null
            ? String(input.contact).trim()
            : null;
    if (contact && contact.length > 160) {
        throw new Error("Contact cannot exceed 160 characters");
    }

    const phone =
        input.phone !== undefined && input.phone !== null
            ? String(input.phone).trim()
            : null;
    if (phone && phone.length > 40) {
        throw new Error("Phone cannot exceed 40 characters");
    }

    const rawPan = input.panNo ?? input.pan ?? input.panNumber;
    const panNo =
        rawPan !== undefined && rawPan !== null ? String(rawPan).trim() : null;
    if (panNo && panNo.length > 40) {
        throw new Error("PAN number cannot exceed 40 characters");
    }

    const address =
        input.address !== undefined && input.address !== null
            ? String(input.address).trim()
            : null;
    if (address && address.length > 500) {
        throw new Error("Address cannot exceed 500 characters");
    }

    const isActive = input.isActive !== undefined ? Boolean(input.isActive) : true;

    return {
        name,
        contact: contact || null,
        phone: phone || null,
        panNo: panNo || null,
        address: address || null,
        isActive,
    };
}

export type ValidatedPartialSupplierInput = {
    name?: string;
    contact?: string | null;
    phone?: string | null;
    panNo?: string | null;
    address?: string | null;
    isActive?: boolean;
};

export function validatePartialSupplierInput(input: any): ValidatedPartialSupplierInput {
    if (!input || typeof input !== "object") {
        throw new Error("Supplier data is required");
    }
    const result: ValidatedPartialSupplierInput = {};

    if (input.name !== undefined) {
        if (typeof input.name !== "string") {
            throw new Error("Supplier name must be a string");
        }
        const name = input.name.trim();
        if (!name) {
            throw new Error("Supplier name cannot be empty");
        }
        if (name.length > 160) {
            throw new Error("Supplier name cannot exceed 160 characters");
        }
        result.name = name;
    }

    if (input.contact !== undefined) {
        if (input.contact === null) {
            result.contact = null;
        } else {
            if (typeof input.contact !== "string") throw new Error("Contact must be a string");
            const contact = input.contact.trim();
            if (contact.length > 160) throw new Error("Contact cannot exceed 160 characters");
            result.contact = contact || null;
        }
    }

    if (input.phone !== undefined) {
        if (input.phone === null) {
            result.phone = null;
        } else {
            if (typeof input.phone !== "string") throw new Error("Phone must be a string");
            const phone = input.phone.trim();
            if (phone.length > 40) throw new Error("Phone cannot exceed 40 characters");
            result.phone = phone || null;
        }
    }

    const rawPan = input.panNo ?? input.pan ?? input.panNumber;
    if (rawPan !== undefined) {
        if (rawPan === null) {
            result.panNo = null;
        } else {
            if (typeof rawPan !== "string") throw new Error("PAN number must be a string");
            const panNo = rawPan.trim();
            if (panNo.length > 40) throw new Error("PAN number cannot exceed 40 characters");
            result.panNo = panNo || null;
        }
    }

    if (input.address !== undefined) {
        if (input.address === null) {
            result.address = null;
        } else {
            if (typeof input.address !== "string") throw new Error("Address must be a string");
            const address = input.address.trim();
            if (address.length > 500) throw new Error("Address cannot exceed 500 characters");
            result.address = address || null;
        }
    }

    if (input.isActive !== undefined) {
        result.isActive = Boolean(input.isActive);
    }

    return result;
}

export function validateUnitConversion(
    product: {
        id: string;
        name: string;
        sku: string;
        saleUnit: string;
        packageUnit: string;
        packageQuantity: number | null;
    },
    inputUnit: string,
    conversionFactor: InstanceType<typeof Decimal>
): void {
    const normInputUnit = String(inputUnit || "").trim().toUpperCase();
    const normSaleUnit = String(product.saleUnit || "PIECE").trim().toUpperCase();
    const normPackageUnit = String(product.packageUnit || "PIECE").trim().toUpperCase();

    if (normInputUnit === normSaleUnit) {
        if (!conversionFactor.equals(new Decimal(1))) {
            throw new Error(
                `Unit conversion factor for sale unit "${normSaleUnit}" on product "${product.name}" (${product.sku}) must be 1`
            );
        }
        return;
    }

    if (normInputUnit === normPackageUnit && normPackageUnit !== normSaleUnit) {
        const expectedPkgQty =
            product.packageQuantity != null ? Number(product.packageQuantity) : null;
        if (!expectedPkgQty || expectedPkgQty <= 0) {
            throw new Error(
                `Product "${product.name}" (${product.sku}) does not have a positive package quantity configured for package unit "${normPackageUnit}"`
            );
        }
        const expectedDec = new Decimal(expectedPkgQty);
        if (!conversionFactor.equals(expectedDec)) {
            throw new Error(
                `Unit conversion factor (${conversionFactor.toString()}) does not match product "${product.name}" configured package quantity (${expectedDec.toString()})`
            );
        }
        return;
    }

    throw new Error(
        `Unsupported input unit "${inputUnit}" for product "${product.name}" (${product.sku}). Allowed units are "${normSaleUnit}"${
            normPackageUnit !== normSaleUnit ? ` and "${normPackageUnit}"` : ""
        }`
    );
}

export function validatePurchaseReceiptLines(rawLines: any[]): ValidatedPurchaseLine[] {
    if (!Array.isArray(rawLines) || rawLines.length === 0) {
        throw new Error("At least one purchase receipt line is required");
    }
    if (rawLines.length > 200) {
        throw new Error("Purchase receipt cannot exceed 200 lines");
    }

    return rawLines.map((line, index) => {
        const lineOrder = index + 1;
        const productId = validateScalarId(line?.productId, `Line ${lineOrder} product ID`);

        const inputUnit = String(line?.inputUnit || "").trim().toUpperCase();
        if (!inputUnit) {
            throw new Error(`Input unit is required for line ${lineOrder}`);
        }
        if (inputUnit.length > 40) {
            throw new Error(`Input unit for line ${lineOrder} cannot exceed 40 characters`);
        }

        const inputQty = parseDecimalString(line?.inputQty, `Line ${lineOrder} input quantity`, {
            maxDecimals: 3,
            allowZero: false,
            min: new Decimal("0.001"),
            max: MAX_QTY,
        });

        const conversionFactor = parseDecimalString(
            line?.conversionFactor ?? 1,
            `Line ${lineOrder} conversion factor`,
            {
                maxDecimals: 6,
                allowZero: false,
                min: new Decimal("0.000001"),
                max: MAX_CONVERSION_FACTOR,
            }
        );

        const stockQty = inputQty.mul(conversionFactor);
        if (stockQty.gt(MAX_QTY)) {
            throw new Error(
                `Stock quantity derived from conversion (${stockQty.toString()}) on line ${lineOrder} exceeds maximum allowable bound`
            );
        }
        if (stockQty.decimalPlaces() > 3) {
            throw new Error(
                `Stock quantity derived from conversion (${stockQty.toString()}) on line ${lineOrder} exceeds maximum 3 decimal places`
            );
        }

        if (
            line?.unitAcquisitionCost === undefined ||
            line?.unitAcquisitionCost === null ||
            line?.unitAcquisitionCost === ""
        ) {
            throw new Error(`Line ${lineOrder} unit acquisition cost is required`);
        }

        const unitAcquisitionCost = parseDecimalString(
            line.unitAcquisitionCost,
            `Line ${lineOrder} unit acquisition cost`,
            {
                maxDecimals: 6,
                allowZero: true,
                min: new Decimal(0),
                max: MAX_ACQUISITION_COST,
            }
        );

        // lineAmount = inputQty * unitAcquisitionCost rounded HALF_UP to 2 decimal places
        const computedLineAmount = inputQty
            .mul(unitAcquisitionCost)
            .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

        if (computedLineAmount.gt(MAX_MONEY_DECIMAL)) {
            throw new Error(
                `Line amount on line ${lineOrder} exceeds maximum allowable bound`
            );
        }

        if (line?.lineAmount !== undefined && line?.lineAmount !== null) {
            const suppliedLineAmount = parseDecimalString(
                line.lineAmount,
                `Line ${lineOrder} supplied line amount`,
                {
                    maxDecimals: 2,
                    allowZero: true,
                    min: new Decimal(0),
                    max: MAX_MONEY_DECIMAL,
                }
            );
            if (!suppliedLineAmount.equals(computedLineAmount)) {
                throw new Error(
                    `Line ${lineOrder} supplied amount (${suppliedLineAmount.toFixed(2)}) does not match computed quantity * cost (${computedLineAmount.toFixed(2)})`
                );
            }
        }

        return {
            lineOrder,
            productId,
            inputUnit,
            inputQty,
            conversionFactor,
            stockQty,
            unitAcquisitionCost,
            lineAmount: computedLineAmount,
        };
    });
}

export function validatePayableReconciliation(
    lines: ValidatedPurchaseLine[],
    rawPayable: unknown
): InstanceType<typeof Decimal> {
    const totalLineAmount = lines.reduce(
        (sum, line) => sum.add(line.lineAmount),
        new Decimal(0)
    );

    if (totalLineAmount.gt(MAX_MONEY_DECIMAL)) {
        throw new Error("Total purchase payable exceeds maximum allowable bound");
    }

    const reviewedPayable = parseDecimalString(rawPayable, "Reviewed payable", {
        maxDecimals: 2,
        allowZero: true,
        min: new Decimal(0),
        max: MAX_MONEY_DECIMAL,
    });

    if (!totalLineAmount.equals(reviewedPayable)) {
        throw new Error(
            `Reconciliation error: sum of line amounts (${totalLineAmount.toFixed(
                2
            )}) does not match reviewed payable (${reviewedPayable.toFixed(2)})`
        );
    }

    return reviewedPayable;
}

export type NormalizedPurchaseReceiptPayload = {
    actorId: string;
    supplierId: string;
    billNumber: string | null;
    billDate: string | null;
    remarks: string | null;
    reason: string | null;
    payable: string;
    lines: Array<{
        lineOrder: number;
        productId: string;
        inputUnit: string;
        inputQty: string;
        conversionFactor: string;
        stockQty: string;
        unitAcquisitionCost: string;
        lineAmount: string;
    }>;
    documentIds: string[];
};

export function buildNormalizedPurchaseReceiptPayload(params: {
    actorId: string;
    supplierId: string;
    billNumber?: string | null;
    billDate?: string | Date | null;
    remarks?: string | null;
    reason?: string | null;
    payable: InstanceType<typeof Decimal>;
    lines: ValidatedPurchaseLine[];
    documentIds?: string[];
}): NormalizedPurchaseReceiptPayload {
    const actorId = validateScalarId(params.actorId, "Actor ID");
    const supplierId = validateScalarId(params.supplierId, "Supplier ID");
    const billDateStr = validateBillDate(params.billDate);
    const sortedDocIds = validateDocumentIds(params.documentIds);

    return {
        actorId,
        supplierId,
        billNumber: params.billNumber ? String(params.billNumber).trim() : null,
        billDate: billDateStr,
        remarks: params.remarks ? String(params.remarks).trim() : null,
        reason: params.reason ? String(params.reason).trim() : null,
        payable: params.payable.toFixed(2),
        lines: params.lines.map((l) => ({
            lineOrder: l.lineOrder,
            productId: l.productId,
            inputUnit: l.inputUnit,
            inputQty: l.inputQty.toFixed(3),
            conversionFactor: l.conversionFactor.toFixed(6),
            stockQty: l.stockQty.toFixed(3),
            unitAcquisitionCost: l.unitAcquisitionCost.toFixed(6),
            lineAmount: l.lineAmount.toFixed(2),
        })),
        documentIds: sortedDocIds,
    };
}

export function hashPurchaseReceiptPayload(
    payload: NormalizedPurchaseReceiptPayload
): string {
    const canonicalJson = JSON.stringify(payload);
    return crypto.createHash("sha256").update(canonicalJson).digest("hex");
}

export const VALID_PAYMENT_METHODS = ["CASH", "BANK_TRANSFER", "OTHER"] as const;
export type ValidPaymentMethod = (typeof VALID_PAYMENT_METHODS)[number];

export function validateInstallmentInput(input: any): {
    amount: InstanceType<typeof Decimal>;
    method: ValidPaymentMethod;
    reference: string | null;
    paidAt: Date;
    operationKey: string;
} {
    if (!input || typeof input !== "object") {
        throw new Error("Installment payment data is required");
    }

    const amount = parseDecimalString(input.amount, "Payment amount", {
        maxDecimals: 2,
        allowZero: false,
        min: new Decimal("0.01"),
        max: MAX_MONEY_DECIMAL,
    });

    const methodRaw = String(input.method || "").trim().toUpperCase();
    if (!VALID_PAYMENT_METHODS.includes(methodRaw as any)) {
        throw new Error(
            `Invalid payment method "${methodRaw}". Must be one of: ${VALID_PAYMENT_METHODS.join(
                ", "
            )}`
        );
    }
    const method = methodRaw as ValidPaymentMethod;

    const reference =
        input.reference !== undefined && input.reference !== null
            ? String(input.reference).trim()
            : null;

    if (method !== "CASH" && !reference) {
        throw new Error(`Payment reference is required for ${method}`);
    }
    if (reference && reference.length > 120) {
        throw new Error("Payment reference cannot exceed 120 characters");
    }

    if (!input.paidAt) {
        throw new Error("Payment date is required");
    }
    const paidAt = input.paidAt instanceof Date ? input.paidAt : new Date(input.paidAt);
    if (Number.isNaN(paidAt.getTime())) {
        throw new Error("Invalid payment date");
    }

    const operationKey = validateScalarId(input.operationKey, "Payment operation key");

    return {
        amount,
        method,
        reference: reference || null,
        paidAt,
        operationKey,
    };
}

export type NormalizedInstallmentPayload = {
    actorId: string;
    batchId: string;
    amount: string;
    method: string;
    reference: string | null;
    paidAt: string;
};

export function buildNormalizedInstallmentPayload(params: {
    actorId: string;
    batchId: string;
    amount: InstanceType<typeof Decimal>;
    method: string;
    reference: string | null;
    paidAt: Date;
}): NormalizedInstallmentPayload {
    const actorId = validateScalarId(params.actorId, "Actor ID");
    const batchId = validateScalarId(params.batchId, "Batch ID");
    if (!(params.paidAt instanceof Date) || Number.isNaN(params.paidAt.getTime())) {
        throw new Error("Invalid payment date object for normalized installment payload");
    }
    return {
        actorId,
        batchId,
        amount: params.amount.toFixed(2),
        method: String(params.method || "").trim(),
        reference: params.reference ? String(params.reference).trim() : null,
        paidAt: params.paidAt.toISOString(), // Full ISO string preserving time
    };
}

export function hashInstallmentPayload(payload: NormalizedInstallmentPayload): string {
    const canonicalJson = JSON.stringify(payload);
    return crypto.createHash("sha256").update(canonicalJson).digest("hex");
}

export function validateVoidPaymentInput(input: any): { voidReason: string } {
    if (!input || typeof input !== "object") {
        throw new Error("Void data is required");
    }

    const rawReason = input.voidReason ?? input.reason;
    const voidReason = String(rawReason || "").trim();
    if (!voidReason) {
        throw new Error("Void reason is required");
    }
    if (voidReason.length < 3) {
        throw new Error("Void reason must be at least 3 characters");
    }
    if (voidReason.length > 500) {
        throw new Error("Void reason cannot exceed 500 characters");
    }

    return { voidReason };
}
