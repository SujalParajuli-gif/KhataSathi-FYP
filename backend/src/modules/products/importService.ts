// Product import logic â€” extracted from service.ts for maintainability.
// Handles CSV/XLSX, PDF, and image (AI) import workflows including:
// preview creation, batch CRUD, reviewed row management, and final import.

import {
    Prisma,
    type ProductImportRow,
} from "@prisma/client";
import prisma from "../../db/prisma";
import { getBusinessSettings } from "../settings/service";
import {
    getEnabledSearchSynonymRules,
    prepareReviewedProductAlias,
    rebuildProductSearchDocument,
} from "./searchAliasService";
import {
    normalizeUnitLabel,
    normalizePositiveNumber,
    roundCurrency,
    allocateProductIdentifiers,
    normalizeSellingPrice,
    resolveSellingPriceStatus,
} from "./productUtils";
import {
    compareImportRowsToCatalog,
    fingerprintImportFile,
    resolveProductAvailability,
    type ComparableImportRow,
} from "./importComparison";
import {
    getImportSourcePath,
    removeImportSource,
    storeImportSource,
} from "./importSourceStorage";
import { parsePdfTextCatalogPages } from "./pdfTextCatalogParser";

export { fingerprintImportFile };

type ProductImportPreviewRowDraft = {
    rowNumber: number;
    rawText: string | null;
    status: string;
    error?: string | null;
    parsed?: Prisma.InputJsonValue;
    extracted?: Prisma.InputJsonValue;
    sourceLocator?: Prisma.InputJsonValue;
    comparisonStatus?:
        | "READY_NEW"
        | "EXACT_DUPLICATE"
        | "MATCHED_WITH_CHANGES"
        | "IDENTIFIER_CONFLICT"
        | "IN_FILE_DUPLICATE"
        | "NEEDS_REVIEW"
        | "FAILED";
    matchedProductId?: string | null;
    changeSet?: Prisma.InputJsonValue;
    resolution?: "CREATE_NEW" | "UPDATE_MATCHED" | "KEEP_EXISTING" | "IGNORE" | null;
};

type CsvImportRow = {
    name: string;
    productName?: string | null;
    sku: string;
    skuWasGenerated?: boolean;
    barcode?: string;
    brand?: string;
    brandId?: string;
    category?: string;
    categoryGroup?: string | null;
    vendorSource?: string | null;
    productCodeVariant?: string | null;
    sizeValue?: number | null;
    sizeUnit?: string | null;
    ratePerPiece?: number | null;
    packageQuantity?: number | null;
    packageUnit?: string | null;
    saleUnit?: string | null;
    allowFractionalQty?: boolean;
    quantityStep?: number;
    wholesaleEligible?: boolean;
    sourceCitation?: string | null;
    searchAliases?: string[];
    retailPrice: number | null;
    wholesalePrice: number | null;
    stock?: number;
};

// defining the shape of an import error — includes the row number and original values for debugging
type CsvImportError = {
    rowNumber: number;
    sku?: string;
    name?: string;
    message: string;
};

type ReviewedPdfImportRowInput = {
    rowId: string;
    name?: string;
    sku?: string;
    barcode?: string;
    brand?: string;
    category?: string;
    categoryGroup?: string;
    vendorSource?: string;
    productCodeVariant?: string;
    sizeValue?: number | string | null;
    sizeUnit?: string;
    ratePerPiece?: number | string | null;
    packageQuantity?: number | string | null;
    packageUnit?: string;
    saleUnit?: string;
    allowFractionalQty?: boolean;
    quantityStep?: number | string;
    wholesaleEligible?: boolean;
    sourceCitation?: string;
    searchAliases?: string[] | string;
    retailPrice?: number | string | null;
    wholesalePrice?: number | string | null;
    stock?: number | string;
    resolution?: "CREATE_NEW" | "UPDATE_MATCHED" | "KEEP_EXISTING" | "IGNORE";
};

export class ReviewedImportRowValidationError extends Error {
    statusCode = 400;
}

function reviewedDraftText(value: unknown, label: string, required = false) {
    const normalized = String(value || "").trim().replace(/\s+/g, " ");
    if (required && !normalized) {
        throw new ReviewedImportRowValidationError(`${label} is required.`);
    }
    return normalized || undefined;
}

function reviewedDraftNumber(
    value: unknown,
    label: string,
    options: { min: number; required?: boolean },
) {
    if (value === undefined || value === null || value === "") {
        if (options.required) {
            throw new ReviewedImportRowValidationError(`${label} is required.`);
        }
        return undefined;
    }
    const normalized = Number(value);
    if (!Number.isFinite(normalized) || normalized < options.min) {
        throw new ReviewedImportRowValidationError(
            `${label} must be a number of at least ${options.min}.`,
        );
    }
    return normalized;
}

function reviewedSearchAliases(value: unknown) {
    const values = Array.isArray(value)
        ? value
        : typeof value === "string"
            ? value.split(/[,;\n]/g)
            : [];
    if (values.length > 20) {
        throw new ReviewedImportRowValidationError(
            "A product can have at most 20 search terms.",
        );
    }
    const prepared = values
        .map((alias) => String(alias || "").trim())
        .filter(Boolean)
        .map((alias) => prepareReviewedProductAlias(alias));
    return [...new Map(prepared.map((alias) => [alias.normalizedAlias, alias.alias])).values()];
}

function reviewedImportResolution(value: unknown) {
    if (value === undefined || value === null || value === "") return undefined;
    const normalized = String(value).trim().toUpperCase();
    if (!["CREATE_NEW", "UPDATE_MATCHED", "KEEP_EXISTING", "IGNORE"].includes(normalized)) {
        throw new ReviewedImportRowValidationError("Import row decision is not supported.");
    }
    return normalized as "CREATE_NEW" | "UPDATE_MATCHED" | "KEEP_EXISTING" | "IGNORE";
}

export function prepareReviewedImportRowDraft(input: ReviewedPdfImportRowInput) {
    const rowId = reviewedDraftText(input.rowId, "Import row", true)!;
    const name = reviewedDraftText(input.name, "Product name", true)!;
    const sku = reviewedDraftText(input.sku, "SKU", true)!;
    const ratePerPiece = reviewedDraftNumber(input.ratePerPiece, "Purchase cost", {
        min: 0.01,
    }) ?? null;
    const packageQuantity = reviewedDraftNumber(
        input.packageQuantity,
        "Package quantity",
        { min: 0.001 },
    ) ?? null;
    const quantityStep = reviewedDraftNumber(
        input.quantityStep ?? 1,
        "Quantity step",
        { min: 0.001, required: true },
    )!;
    const stock = reviewedDraftNumber(input.stock ?? 0, "Stock", {
        min: 0,
        required: true,
    })!;
    const retailPrice = reviewedDraftNumber(
        input.retailPrice,
        "Retail price",
        { min: 0.01 },
    ) ?? null;
    const wholesalePrice = reviewedDraftNumber(
        input.wholesalePrice,
        "Wholesale price",
        { min: 0.01 },
    ) ?? null;
    const sizeValue = reviewedDraftNumber(input.sizeValue, "Size value", {
        min: 0,
    });

    return {
        rowId,
        name,
        sku,
        barcode: reviewedDraftText(input.barcode, "Barcode"),
        brand: reviewedDraftText(input.brand, "Brand") || "Unbranded",
        category: reviewedDraftText(input.category, "Category") || "Uncategorized",
        categoryGroup: reviewedDraftText(input.categoryGroup, "Category group"),
        vendorSource: reviewedDraftText(input.vendorSource, "Supplier / source"),
        productCodeVariant: reviewedDraftText(input.productCodeVariant, "Variant / code"),
        sizeValue: sizeValue ?? null,
        sizeUnit: reviewedDraftText(input.sizeUnit, "Size unit") || "STANDARD",
        ratePerPiece,
        packageQuantity,
        packageUnit: reviewedDraftText(input.packageUnit, "Package unit") || "PIECE",
        saleUnit: reviewedDraftText(input.saleUnit, "Sale unit") || "PIECE",
        allowFractionalQty: input.allowFractionalQty === true,
        quantityStep,
        wholesaleEligible: input.wholesaleEligible !== false,
        sourceCitation: reviewedDraftText(input.sourceCitation, "Source citation"),
        searchAliases: reviewedSearchAliases(input.searchAliases),
        retailPrice,
        wholesalePrice,
        stock,
        resolution: reviewedImportResolution(input.resolution),
    };
}

type ProductImportColumnMap = Record<string, string | string[] | undefined>;

type ProductImportDefaults = {
    supplier?: string;
    brand?: string;
    category?: string;
    categoryGroup?: string;
    packageUnit?: string;
    saleUnit?: string;
    stock?: number;
    retailMarginPercent?: number;
    wholesaleEligible?: boolean;
};

type CsvImportOptions = {
    fieldMap?: ProductImportColumnMap;
    defaults?: ProductImportDefaults;
};

export async function findRepeatedProductImportBatch(fileFingerprint: string) {
    return prisma.productImportBatch.findFirst({
        where: {
            fileFingerprint,
            deletedAt: null,
        },
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            sourceType: true,
            fileName: true,
            status: true,
            totalRows: true,
            importedRows: true,
            failedRows: true,
            extractionMeta: true,
            createdAt: true,
        },
    });
}

// safely converting a CSV cell value to a trimmed string
function normalizeCsvText(value: unknown) {
    if (typeof value === "string") return value.trim();
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
    if (typeof value === "bigint" || typeof value === "boolean") return String(value);
    return "";
}

function getCsvCell(row: Record<string, unknown>, ...names: string[]) {
    for (const name of names) {
        const key = name.trim().toLowerCase();
        const value = row[key];
        if (value !== undefined && value !== null && String(value).trim() !== "") {
            return value;
        }
    }
    return undefined;
}

function getMappedCsvCell(
    row: Record<string, unknown>,
    fieldMap: ProductImportColumnMap | undefined,
    canonicalName: string,
    ...aliases: string[]
) {
    const mapped = fieldMap?.[canonicalName];
    const mappedNames = Array.isArray(mapped) ? mapped : mapped ? [mapped] : [];
    return getCsvCell(row, ...mappedNames, ...aliases);
}

function slugifySkuPart(value: string) {
    return value
        .normalize("NFKD")
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/[_\s]+/g, "-")
        .replace(/-+/g, "-")
        .toUpperCase()
        .slice(0, 36);
}

function parseBooleanCsvValue(value: unknown, fallback: boolean) {
    const normalized = normalizeCsvText(value).toLowerCase();
    if (!normalized) return fallback;
    if (["true", "yes", "y", "1"].includes(normalized)) return true;
    if (["false", "no", "n", "0"].includes(normalized)) return false;
    return fallback;
}

function parseCsvSearchAliases(value: unknown) {
    if (Array.isArray(value)) return reviewedSearchAliases(value);
    const normalized = normalizeCsvText(value);
    return normalized ? reviewedSearchAliases(normalized) : [];
}

function escapeImportRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function importNumberPattern(value: number) {
    const normalized = String(Number(value || 0));
    if (!normalized || normalized === "0") return "";
    const [whole, decimal] = normalized.split(".");
    const formattedWhole = Number(whole).toLocaleString("en-US", {
        maximumFractionDigits: 0,
    });
    const wholePattern =
        formattedWhole === whole
            ? escapeImportRegExp(whole)
            : `(?:${escapeImportRegExp(whole)}|${escapeImportRegExp(formattedWhole)})`;
    return decimal
        ? `${wholePattern}\\.${escapeImportRegExp(decimal)}0*`
        : `${wholePattern}(?:\\.0+)?`;
}

function cleanImportedProductName(rawName: string, rate?: number) {
    const normalized = normalizeCsvText(rawName);
    if (!normalized) return "";

    const ratePattern = rate === undefined ? "" : importNumberPattern(rate);
    let cleaned = normalized;
    if (ratePattern) {
        const withoutRate = cleaned
            .replace(new RegExp(`\\bMRP\\b\\s*(?:Rs\\.?|NPR)?\\s*${ratePattern}\\b`, "i"), " ")
            .replace(new RegExp(`(?:Rs\\.?|NPR|Price|Rate)\\s*${ratePattern}\\b`, "i"), " ")
            .replace(new RegExp(`\\s+${ratePattern}\\s*$`, "i"), " ")
            .replace(/\s+/g, " ")
            .trim();
        if (withoutRate !== cleaned) {
            cleaned = withoutRate.replace(/\s+\d+(?:,\d{3})*(?:\.\d+)?\s*$/, " ").trim();
        }
    }

    return (
        cleaned
            // A product name may legitimately start with a size such as
            // "35ml jar" or "3 ltr M.P jar". Only remove a leading number
            // when the source explicitly labels it as a serial number.
            .replace(/^\s*(?:s\.?\s*n\.?|sl\.?|sn|#)\s*\d+\s*[-.)]?\s*/i, "")
            .replace(/\b(?:npr|rs\.?|mrp|rate|price)\b/gi, "")
            .replace(/\s{2,}/g, " ")
            .trim() || normalized
    );
}

function parseProductSize(rawName: string) {
    const amount = String.raw`(?<![\d/])(\d+\s*\/\s*\d+|\d+(?:\.\d+)?)`;
    const patterns: Array<{ unit: string; regex: RegExp }> = [
        { unit: "LTR", regex: new RegExp(`${amount}\\s*(?:ltrs?|ltr\\.?|liters?|litres?|itr)\\b`, "i") },
        { unit: "KG", regex: new RegExp(`${amount}\\s*(?:kgs?|kilograms?)\\b`, "i") },
        { unit: "GRAM", regex: new RegExp(`${amount}\\s*(?:grams?|gms?|gm|g)\\b`, "i") },
        { unit: "INCH", regex: new RegExp(`${amount}\\s*(?:"|inches|inch|in\\b)`, "i") },
        { unit: "CM", regex: new RegExp(`${amount}\\s*(?:cms?|centimeters?)\\b`, "i") },
        { unit: "METER", regex: new RegExp(`${amount}\\s*(?:mtrs?|meters?|metres?)\\b`, "i") },
        { unit: "ML", regex: new RegExp(`${amount}\\s*(?:ml|milliliters?|millilitres?)\\b`, "i") },
    ];

    for (const pattern of patterns) {
        const match = rawName.match(pattern.regex);
        if (!match) continue;

        const fraction = match[1].replace(/\s+/g, "").split("/");
        const sizeValue = fraction.length === 2
            ? Number(fraction[0]) / Number(fraction[1])
            : Number(match[1]);
        return {
            // Size is structured metadata, not text to remove from the name.
            // Keeping the complete source name prevents distinct products such
            // as "35ml jar" and "60ml jar" from collapsing into "jar".
            productName: rawName.trim(),
            sizeValue: Number.isFinite(sizeValue) ? sizeValue : null,
            sizeUnit: pattern.unit,
        };
    }

    return {
        productName: rawName.trim(),
        sizeValue: null,
        sizeUnit: "STANDARD",
    };
}

function buildSupplierSku(vendorSource: string, serial: string, productName: string, variant?: string) {
    const vendorPart = (slugifySkuPart(vendorSource) || "SUPPLIER").slice(0, 20);
    const serialPart = (slugifySkuPart(serial) || "ITEM").slice(0, 12);
    const namePart = (slugifySkuPart(productName) || "PRODUCT").slice(0, 28);
    const identityHash = fingerprintImportFile(
        Buffer.from(`${vendorSource}|${serial}|${productName}|${variant || ""}`, "utf8"),
    ).slice(0, 8).toUpperCase();
    const variantPart = variant ? `-${slugifySkuPart(variant).slice(0, 8)}` : "";
    // Supplier serials and product codes are not necessarily unique. Including
    // a readable name segment plus a stable identity hash keeps preview SKUs
    // deterministic and unique before the review rows reach the database.
    return `${vendorPart}-${serialPart}-${namePart}-${identityHash}${variantPart}`.slice(0, 80);
}

// parsing a numeric value from a CSV cell with validation
// supports optional minimum value check and the ability to allow blank cells
function parseCsvNumber(
    value: unknown,
    fieldName: string,
    rowNumber: number,
    options?: { min?: number; allowBlank?: boolean },
) {
    const raw = normalizeCsvText(value);

    if (!raw) {
        if (options?.allowBlank) return undefined; // blank is okay for optional fields like stock
        throw new Error(`Row ${rowNumber}: ${fieldName} is required.`);
    }

    const parsed = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(parsed)) {
        throw new Error(`Row ${rowNumber}: ${fieldName} must be a valid number.`);
    }

    if (typeof options?.min === "number" && parsed < options.min) {
        throw new Error(`Row ${rowNumber}: ${fieldName} must be at least ${options.min}.`);
    }

    return parsed;
}

// resolving the brand ID for a CSV import row
// the CSV can provide either a brandId (direct reference) or a brand name
// if a brand name is given and does not exist yet, we automatically create it
// we cache brand lookups so repeated brand names do not cause extra database queries
async function resolveBrandIdForImport(
    tx: Prisma.TransactionClient,
    row: CsvImportRow,
    rowNumber: number,
    brandCache: Map<string, string>,
) {
    const brandId = normalizeCsvText(row.brandId);
    if (brandId) {
        const brand = await tx.brand.findUnique({ where: { id: brandId } }); // looking up brand by ID
        if (!brand) {
            throw new Error(`Row ${rowNumber}: brandId "${brandId}" was not found.`);
        }
        brandCache.set(brand.name.toLowerCase(), brand.id); // caching for future rows
        return brand.id;
    }

    const brandName = normalizeCsvText(row.brand);
    if (!brandName) {
        throw new Error(`Row ${rowNumber}: brand or brandId is required.`);
    }

    // checking the cache first to avoid redundant database lookups
    const cacheKey = brandName.toLowerCase();
    const cachedBrandId = brandCache.get(cacheKey);
    if (cachedBrandId) {
        return cachedBrandId;
    }

    // looking up the brand by name in the database (case-insensitive comparison)
    const existingBrand = (await tx.brand.findMany({
        select: { id: true, name: true },
    })).find((brand) => brand.name.toLowerCase() === cacheKey);

    if (existingBrand) {
        brandCache.set(cacheKey, existingBrand.id);
        return existingBrand.id;
    }

    // brand does not exist yet — creating it automatically
    const createdBrand = await tx.brand.create({
        data: {
            name: brandName,
            isActive: true,
        },
        select: { id: true, name: true },
    });

    brandCache.set(cacheKey, createdBrand.id);
    return createdBrand.id;
}

// normalizing a raw CSV row into our typed CsvImportRow format
// we lowercase all column headers so "RetailPrice", "retailprice", and "RETAILPRICE" all work
export function normalizeCsvImportRow(
    rawRow: Record<string, unknown>,
    rowNumber: number,
    options: CsvImportOptions = {},
): CsvImportRow {
    // converting all column keys to lowercase and trimming them
    const normalizedRow = Object.entries(rawRow).reduce<Record<string, unknown>>((acc, [key, value]) => {
        acc[key.trim().toLowerCase()] = value;
        return acc;
    }, {});

    const defaults = options.defaults || {};
    const supplierProductName = normalizeCsvText(
        getMappedCsvCell(
            normalizedRow,
            options.fieldMap,
            "productName",
            "product_name",
            "product name",
            "productname",
            "item name",
            "item_name",
            "description",
            "product description",
            "item description",
            "items",
            "jar name",
            "product",
            "article",
            "name",
            "item",
        ),
    );
    const vendorSource =
        normalizeCsvText(
            getMappedCsvCell(
                normalizedRow,
                options.fieldMap,
                "supplier",
                "vendor_source",
                "vendor source",
                "vendorsource",
                "supplier",
                "supplier name",
                "supplier_name",
                "brand",
                "company",
            ),
        ) || normalizeCsvText(defaults.supplier);
    const reviewedBrand = normalizeCsvText(
        getMappedCsvCell(normalizedRow, options.fieldMap, "brand", "brand", "company"),
    );
    const reviewedCategory = normalizeCsvText(
        getMappedCsvCell(normalizedRow, options.fieldMap, "category", "category"),
    );
    const reviewedCategoryGroup = normalizeCsvText(
        getMappedCsvCell(
            normalizedRow,
            options.fieldMap,
            "categoryGroup",
            "categorygroup",
            "category_group",
            "category group",
        ),
    );

    if (supplierProductName || vendorSource) {
        let fullName = supplierProductName;
        const variant = normalizeCsvText(
            getMappedCsvCell(
                normalizedRow,
                options.fieldMap,
                "variant",
                "product_code_variant",
                "product code variant",
                "productcodevariant",
                "variant",
                "code",
                "productcode",
                "product_code",
                "product code",
                "model",
                "series",
            ),
        );
        const serial = normalizeCsvText(
            getMappedCsvCell(
                normalizedRow,
                options.fieldMap,
                "serial",
                "catalogserial",
                "catalog_serial",
                "catalog serial",
                "s_n",
                "sn",
                "s.n",
                "serial",
                "sl",
                "sl.",
                "#",
            ),
        );
        const packageQuantity =
            parseCsvNumber(
                getMappedCsvCell(
                    normalizedRow,
                    options.fieldMap,
                    "packageQuantity",
                    "package_qty",
                    "package qty",
                    "packagequantity",
                    "package_quantity",
                    "pack",
                    "pkg",
                    "pkg.",
                    "carton",
                    "case",
                ),
                "Package_Qty",
                rowNumber,
                { min: 0, allowBlank: true },
            ) ?? null;
        const wholesaleCsvPrice = parseCsvNumber(
            getMappedCsvCell(
                normalizedRow,
                options.fieldMap,
                "wholesalePrice",
                "wholesaleprice",
                "wholesale_price",
                "wsp",
                "dealer price",
                "dealer_price",
                "storewholesaleprice",
                "store_wholesale_price",
                "store wholesale price",
            ),
            "Wholesale price",
            rowNumber,
            { min: 0.01, allowBlank: true },
        );
        const retailCsvPrice = parseCsvNumber(
            getMappedCsvCell(
                normalizedRow,
                options.fieldMap,
                "retailPrice",
                "retailprice",
                "retail_price",
                "mrp",
                "maximum retail price",
                "price",
            ),
            "Retail price",
            rowNumber,
            { min: 0.01, allowBlank: true },
        );
        const purchaseCostCsv = parseCsvNumber(
            getMappedCsvCell(
                normalizedRow,
                options.fieldMap,
                "ratePerPiece",
                "rateperpiece",
                "rate_per_piece",
                "purchase cost",
                "purchase_cost",
                "purchaserate",
                "purchase_rate",
                "purchase rate",
                "supplier rate",
                "supplier_rate",
                "cost price",
                "cost_price",
                "rate",
                "base price",
                "base_price",
            ),
            "Purchase cost",
            rowNumber,
            { min: 0.01, allowBlank: true },
        );
        const rate = purchaseCostCsv ?? wholesaleCsvPrice ?? retailCsvPrice;
        fullName = cleanImportedProductName(fullName, rate ?? undefined);
        const parsedSize = parseProductSize(fullName);
        const providedSku = normalizeCsvText(
            getMappedCsvCell(normalizedRow, options.fieldMap, "sku", "sku", "item code", "item_code"),
        );
        const sku =
            providedSku ||
            buildSupplierSku(vendorSource || "Supplier", serial, fullName, variant);
        const wholesaleEligible = parseBooleanCsvValue(
            getMappedCsvCell(
                normalizedRow,
                options.fieldMap,
                "wholesaleEligible",
                "wholesale_eligible",
                "wholesaleeligible",
            ),
            defaults.wholesaleEligible ?? !/fixed\s*price/i.test(vendorSource),
        );
        const saleUnit = normalizeUnitLabel(
            getMappedCsvCell(normalizedRow, options.fieldMap, "saleUnit", "sale_unit", "saleunit"),
            defaults.saleUnit || "PIECE",
        );
        const allowFractionalQty = parseBooleanCsvValue(
            getCsvCell(normalizedRow, "allow_fractional_qty", "allowfractionalqty"),
            ["KG", "GRAM", "METER"].includes(saleUnit),
        );

        if (!fullName) {
            throw new Error(`Row ${rowNumber}: Product_Name is required.`);
        }

        return {
            name: fullName,
            productName: fullName,
            sku,
            skuWasGenerated: !providedSku,
            barcode: normalizeCsvText(getCsvCell(normalizedRow, "barcode")) || undefined,
            brand:
                normalizeCsvText(defaults.brand) ||
                reviewedBrand ||
                vendorSource ||
                "Supplier",
            brandId: undefined,
            category:
                normalizeCsvText(defaults.category) ||
                reviewedCategory ||
                vendorSource ||
                "Supplier",
            categoryGroup:
                normalizeCsvText(defaults.categoryGroup) ||
                reviewedCategoryGroup ||
                normalizeCsvText(defaults.category) ||
                reviewedCategory ||
                vendorSource ||
                null,
            vendorSource: vendorSource || null,
            productCodeVariant: variant || null,
            sizeValue: parsedSize.sizeValue,
            sizeUnit: parsedSize.sizeUnit,
            ratePerPiece: purchaseCostCsv ?? null,
            packageQuantity,
            packageUnit: normalizeUnitLabel(
                getMappedCsvCell(
                    normalizedRow,
                    options.fieldMap,
                    "packageUnit",
                    "package_unit",
                    "packageunit",
                ),
                defaults.packageUnit || "PIECE",
            ),
            saleUnit,
            allowFractionalQty,
            quantityStep: allowFractionalQty ? 0.01 : 1,
            wholesaleEligible,
            sourceCitation:
                normalizeCsvText(
                    getCsvCell(
                        normalizedRow,
                        "citation",
                        "sourcecitation",
                        "source_citation",
                        "sourcepage",
                        "source_page",
                    ),
                ) ||
                null,
            searchAliases: parseCsvSearchAliases(
                getMappedCsvCell(
                    normalizedRow,
                    options.fieldMap,
                    "searchAliases",
                    "searchaliases",
                    "search_aliases",
                    "search terms",
                    "aliases",
                ),
            ),
            retailPrice: retailCsvPrice ?? null,
            wholesalePrice: wholesaleCsvPrice ?? null,
            stock:
                parseCsvNumber(
                    getMappedCsvCell(normalizedRow, options.fieldMap, "stock", "stock", "qty in stock"),
                    "stock",
                    rowNumber,
                    { min: 0, allowBlank: true },
                ) ?? Number(defaults.stock ?? 0),
        };
    }

    const name = normalizeCsvText(getCsvCell(normalizedRow, "name"));
    const sku = normalizeCsvText(getCsvCell(normalizedRow, "sku"));

    if (!name) {
        throw new Error(`Row ${rowNumber}: name is required.`);
    }

    if (!sku) {
        throw new Error(`Row ${rowNumber}: sku is required.`);
    }

    return {
        name,
        productName: normalizeCsvText(getCsvCell(normalizedRow, "productname", "product_name")) || name,
        sku,
        skuWasGenerated: false,
        barcode: normalizeCsvText(getCsvCell(normalizedRow, "barcode")) || undefined,
        brand: normalizeCsvText(getCsvCell(normalizedRow, "brand")) || undefined,
        brandId: normalizeCsvText(getCsvCell(normalizedRow, "brandid", "brand_id")) || undefined,
        category: normalizeCsvText(getCsvCell(normalizedRow, "category")) || undefined,
        categoryGroup:
            normalizeCsvText(getCsvCell(normalizedRow, "categorygroup", "category_group")) ||
            undefined,
        vendorSource:
            normalizeCsvText(getCsvCell(normalizedRow, "vendorsource", "vendor_source")) ||
            undefined,
        productCodeVariant:
            normalizeCsvText(
                getCsvCell(normalizedRow, "productcodevariant", "product_code_variant"),
            ) || undefined,
        sizeValue: parseCsvNumber(
            getCsvCell(normalizedRow, "sizevalue", "size_value"),
            "sizeValue",
            rowNumber,
            { min: 0, allowBlank: true },
        ),
        sizeUnit: normalizeUnitLabel(getCsvCell(normalizedRow, "sizeunit", "size_unit"), "STANDARD"),
        ratePerPiece: parseCsvNumber(
            getCsvCell(normalizedRow, "rateperpiece", "rate_per_piece"),
            "ratePerPiece",
            rowNumber,
            { min: 0.01, allowBlank: true },
        ) ?? null,
        packageQuantity:
            parseCsvNumber(
                getCsvCell(normalizedRow, "packagequantity", "package_quantity"),
                "packageQuantity",
                rowNumber,
                { min: 0, allowBlank: true },
            ) ?? null,
        packageUnit: normalizeUnitLabel(
            getCsvCell(normalizedRow, "packageunit", "package_unit"),
            "PIECE",
        ),
        saleUnit: normalizeUnitLabel(getCsvCell(normalizedRow, "saleunit", "sale_unit"), "PIECE"),
        allowFractionalQty: parseBooleanCsvValue(
            getCsvCell(normalizedRow, "allowfractionalqty", "allow_fractional_qty"),
            false,
        ),
        quantityStep:
            parseCsvNumber(
                getCsvCell(normalizedRow, "quantitystep", "quantity_step"),
                "quantityStep",
                rowNumber,
                { min: 0.001, allowBlank: true },
            ) ?? 1,
        wholesaleEligible: parseBooleanCsvValue(
            getCsvCell(normalizedRow, "wholesaleeligible", "wholesale_eligible"),
            true,
        ),
        sourceCitation:
            normalizeCsvText(getCsvCell(normalizedRow, "sourcecitation", "source_citation")) ||
            undefined,
        searchAliases: parseCsvSearchAliases(
            getCsvCell(
                normalizedRow,
                "searchaliases",
                "search_aliases",
                "search terms",
                "aliases",
            ),
        ),
        retailPrice: parseCsvNumber(
            getCsvCell(normalizedRow, "retailprice", "retail_price"),
            "retailPrice",
            rowNumber,
            { min: 0.01, allowBlank: true },
        ) ?? null,
        wholesalePrice: parseCsvNumber(
            getCsvCell(normalizedRow, "wholesaleprice", "wholesale_price"),
            "wholesalePrice",
            rowNumber,
            { min: 0.01, allowBlank: true },
        ) ?? null,
        stock:
            parseCsvNumber(getCsvCell(normalizedRow, "stock"), "stock", rowNumber, { min: 0, allowBlank: true }) ??
            Number(defaults.stock ?? 0),
    };
}

export async function importProductsFromCsv(
    rawRows: Array<Record<string, unknown>>,
    options: { actorId?: string } = {},
) {
    const createdProducts: Array<{ id: string; sku: string; name: string }> = [];
    const errors: CsvImportError[] = [];
    const brandCache = new Map<string, string>(); // caching brand lookups to reduce database queries
    const settings = await getBusinessSettings(); // fetching business defaults for new product thresholds
    const searchSynonymRules = await getEnabledSearchSynonymRules();
    const aliasApprover = options.actorId
        ? await prisma.user.findUnique({
            where: { id: options.actorId },
            select: { id: true, role: true, isActive: true },
        })
        : null;

    // pre-loading all existing brands into the cache
    const existingBrands = await prisma.brand.findMany({
        select: { id: true, name: true },
    });
    existingBrands.forEach((brand) => brandCache.set(brand.name.toLowerCase(), brand.id));

    // processing each row — rowNumber starts at 2 because row 1 is the CSV header
    for (let index = 0; index < rawRows.length; index += 1) {
        const rowNumber = index + 2;
        const rawRow = rawRows[index];

        try {
            const row = normalizeCsvImportRow(rawRow, rowNumber); // parsing and validating the raw row

            const created = await prisma.$transaction(async (tx) => {
                const brandId = await resolveBrandIdForImport(tx, row, rowNumber, brandCache); // resolving or creating the brand

                let finalSku = row.sku;

                // checking if a product with this SKU already exists
                const duplicateSku = await tx.product.findUnique({
                    where: { sku: finalSku },
                    select: { id: true, name: true, vendorSource: true },
                });
                if (duplicateSku) {
                    const sameImportedProduct =
                        duplicateSku.name.trim().toLowerCase() === row.name.trim().toLowerCase() &&
                        normalizeCsvText(duplicateSku.vendorSource).toLowerCase() ===
                        normalizeCsvText(row.vendorSource).toLowerCase();

                    if (!row.skuWasGenerated || sameImportedProduct) {
                        throw new Error(`Row ${rowNumber}: SKU "${finalSku}" already exists.`);
                    }

                    const baseSku = `${finalSku}-${slugifySkuPart(row.name).slice(0, 18)}`.slice(0, 74);
                    let suffix = 1;
                    do {
                        finalSku = suffix === 1 ? baseSku : `${baseSku}-${suffix}`;
                        const existingCandidate = await tx.product.findUnique({
                            where: { sku: finalSku },
                            select: { id: true },
                        });
                        if (!existingCandidate) break;
                        suffix += 1;
                    } while (suffix < 100);

                    const unresolvedDuplicate = await tx.product.findUnique({
                        where: { sku: finalSku },
                        select: { id: true },
                    });
                    if (unresolvedDuplicate) {
                        throw new Error(`Row ${rowNumber}: could not generate a unique SKU for "${row.name}".`);
                    }
                }

                // checking if a product with this barcode already exists (only if barcode is provided)
                if (row.barcode) {
                    const duplicateBarcode = await tx.product.findUnique({
                        where: { barcode: row.barcode },
                        select: { id: true },
                    });
                    if (duplicateBarcode) {
                        throw new Error(`Row ${rowNumber}: barcode "${row.barcode}" already exists.`);
                    }
                }

                // Spreadsheet and reviewed imports follow the same identifier
                // contract as Add Product: a blank barcode receives a unique
                // internal barcode instead of remaining null.
                const identifiers = await allocateProductIdentifiers(
                    tx,
                    finalSku,
                    row.barcode,
                );

                // creating the product with all business defaults applied
                // all imported products use the business default thresholds
                const created = await tx.product.create({
                    data: {
                        name: row.name,
                        productName: row.productName || row.name,
                        sku: identifiers.sku,
                        barcode: identifiers.barcode,
                        barcodeOrigin: identifiers.barcodeOrigin,
                        brandId,
                        category: row.category || null,
                        categoryGroup: row.categoryGroup || row.category || null,
                        vendorSource: row.vendorSource || null,
                        productCodeVariant: row.productCodeVariant || null,
                        sizeValue: row.sizeValue ?? null,
                        sizeUnit: normalizeUnitLabel(row.sizeUnit, "STANDARD"),
                        ratePerPiece: row.ratePerPiece ?? null,
                        packageQuantity:
                            row.packageQuantity === null || row.packageQuantity === undefined
                                ? null
                                : normalizePositiveNumber(row.packageQuantity, 1),
                        packageUnit: normalizeUnitLabel(row.packageUnit, "PIECE"),
                        saleUnit: normalizeUnitLabel(row.saleUnit, "PIECE"),
                        allowFractionalQty: row.allowFractionalQty ?? false,
                        quantityStep: normalizePositiveNumber(row.quantityStep, 1),
                        wholesaleEligible: row.wholesaleEligible ?? true,
                        sourceCitation: row.sourceCitation || null,
                        sellingPriceStatus: resolveSellingPriceStatus(
                            row.retailPrice,
                            row.wholesalePrice,
                        ),
                        availabilityStatus: resolveProductAvailability(
                            row.ratePerPiece,
                            row.retailPrice,
                            row.wholesalePrice,
                        ),
                        retailPrice: normalizeSellingPrice(row.retailPrice),
                        wholesalePrice: normalizeSellingPrice(row.wholesalePrice),
                        wholesaleQtyThreshold: settings.defaultWholesaleQtyThreshold,
                        usesDefaultWholesaleQtyThreshold: true, // imported products always use business defaults
                        stock:
                            settings.businessMode === "CATALOG_ONLY"
                                ? 0
                                : row.stock ?? 0,
                        lowStockThreshold: settings.defaultLowStockThreshold,
                        usesDefaultLowStockThreshold: true,
                        isActive: true,
                    },
                    select: { id: true, sku: true, name: true },
                });
                if (row.searchAliases && row.searchAliases.length > 0) {
                    if (!aliasApprover || aliasApprover.role !== "ADMIN" || !aliasApprover.isActive) {
                        throw new Error(
                            `Row ${rowNumber}: product search terms require active Admin approval.`,
                        );
                    }
                    for (const aliasValue of row.searchAliases) {
                        const alias = prepareReviewedProductAlias(aliasValue);
                        await tx.productSearchAlias.create({
                            data: {
                                productId: created.id,
                                ...alias,
                                source: "IMPORT_REVIEW",
                                approvedById: aliasApprover.id,
                            },
                        });
                    }
                }
                await rebuildProductSearchDocument(created.id, tx, searchSynonymRules);
                return created;
            });

            createdProducts.push(created);
        } catch (err: any) {
            // collecting the error so we can report it without stopping the entire import
            errors.push({
                rowNumber,
                sku: normalizeCsvText((rawRow as any).sku) || undefined,
                name:
                    normalizeCsvText((rawRow as any).name) ||
                    normalizeCsvText((rawRow as any).Product_Name) ||
                    undefined,
                message: err?.message || `Row ${rowNumber}: import failed.`,
            });
        }
    }

    // returning a summary of the import results
    return {
        totalRows: rawRows.length,
        createdCount: createdProducts.length,
        errorCount: errors.length,
        createdProducts,
        errors,
    };
}

function csvImportRowToParsedProduct(row: CsvImportRow) {
    return {
        name: row.name,
        productName: row.productName || row.name,
        sku: row.sku,
        barcode: row.barcode || "",
        brand: row.brand || row.vendorSource || "Supplier",
        category: row.category || row.vendorSource || "Supplier",
        categoryGroup: row.categoryGroup || row.category || row.vendorSource || "",
        vendorSource: row.vendorSource || "",
        productCodeVariant: row.productCodeVariant || "",
        sizeValue: row.sizeValue ?? null,
        sizeUnit: normalizeUnitLabel(row.sizeUnit, "STANDARD"),
        ratePerPiece: row.ratePerPiece ?? null,
        packageQuantity:
            row.packageQuantity === null || row.packageQuantity === undefined
                ? null
                : normalizePositiveNumber(row.packageQuantity, 1),
        packageUnit: normalizeUnitLabel(row.packageUnit, "PIECE"),
        saleUnit: normalizeUnitLabel(row.saleUnit, "PIECE"),
        allowFractionalQty: row.allowFractionalQty ?? false,
        quantityStep: normalizePositiveNumber(row.quantityStep, 1),
        wholesaleEligible: row.wholesaleEligible ?? true,
        sourceCitation: row.sourceCitation || "",
        retailPrice: row.retailPrice,
        wholesalePrice: row.wholesalePrice,
        stock: row.stock ?? 0,
    };
}

async function classifyProductPreviewRows(rows: ProductImportPreviewRowDraft[]) {
    const comparableRows: ComparableImportRow[] = [];
    const comparableIndexes: number[] = [];

    rows.forEach((row, index) => {
        if (row.status === "FAILED" || !row.parsed || typeof row.parsed !== "object") return;
        const parsed = row.parsed as Record<string, unknown>;
        comparableIndexes.push(index);
        comparableRows.push({
            rowKey: String(row.rowNumber),
            name: String(parsed.name || ""),
            brand: String(parsed.brand || ""),
            barcode: typeof parsed.barcode === "string" ? parsed.barcode : null,
            productCodeVariant:
                typeof parsed.productCodeVariant === "string" ? parsed.productCodeVariant : null,
            category: typeof parsed.category === "string" ? parsed.category : null,
            packageQuantity:
                typeof parsed.packageQuantity === "number" ? parsed.packageQuantity : null,
            ratePerPiece: typeof parsed.ratePerPiece === "number" ? parsed.ratePerPiece : null,
            retailPrice: typeof parsed.retailPrice === "number" ? parsed.retailPrice : null,
            wholesalePrice: typeof parsed.wholesalePrice === "number" ? parsed.wholesalePrice : null,
        });
    });

    if (comparableRows.length === 0) return rows;
    const products = await prisma.product.findMany({
        select: {
            id: true,
            name: true,
            barcode: true,
            barcodeOrigin: true,
            productCodeVariant: true,
            category: true,
            packageQuantity: true,
            ratePerPiece: true,
            retailPrice: true,
            wholesalePrice: true,
            availabilityStatus: true,
            brand: { select: { name: true } },
        },
    });
    const comparisons = compareImportRowsToCatalog(
        comparableRows,
        products.map((product) => ({
            ...product,
            brandName: product.brand.name,
        })),
    );

    comparisons.forEach((comparison, comparisonIndex) => {
        const row = rows[comparableIndexes[comparisonIndex]];
        const parsed = row.parsed as Record<string, unknown>;
        row.extracted = row.parsed;
        row.parsed = {
            ...parsed,
            availabilityStatus: comparison.availabilityStatus,
        } as Prisma.InputJsonValue;
        row.comparisonStatus = comparison.comparisonStatus;
        row.matchedProductId = comparison.matchedProductId;
        row.changeSet = comparison.changes as Prisma.InputJsonValue;
        const requestedResolution = row.resolution;
        const resolution = requestedResolution === "IGNORE"
            ? "IGNORE"
            : comparison.comparisonStatus === "READY_NEW"
            ? "CREATE_NEW"
            : comparison.comparisonStatus === "EXACT_DUPLICATE"
                ? "KEEP_EXISTING"
                : comparison.comparisonStatus === "IN_FILE_DUPLICATE"
                    ? "IGNORE"
                    : comparison.comparisonStatus === "MATCHED_WITH_CHANGES" &&
                        (requestedResolution === "UPDATE_MATCHED" || requestedResolution === "KEEP_EXISTING")
                        ? requestedResolution
                        : null;
        row.resolution = resolution;

        if (resolution === "CREATE_NEW" || resolution === "UPDATE_MATCHED" || resolution === "KEEP_EXISTING") {
            row.status = "READY";
            row.error = null;
        } else if (resolution === "IGNORE") {
            row.status = "IGNORED";
            row.error = null;
        } else if (comparison.comparisonStatus === "FAILED") {
            row.status = "FAILED";
            row.error = comparison.message;
        } else {
            // Changed matches and identifier conflicts require a deliberate
            // review decision. They never fall through to product creation.
            row.status = "DUPLICATE";
            row.error = comparison.message;
        }
    });
    return rows;
}

export async function createCsvImportPreview(input: {
    fileName?: string;
    rows: Array<Record<string, unknown>>;
    rowNumbers?: number[];
    sourceType?: "CSV" | "XLSX";
    sheetName?: string;
    createdById: string;
    supplier?: string;
    templateId?: string;
    fieldMap?: ProductImportColumnMap;
    defaults?: ProductImportDefaults;
    fileFingerprint?: string;
    fileSizeBytes?: number;
    repeatedFromBatchId?: string;
}) {
    const createdRows: ProductImportPreviewRowDraft[] = [];
    const sourceType = input.sourceType || "CSV";
    const template = input.templateId
        ? await prisma.productImportTemplate.findUnique({ where: { id: input.templateId } })
        : null;
    const templateFieldMap =
        template?.fieldMap && typeof template.fieldMap === "object"
            ? (template.fieldMap as ProductImportColumnMap)
            : undefined;
    const templateDefaults =
        template?.defaults && typeof template.defaults === "object"
            ? (template.defaults as ProductImportDefaults)
            : undefined;
    const options: CsvImportOptions = {
        fieldMap: input.fieldMap || templateFieldMap,
        defaults: {
            ...(templateDefaults || {}),
            ...(input.defaults || {}),
            supplier: input.supplier || input.defaults?.supplier || templateDefaults?.supplier,
        },
    };

    for (let index = 0; index < input.rows.length; index += 1) {
        const rowNumber = input.rowNumbers?.[index] || index + 2;
        const rawRow = input.rows[index];
        const sourceCells = JSON.parse(JSON.stringify(rawRow)) as Prisma.InputJsonValue;
        try {
            const normalized = normalizeCsvImportRow(rawRow, rowNumber, options);
            const parsedProduct = csvImportRowToParsedProduct(normalized);
            createdRows.push({
                rowNumber,
                rawText: JSON.stringify(rawRow),
                sourceLocator: {
                    kind: sourceType === "XLSX" ? "SPREADSHEET" : "CSV",
                    sheetName: input.sheetName || null,
                    rowNumber,
                    cells: sourceCells,
                },
                status: "READY",
                error: null,
                parsed: {
                    sourceType: `${sourceType}_ROW`,
                    ...parsedProduct,
                },
            });
        } catch (err: any) {
            createdRows.push({
                rowNumber,
                rawText: JSON.stringify(rawRow),
                sourceLocator: {
                    kind: sourceType === "XLSX" ? "SPREADSHEET" : "CSV",
                    sheetName: input.sheetName || null,
                    rowNumber,
                    cells: sourceCells,
                },
                status: "FAILED",
                error: err?.message || `Row ${rowNumber}: could not parse ${sourceType} row.`,
                parsed: {
                    sourceType: `${sourceType}_ROW`,
                },
            });
        }
    }

    await classifyProductPreviewRows(createdRows);

    const failedRows = createdRows.filter((row) => row.status === "FAILED").length;
    const batch = await prisma.productImportBatch.create({
        data: {
            sourceType,
            fileName: input.fileName || null,
            supplier: options.defaults?.supplier || null,
            status: createdRows.length > 0 ? "DRAFT" : "FAILED",
            totalRows: input.rows.length,
            importedRows: 0,
            failedRows,
            fileFingerprint: input.fileFingerprint || null,
            fileSizeBytes: input.fileSizeBytes ?? null,
            repeatedFromBatchId: input.repeatedFromBatchId || null,
            createdById: input.createdById,
            rows:
                createdRows.length > 0
                    ? { create: createdRows }
                    : {
                        create: [
                            {
                                rowNumber: 1,
                                rawText: null,
                                status: "FAILED",
                                error: "No CSV rows were found in this file.",
                            },
                        ],
                    },
        },
        include: {
            rows: {
                orderBy: { rowNumber: "asc" },
                take: 50,
            },
        },
    });

    return {
        batchId: batch.id,
        sourceType: batch.sourceType,
        totalRows: batch.totalRows,
        createdCount: 0,
        errorCount: failedRows,
        errors: batch.rows
            .filter((row) => row.status === "FAILED" || row.error)
            .map((row) => ({
                rowNumber: row.rowNumber,
                message: row.error || `${sourceType} row needs review.`,
            })),
        message: `${sourceType} imported into review (${batch.totalRows} row${batch.totalRows === 1 ? "" : "s"} captured).`,
    };
}

function parseJsonFromAiText(text: string) {
    const cleaned = text
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    const firstBracket = cleaned.indexOf("[");
    const lastBracket = cleaned.lastIndexOf("]");
    const candidate =
        firstBrace >= 0 && lastBrace > firstBrace
            ? cleaned.slice(firstBrace, lastBrace + 1)
            : firstBracket >= 0 && lastBracket > firstBracket
                ? cleaned.slice(firstBracket, lastBracket + 1)
                : cleaned;
    return JSON.parse(candidate);
}

function summarizeAiImportRow(item: Record<string, unknown>) {
    const parts = [
        normalizeCsvText(item.productName || item.name || item.Product_Name || item.product_name),
        normalizeCsvText(item.code || item.variant || item.Product_Code_Variant),
        normalizeCsvText(item.packageQty || item.pkg || item.packageQuantity)
            ? `Pkg ${normalizeCsvText(item.packageQty || item.pkg || item.packageQuantity)}`
            : "",
        normalizeCsvText(item.wsp || item.WSP)
            ? `WSP ${normalizeCsvText(item.wsp || item.WSP)}`
            : "",
        normalizeCsvText(item.rate || item.Rate)
            ? `Rate ${normalizeCsvText(item.rate || item.Rate)}`
            : "",
        normalizeCsvText(item.mrp || item.MRP || item.price)
            ? `MRP ${normalizeCsvText(item.mrp || item.MRP || item.price)}`
            : "",
    ].filter(Boolean);

    return parts.join(" | ") || JSON.stringify(item);
}

function normalizedSourceRegion(value: unknown) {
    if (!Array.isArray(value) || value.length !== 4) return null;
    const numbers = value.map(Number);
    if (numbers.some((number) => !Number.isFinite(number) || number < 0 || number > 1000)) {
        return null;
    }
    const [top, left, bottom, right] = numbers;
    if (bottom <= top || right <= left) return null;
    return { top, left, bottom, right, scale: 1000 };
}

export function normalizedImageSourceRegions(items: Array<Record<string, unknown>>) {
    const regions = items.map((item) => normalizedSourceRegion(item.boundingBox));
    const available = regions.filter((region): region is NonNullable<typeof region> => Boolean(region));
    if (available.length < 3) return regions;

    const heights = available.map((region) => region.bottom - region.top).sort((a, b) => a - b);
    const medianHeight = heights[Math.floor(heights.length / 2)];
    const fullWidthShare = available.filter((region) => region.right - region.left >= 700).length / available.length;
    const regularHeightShare = available.filter((region) =>
        Math.abs((region.bottom - region.top) - medianHeight) <= medianHeight * 0.35,
    ).length / available.length;

    // Gemini commonly returns a perfectly regular one-column row grid one
    // visual row too low. That is exactly what causes selecting MOP 10 to
    // highlight MOP 12. Restrict the correction to wide, regular,
    // single-column tables so split-page catalogs keep their original boxes.
    const hasSingleColumnRowLag =
        fullWidthShare >= 0.8
        && regularHeightShare >= 0.8
        && medianHeight >= 15
        && medianHeight <= 60;
    if (!hasSingleColumnRowLag) return regions;

    const upwardAdjustment = medianHeight * 1.25;
    return regions.map((region) => region ? {
        ...region,
        top: Math.max(0, Math.round(region.top - upwardAdjustment)),
        bottom: Math.max(1, Math.round(region.bottom - upwardAdjustment)),
    } : null);
}

function normalizeImportedCatalogUnit(value: unknown, fallback: string) {
    const raw = normalizeCsvText(value);
    const key = raw.toLowerCase().replace(/[.\s]+/g, "");
    const aliases: Record<string, string> = {
        pc: "PIECE", pcs: "PIECE", piece: "PIECE", pieces: "PIECE", "पिस": "PIECE",
        set: "SET", sets: "SET",
        doz: "DOZEN", dozen: "DOZEN", "दर्जन": "DOZEN",
        kg: "KG", kilogram: "KG",
        g: "GRAM", gm: "GRAM", gram: "GRAM",
        l: "LITER", ltr: "LITER", liter: "LITER", litre: "LITER", "लि": "LITER",
        ml: "ML",
        inch: "INCH", inches: "INCH",
    };
    return aliases[key] || normalizeUnitLabel(raw, fallback);
}

export async function extractImageRateRowsWithGemini(input: {
    fileName?: string;
    mimeType: string;
    base64: string;
}) {
    const apiKey =
        process.env.GEMINI_API_KEY ||
        process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
        process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
        return {
            rows: [],
            document: null,
            error:
                "AI image parsing is not configured. Add GEMINI_API_KEY to enable PNG/JPG supplier rate-list imports.",
        };
    }

    const prompt = `Extract product data from this supplier price-list image for an inventory/billing catalog import.
Return strict JSON only in this shape:
{
  "supplierName": "company or supplier name printed in the document header, empty if unknown",
  "brandName": "brand name only if clearly printed; if the supplier is the brand, use the supplier name",
  "hasCodeColumn": false,
  "products": [
    {
      "serial": 1,
      "productName": "verbatim complete text from the ITEMS/product-name cell",
      "code": "",
      "sizeText": "",
      "sizeValue": null,
      "sizeUnit": "",
      "saleUnit": "",
      "packageQty": null,
      "mrp": null,
      "wsp": null,
      "rate": null,
      "category": "section heading such as ROYAL BUCKET or BASIN - KING",
      "variant": "variant or series if different from code",
      "boundingBox": [120, 80, 175, 920]
    }
  ]
}
Rules:
- Extract EVERY visible product data row in top-to-bottom order. Do not summarize, sample, merge, or omit rows.
- Do not return document titles, table headers, section-only headings, addresses, or contact details as products.
- Copy the complete product-name/ITEMS cell verbatim. Preserve every number, parenthesized size, inch mark, hyphen, model word and variant (for example, MOP (8\") T Mop must stay MOP (8\") T Mop).
- Never simplify or normalize product names. Two rows with similar names but different sizes or variants are separate products.
- If size is printed in its own column, put it in sizeValue/sizeUnit and do not put it in code. Convert Nepali digits to ordinary JSON numbers.
- code is only for a real code/model column such as MRP Code or Product Code. Never use a size, unit, packing value or price as code.
- hasCodeColumn is true only when the table visibly contains a dedicated code/model column. When false, every product code must be empty.
- saleUnit is the printed unit such as PIECE, SET, DOZEN, KG or LITER; empty if absent.
- The null and empty values in the JSON schema are not defaults. Leave optional fields null/empty whenever that field is absent in the source row.
- Never invent stock or a shop selling price.
- Treat MRP as a possible retail price. Treat supplier WSP/Rate/Base Price as the shop's purchase cost, not the shop's wholesale price.
- Do not put price numbers inside productName.
- Keep section/category headings separate from productName.
- boundingBox is [top, left, bottom, right] for the complete source row on a 0-1000 image coordinate scale.
- Copy codes, package quantities, names and prices exactly as printed. Use null when a cell is blank or unreadable.`;
    const models = Array.from(new Set([
        process.env.GEMINI_IMPORT_MODEL || "gemini-2.5-flash",
        process.env.GEMINI_IMPORT_FALLBACK_MODEL || "gemini-3.5-flash-lite",
    ].filter(Boolean)));
    const requestBody = JSON.stringify({
        contents: [
            {
                role: "user",
                parts: [
                    { text: prompt },
                    {
                        inline_data: {
                            mime_type: input.mimeType,
                            data: input.base64,
                        },
                    },
                ],
            },
        ],
        generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
            maxOutputTokens: 32768,
        },
    });
    let response: Response | null = null;
    let usedModel = models[0];
    for (const model of models) {
        usedModel = model;
        const endpoint =
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
                body: requestBody,
            });
            if (response.ok ||
                ![429, 500, 502, 503, 504].includes(response.status) ||
                attempt === 1) {
                break;
            }
            await new Promise((resolve) =>
                setTimeout(resolve, 1500 * Math.pow(2, attempt)),
            );
        }
        if (response?.ok) break;
    }

    if (!response) {
        return {
            rows: [],
            document: null,
            error: "AI image parsing did not start.",
        };
    }
    if (!response.ok) {
        const body = await response.text().catch(() => "");
        return {
            rows: [],
            document: null,
            error: `AI image parsing failed with ${usedModel} (${response.status}). ${body.slice(0, 180)}`,
        };
    }

    const payload: any = await response.json();
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    const parsed = parseJsonFromAiText(text);
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.products) ? parsed.products : [];
    return {
        rows,
        document: Array.isArray(parsed)
            ? null
            : {
                supplierName: normalizeCsvText(parsed?.supplierName),
                brandName: normalizeCsvText(parsed?.brandName),
                hasCodeColumn: parsed?.hasCodeColumn === true,
            },
        error: null,
    };
}

type ScannedPdfPage = {
    pageNumber: number;
    mimeType: string;
    buffer: Buffer;
};

export async function extractScannedPdfPageGroupWithGemini(input: {
    pages: ScannedPdfPage[];
    fileName?: string;
}) {
    const apiKey =
        process.env.GEMINI_API_KEY ||
        process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
        process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
        return {
            rows: [] as any[],
            error:
                "AI PDF parsing is not configured. Add GEMINI_API_KEY to the backend production environment.",
        };
    }

    const pageLabels = input.pages.map((page) => page.pageNumber).join(", ");
    const prompt = `Extract every product-table row visible on the attached pages from supplier catalog "${input.fileName || "supplier catalog"}".
The attached images are PDF pages ${pageLabels}. Covers, indexes, contact details and category-only lists are not products.
Return strict JSON only:
{
  "products": [
    {
      "pageNumber": 3,
      "serial": "1",
      "nepaliName": "exact printed Nepali name or empty",
      "productName": "exact complete English product name, preserving numbers, sizes, WITH LID and other variants",
      "code": "exact printed product/model code or empty",
      "packageQty": 24,
      "supplierRate": 172,
      "category": "nearest printed section heading, not a brand",
      "boundingBox": [120, 80, 175, 920],
      "uncertainFields": []
    }
  ]
}
Rules:
- The rightmost rate/WSP/wholesale-price column is the shop's PURCHASE COST from this supplier. Put it only in supplierRate.
- Do not calculate or invent retail price, store wholesale price, stock, code, package quantity, category, or missing words.
- Preserve the full product name. Numbers and sizes distinguish real variants.
- pageNumber must match the page label supplied immediately before each image.
- boundingBox is [top, left, bottom, right] for the complete source row on a 0-1000 page-image coordinate scale.
- If a cell is unreadable use null or an empty string and list its field name in uncertainFields.
- Read all table rows, including rows whose serial numbers repeat on a later section or page.`;
    const parts: any[] = [{ text: prompt }];
    for (const page of input.pages) {
        parts.push({ text: `PDF page ${page.pageNumber}` });
        parts.push({
            inline_data: {
                mime_type: page.mimeType,
                data: page.buffer.toString("base64"),
            },
        });
    }

    const models = Array.from(new Set([
        process.env.GEMINI_IMPORT_MODEL || "gemini-2.5-flash",
        process.env.GEMINI_IMPORT_FALLBACK_MODEL || "gemini-3.5-flash-lite",
    ].filter(Boolean)));
    const requestBody = JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
            maxOutputTokens: 32768,
        },
    });
    let response: Response | null = null;
    let usedModel = models[0];
    for (const model of models) {
        usedModel = model;
        const endpoint =
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            response = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: requestBody,
            });
            if (response.ok ||
                ![429, 500, 502, 503, 504].includes(response.status) ||
                attempt === 1) {
                break;
            }
            await new Promise((resolve) =>
                setTimeout(resolve, 1500 * Math.pow(2, attempt)),
            );
        }
        if (response?.ok) break;
    }
    if (!response) {
        return { rows: [] as any[], error: `AI PDF parsing did not start for pages ${pageLabels}.` };
    }
    if (!response.ok) {
        const body = await response.text().catch(() => "");
        return {
            rows: [] as any[],
            error: `AI PDF parsing failed for pages ${pageLabels} with ${usedModel} (${response.status}). ${body.slice(0, 180)}`,
        };
    }

    const payload: any = await response.json();
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const parsed = parseJsonFromAiText(text);
    return {
        rows: Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.products)
                ? parsed.products
                : [],
        error: null as string | null,
    };
}

export async function createScannedPdfImportPreview(input: {
    fileName?: string;
    pages: ScannedPdfPage[];
    createdById: string;
    fileFingerprint?: string;
    fileSizeBytes?: number;
    repeatedFromBatchId?: string;
}) {
    const sourceName =
        (input.fileName || "Scanned Supplier PDF")
            .replace(/\.[^.]+$/, "")
            .replace(/[_-]+/g, " ")
            .trim() || "Scanned Supplier PDF";
    const pageGroups: ScannedPdfPage[][] = [];
    for (let index = 0; index < input.pages.length; index += 1) {
        pageGroups.push(input.pages.slice(index, index + 1));
    }

    const extracted: any[] = [];
    const extractionErrors: string[] = [];
    // Two concurrent model calls keep a large catalog responsive without
    // flooding a free-tier API key or making one failed page lose the rest.
    for (let index = 0; index < pageGroups.length; index += 2) {
        const results = await Promise.all(
            pageGroups.slice(index, index + 2).map((pages) =>
                extractScannedPdfPageGroupWithGemini({
                    pages,
                    fileName: input.fileName,
                }),
            ),
        );
        for (const result of results) {
            extracted.push(...result.rows);
            if (result.error) extractionErrors.push(result.error);
        }
    }

    const previewRows: ProductImportPreviewRowDraft[] = [];
    for (let index = 0; index < extracted.length; index += 1) {
        const item = extracted[index] || {};
        const pageNumber = Math.max(1, Number(item.pageNumber || 1));
        const rawProductName = normalizeCsvText(item.productName || item.name);
        const code = normalizeCsvText(item.code || item.variant);
        const purchaseRate = Number(
            item.supplierRate ?? item.purchaseRate ?? item.wsp ?? item.rate ?? 0,
        );
        const packageInput = item.packageQty ?? item.packageQuantity;
        const packageQuantity = packageInput === null || packageInput === undefined || packageInput === ""
            ? null
            : Number(packageInput);
        const validPurchaseRate = Number.isFinite(purchaseRate) && purchaseRate > 0
            ? roundCurrency(purchaseRate)
            : null;
        const productName = cleanImportedProductName(rawProductName);
        const uncertainFields = Array.isArray(item.uncertainFields)
            ? item.uncertainFields.map((field: unknown) => String(field || "").trim()).filter(Boolean)
            : [];
        const rowNumber = index + 1;
        const sourceRegion = normalizedSourceRegion(item.boundingBox);

        if (!productName) {
            previewRows.push({
                rowNumber,
                rawText: summarizeAiImportRow(item),
                sourceLocator: {
                    kind: "PDF",
                    pageNumber,
                    region: sourceRegion,
                },
                status: "FAILED",
                error: `Page ${pageNumber}: product name must be verified.`,
                parsed: {
                    sourceType: "PDF_SCANNED_AI_ROW",
                    pageNumber,
                    raw: item,
                },
            });
            continue;
        }

        const parsedSize = parseProductSize(productName);
        const parsedProduct = {
            name: productName,
            productName,
            sku: buildSupplierSku(
                sourceName,
                `${pageNumber}-${String(item.serial || rowNumber)}`,
                productName,
                code,
            ),
            barcode: "",
            brand: sourceName,
            category: normalizeCsvText(item.category || item.group) || "Uncategorized",
            categoryGroup: normalizeCsvText(item.category || item.group) || "Uncategorized",
            vendorSource: sourceName,
            productCodeVariant: code,
            sizeValue: parsedSize.sizeValue,
            sizeUnit: parsedSize.sizeUnit,
            ratePerPiece: validPurchaseRate,
            packageQuantity:
                packageQuantity !== null && Number.isFinite(packageQuantity) && packageQuantity > 0
                    ? packageQuantity
                    : null,
            packageUnit: "PIECE",
            saleUnit:
                parsedSize.sizeUnit === "KG" || parsedSize.sizeUnit === "METER"
                    ? parsedSize.sizeUnit
                    : "PIECE",
            allowFractionalQty:
                parsedSize.sizeUnit === "KG" || parsedSize.sizeUnit === "METER",
            quantityStep:
                parsedSize.sizeUnit === "KG" || parsedSize.sizeUnit === "METER"
                    ? 0.01
                    : 1,
            wholesaleEligible: true,
            sourceCitation: `${input.fileName || "Scanned supplier PDF"} p.${pageNumber}`,
            retailPrice: null,
            wholesalePrice: null,
            stock: 0,
        };
        previewRows.push({
            rowNumber,
            rawText: [
                `Page ${pageNumber}`,
                item.serial ? `S.N. ${item.serial}` : "",
                productName,
                code ? `Code ${code}` : "",
                parsedProduct.packageQuantity ? `Pack ${parsedProduct.packageQuantity}` : "Pack unknown",
                parsedProduct.ratePerPiece ? `Purchase NPR ${parsedProduct.ratePerPiece}` : "Price coming soon",
            ].filter(Boolean).join(" | "),
            sourceLocator: {
                kind: "PDF",
                pageNumber,
                region: sourceRegion,
            },
            status: "READY",
            error: null,
            parsed: {
                sourceType: "PDF_SCANNED_AI_ROW",
                pageNumber,
                nepaliName: normalizeCsvText(item.nepaliName),
                uncertainFields,
                ...parsedProduct,
            },
        });
    }

    if (previewRows.length === 0) {
        previewRows.push({
            rowNumber: 1,
            rawText: null,
            status: "FAILED",
            error:
                extractionErrors[0] ||
                "No product rows were extracted from the scanned PDF.",
            parsed: { sourceType: "PDF_SCANNED_AI_ROW" },
        });
    } else if (extractionErrors.length > 0) {
        previewRows.push(
            ...extractionErrors.map((error, index) => ({
                rowNumber: previewRows.length + index + 1,
                rawText: null,
                status: "FAILED",
                error,
                parsed: { sourceType: "PDF_SCANNED_AI_ERROR" },
            })),
        );
    }

    await classifyProductPreviewRows(previewRows);

    const failedRows = previewRows.filter((row) => row.status === "FAILED").length;
    const batch = await prisma.productImportBatch.create({
        data: {
            sourceType: "PDF_SCANNED_AI",
            fileName: input.fileName || null,
            supplier: sourceName,
            status: failedRows < previewRows.length ? "DRAFT" : "FAILED",
            totalRows: previewRows.length,
            importedRows: 0,
            failedRows,
            fileFingerprint: input.fileFingerprint || null,
            fileSizeBytes: input.fileSizeBytes ?? null,
            repeatedFromBatchId: input.repeatedFromBatchId || null,
            createdById: input.createdById,
            rows: { create: previewRows },
        },
        include: { rows: { orderBy: { rowNumber: "asc" }, take: 50 } },
    });
    return {
        batchId: batch.id,
        sourceType: batch.sourceType,
        totalRows: batch.totalRows,
        createdCount: 0,
        errorCount: failedRows,
        errors: batch.rows
            .filter((row) => row.status === "FAILED" || row.error)
            .map((row) => ({
                rowNumber: row.rowNumber,
                message: row.error || "Scanned PDF row needs review.",
            })),
        message:
            failedRows === batch.totalRows
                ? batch.rows[0]?.error || "Scanned PDF extraction failed."
                : `Scanned PDF parsed into review (${previewRows.length - extractionErrors.length} product row${previewRows.length - extractionErrors.length === 1 ? "" : "s"} captured).`,
    };
}

export async function createImageImportPreview(input: {
    fileName?: string;
    mimeType: string;
    buffer: Buffer;
    createdById: string;
    fileFingerprint?: string;
    fileSizeBytes?: number;
    repeatedFromBatchId?: string;
}) {
    const sourceName =
        (input.fileName || "Image Supplier")
            .replace(/\.[^.]+$/, "")
            .replace(/[_-]+/g, " ")
            .trim() || "Image Supplier";

    let aiRows: any[] = [];
    let aiDocument: { supplierName?: string; brandName?: string; hasCodeColumn?: boolean } | null = null;
    let aiError: string | null = null;
    try {
        const result = await extractImageRateRowsWithGemini({
            fileName: input.fileName,
            mimeType: input.mimeType,
            base64: input.buffer.toString("base64"),
        });
        aiRows = result.rows;
        aiDocument = result.document;
        aiError = result.error;
    } catch (err: any) {
        aiError = err?.message || "AI image parsing failed.";
    }

    const rows: ProductImportPreviewRowDraft[] = [];
    const imageSourceRegions = normalizedImageSourceRegions(aiRows);
    const sourceNameCounts = aiRows.reduce((counts, item) => {
        const name = normalizeCsvText(
            item?.productName || item?.name || item?.Product_Name || item?.product_name,
        ).toLocaleLowerCase("en-US");
        if (name) counts.set(name, (counts.get(name) || 0) + 1);
        return counts;
    }, new Map<string, number>());
    for (let index = 0; index < aiRows.length; index += 1) {
        const item = aiRows[index] || {};
        const rawProductName = normalizeCsvText(
            item.productName || item.name || item.Product_Name || item.product_name,
        );
        const sizeText = normalizeCsvText(item.sizeText || item.size_text);
        const repeatedName = (sourceNameCounts.get(rawProductName.toLocaleLowerCase("en-US")) || 0) > 1;
        const completeProductName = repeatedName && sizeText
            ? `${rawProductName} ${sizeText}`.trim()
            : rawProductName;
        const extractedCode = aiDocument?.hasCodeColumn
            ? normalizeCsvText(item.code || item.variant || item.Product_Code_Variant)
            : "";
        const code = extractedCode.toLocaleLowerCase("en-US") === rawProductName.toLocaleLowerCase("en-US")
            ? ""
            : extractedCode;
        const purchaseCostInput = Number(item.wsp ?? item.WSP ?? item.rate ?? item.Rate ?? 0);
        const retailInput = Number(item.mrp ?? item.MRP ?? item.price ?? 0);
        const sourceRegion = imageSourceRegions[index] || null;
        const packageInput = item.packageQty ?? item.pkg ?? item.packageQuantity;
        const packageQuantity = packageInput === null || packageInput === undefined || packageInput === ""
            ? null
            : Number(packageInput);
        const supplierName = normalizeCsvText(aiDocument?.supplierName) || sourceName;
        const brandName = normalizeCsvText(aiDocument?.brandName) || supplierName;
        const category = normalizeCsvText(item.category || item.group) || "Uncategorized";
        const productName = cleanImportedProductName(completeProductName);

        if (!productName) {
            rows.push({
                rowNumber: index + 1,
                rawText: summarizeAiImportRow(item),
                sourceLocator: { kind: "IMAGE", region: sourceRegion, regionAdjusted: Boolean(sourceRegion) },
                status: "FAILED",
                error: "AI row did not include a product name.",
                parsed: { sourceType: "IMAGE_AI_ROW", raw: item },
            });
            continue;
        }

        const parsedSize = parseProductSize(productName);
        const extractedSizeValue = Number(item.sizeValue ?? item.size_value ?? 0);
        const sizeValue = Number.isFinite(extractedSizeValue) && extractedSizeValue > 0
            ? extractedSizeValue
            : parsedSize.sizeValue;
        const sizeUnit = normalizeImportedCatalogUnit(item.sizeUnit ?? item.size_unit, parsedSize.sizeUnit || "STANDARD");
        const saleUnit = normalizeImportedCatalogUnit(item.saleUnit ?? item.unit, "PIECE");
        const purchaseCost = purchaseCostInput > 0
            ? roundCurrency(purchaseCostInput)
            : null;
        const retailPrice = retailInput > 0 ? roundCurrency(retailInput) : null;
        const parsedProduct = {
            name: productName,
            productName,
            sku: buildSupplierSku(supplierName, String(item.serial || index + 1), productName, code),
            barcode: "",
            brand: brandName,
            category,
            categoryGroup: category,
            vendorSource: supplierName,
            productCodeVariant: code,
            sizeValue,
            sizeUnit,
            ratePerPiece: purchaseCost,
            packageQuantity:
                packageQuantity !== null && Number.isFinite(packageQuantity) && packageQuantity > 0
                    ? packageQuantity
                    : null,
            packageUnit: saleUnit,
            saleUnit,
            allowFractionalQty:
                sizeUnit === "KG" || sizeUnit === "METER",
            quantityStep:
                sizeUnit === "KG" || sizeUnit === "METER" ? 0.01 : 1,
            wholesaleEligible: true,
            sourceCitation: input.fileName || "AI image import",
            retailPrice,
            wholesalePrice: null,
            stock: 0,
        };
        rows.push({
            rowNumber: index + 1,
            rawText: summarizeAiImportRow(item),
            sourceLocator: { kind: "IMAGE", region: sourceRegion, regionAdjusted: Boolean(sourceRegion) },
            status: "READY",
            error: null,
            parsed: { sourceType: "IMAGE_AI_ROW", sourceProductName: rawProductName, sourceSizeText: sizeText, ...parsedProduct },
        });
    }

    if (rows.length === 0) {
        rows.push({
            rowNumber: 1,
            rawText: null,
            status: "FAILED",
            error: aiError || "AI image parser did not return any product rows.",
            parsed: { sourceType: "IMAGE_AI_ROW" },
        });
    }

    await classifyProductPreviewRows(rows);

    const failedRows = rows.filter((row) => row.status === "FAILED").length;
    const detectedSupplier = normalizeCsvText(aiDocument?.supplierName) || sourceName;
    const batch = await prisma.productImportBatch.create({
        data: {
            sourceType: "IMAGE",
            fileName: input.fileName || null,
            supplier: detectedSupplier,
            status: rows.length > 0 && failedRows < rows.length ? "DRAFT" : "FAILED",
            totalRows: rows.length,
            importedRows: 0,
            failedRows,
            fileFingerprint: input.fileFingerprint || null,
            fileSizeBytes: input.fileSizeBytes ?? input.buffer.byteLength,
            repeatedFromBatchId: input.repeatedFromBatchId || null,
            createdById: input.createdById,
            rows: { create: rows },
        },
        include: {
            rows: { orderBy: { rowNumber: "asc" }, take: 50 },
        },
    });

    return {
        batchId: batch.id,
        sourceType: batch.sourceType,
        totalRows: batch.totalRows,
        createdCount: 0,
        errorCount: failedRows,
        errors: batch.rows
            .filter((row) => row.status === "FAILED" || row.error)
            .map((row) => ({ rowNumber: row.rowNumber, message: row.error || "Image row needs review." })),
        message:
            failedRows === batch.totalRows
                ? batch.rows[0]?.error || "Image import needs AI parser configuration."
                : `Image parsed into review (${batch.totalRows} row${batch.totalRows === 1 ? "" : "s"} captured).`,
    };
}

export async function createPdfImportPreview(input: {
    fileName?: string;
    text?: string;
    pages?: Array<{
        pageNumber: number;
        text: string;
        lines?: Array<{
            text: string;
            region: { top: number; left: number; bottom: number; right: number; scale: number };
        }>;
    }>;
    createdById: string;
    fileFingerprint?: string;
    fileSizeBytes?: number;
    repeatedFromBatchId?: string;
}) {
    const sourcePages: NonNullable<typeof input.pages> = input.pages?.length
        ? input.pages
        : [{ pageNumber: 1, text: input.text || "" }];
    const fileSourceName =
        (input.fileName || "Supplier PDF")
            .replace(/\.[^.]+$/, "")
            .replace(/[_-]+/g, " ")
            .trim() || "Supplier PDF";
    const sourceName = fileSourceName;
    const structured = parsePdfTextCatalogPages(sourcePages);
    if (structured.rows.length > 0) {
        const previewRows: ProductImportPreviewRowDraft[] = structured.rows.map((row, index) => {
            const productName = cleanImportedProductName(row.productName);
            const parsedSize = parseProductSize(productName);
            const locatedLine = sourcePages
                .find((page) => page.pageNumber === row.pageNumber)
                ?.lines?.find((line) => {
                    const locatedText = normalizeCsvText(line.text).toLowerCase();
                    const rawText = normalizeCsvText(row.rawText).toLowerCase();
                    return locatedText === rawText
                        || (locatedText.includes(productName.toLowerCase())
                            && row.extractedPrices.some((price) => locatedText.includes(String(price.value))));
                });
            return {
                rowNumber: index + 1,
                rawText: row.rawText,
                sourceLocator: {
                    kind: "PDF",
                    pageNumber: row.pageNumber,
                    lineNumber: row.lineNumber,
                    searchText: row.rawText,
                    region: locatedLine?.region || null,
                },
                status: "READY",
                error: null,
                parsed: {
                    sourceType: "PDF_TEXT_TABLE_ROW",
                    pageNumber: row.pageNumber,
                    name: productName,
                    productName,
                    sku: buildSupplierSku(sourceName, String(index + 1), productName),
                    barcode: "",
                    brand: sourceName,
                    category: row.category,
                    categoryGroup: row.category,
                    vendorSource: sourceName,
                    productCodeVariant: row.productCodeVariant,
                    sizeValue: parsedSize.sizeValue,
                    sizeUnit: parsedSize.sizeUnit,
                    ratePerPiece: null,
                    packageQuantity: row.packageQuantity,
                    packageUnit: row.packageUnit,
                    saleUnit:
                        parsedSize.sizeUnit === "KG" || parsedSize.sizeUnit === "METER"
                            ? parsedSize.sizeUnit
                            : "PIECE",
                    allowFractionalQty:
                        parsedSize.sizeUnit === "KG" || parsedSize.sizeUnit === "METER",
                    quantityStep:
                        parsedSize.sizeUnit === "KG" || parsedSize.sizeUnit === "METER" ? 0.01 : 1,
                    wholesaleEligible: true,
                    sourceCitation: `${input.fileName || "Supplier PDF"} p.${row.pageNumber}`,
                    retailPrice: null,
                    wholesalePrice: null,
                    stock: 0,
                    extractedPrices: row.extractedPrices,
                },
            };
        });
        await classifyProductPreviewRows(previewRows);
        const batch = await prisma.productImportBatch.create({
            data: {
                sourceType: "PDF",
                fileName: input.fileName || null,
                supplier: sourceName,
                status: "DRAFT",
                totalRows: previewRows.length,
                importedRows: 0,
                failedRows: 0,
                extractionMeta: {
                    parser: "TEXT_TABLE_V2",
                    priceColumns: structured.priceColumns,
                },
                priceMapping: {},
                fileFingerprint: input.fileFingerprint || null,
                fileSizeBytes: input.fileSizeBytes ?? null,
                repeatedFromBatchId: input.repeatedFromBatchId || null,
                createdById: input.createdById,
                rows: { create: previewRows },
            },
            include: { rows: { orderBy: { rowNumber: "asc" }, take: 25 } },
        });
        return {
            batchId: batch.id,
            sourceType: batch.sourceType,
            totalRows: batch.totalRows,
            createdCount: 0,
            errorCount: 0,
            errors: [],
            message: `PDF table extracted into an import review (${batch.totalRows} product row${batch.totalRows === 1 ? "" : "s"} captured). Map the extracted price column before final import.`,
        };
    }

    const lines = sourcePages.flatMap((page) =>
        String(page.text || "")
            .split(/\r?\n/)
            .map((line, lineIndex) => ({
                text: line.replace(/\s+/g, " ").trim(),
                pageNumber: Math.max(1, Number(page.pageNumber || 1)),
                lineNumber: lineIndex + 1,
            }))
            .filter((line) => Boolean(line.text)),
    );

    const status = lines.length > 0 ? "DRAFT" : "FAILED";
    const failedRows = lines.length > 0 ? 0 : 1;
    const previewRows = lines.slice(0, 500);
    const noTextMessage =
        "No selectable product text was found. This supplier PDF may be scanned/image-only and needs OCR before import.";

    const batch = await prisma.productImportBatch.create({
        data: {
            sourceType: "PDF",
            fileName: input.fileName || null,
            status,
            totalRows: lines.length,
            importedRows: 0,
            failedRows,
            fileFingerprint: input.fileFingerprint || null,
            fileSizeBytes: input.fileSizeBytes ?? null,
            repeatedFromBatchId: input.repeatedFromBatchId || null,
            createdById: input.createdById,
            rows:
                previewRows.length > 0
                    ? {
                        create: previewRows.map((line, index) => ({
                            rowNumber: index + 1,
                            rawText: line.text,
                            sourceLocator: {
                                kind: "PDF",
                                pageNumber: line.pageNumber,
                                lineNumber: line.lineNumber,
                                searchText: line.text,
                            },
                            status: "READY",
                            parsed: {
                                sourceType: "PDF_TEXT_LINE",
                                pageNumber: line.pageNumber,
                            },
                        })),
                    }
                    : {
                        create: [
                            {
                                rowNumber: 1,
                                rawText: null,
                                status: "FAILED",
                                error: noTextMessage,
                            },
                        ],
                    },
        },
        include: {
            rows: {
                orderBy: { rowNumber: "asc" },
                take: 25,
            },
        },
    });

    return {
        batchId: batch.id,
        sourceType: batch.sourceType,
        totalRows: batch.totalRows,
        createdCount: 0,
        errorCount: failedRows,
        errors: batch.rows
            .filter((row) => row.status === "FAILED" || row.error)
            .map((row) => ({
                rowNumber: row.rowNumber,
                message: row.error || "PDF preview row could not be processed.",
            })),
        message:
            lines.length > 0
                ? `PDF text extracted into an import preview (${lines.length} line${lines.length === 1 ? "" : "s"} captured; ${previewRows.length} stored for review).`
                : noTextMessage,
    };
}

function publicImportSource(batch: {
    fileName: string | null;
    sourceStoredFileName: string | null;
    sourceMimeType: string | null;
}) {
    return {
        available: Boolean(batch.sourceStoredFileName),
        fileName: batch.fileName,
        mimeType: batch.sourceMimeType,
    };
}

function omitPrivateImportStorage<T extends {
    sourceStoredFileName: string | null;
    sourceStoredPath: string | null;
    sourceMimeType: string | null;
    sourceChecksum: string | null;
    fileName: string | null;
}>(batch: T) {
    const {
        sourceStoredFileName: _sourceStoredFileName,
        sourceStoredPath: _sourceStoredPath,
        sourceMimeType: _sourceMimeType,
        sourceChecksum: _sourceChecksum,
        ...safeBatch
    } = batch;
    return { ...safeBatch, source: publicImportSource(batch) };
}

export async function attachProductImportSource(input: {
    batchId: string;
    originalName: string;
    mimeType?: string;
    buffer: Buffer;
}) {
    const existing = await prisma.productImportBatch.findFirst({
        where: { id: input.batchId, deletedAt: null },
        select: { id: true, sourceStoredFileName: true },
    });
    if (!existing) throw new Error("Product import batch was not found.");
    if (existing.sourceStoredFileName) return;

    const stored = await storeImportSource(input);
    try {
        await prisma.productImportBatch.update({
            where: { id: input.batchId },
            data: stored,
        });
    } catch (error) {
        await removeImportSource(stored).catch(() => undefined);
        throw error;
    }
}

export async function backfillProductImportSourceLocators(batchId: string) {
    const batch = await prisma.productImportBatch.findFirst({
        where: { id: batchId, deletedAt: null },
        select: {
            sourceType: true,
            rows: {
                where: { sourceLocator: { equals: Prisma.DbNull } },
                select: { id: true, rowNumber: true, rawText: true, parsed: true },
            },
        },
    });
    if (!batch || batch.rows.length === 0) return { updatedCount: 0 };

    const updates = batch.rows.map((row) => {
        const parsed = row.parsed && typeof row.parsed === "object"
            ? row.parsed as Record<string, any>
            : {};
        let locator: Prisma.InputJsonValue;
        if (batch.sourceType === "CSV" || batch.sourceType === "XLSX") {
            let cells: Record<string, unknown> = {};
            try {
                const candidate = JSON.parse(row.rawText || "{}");
                if (candidate && typeof candidate === "object") cells = candidate;
            } catch {
                // The raw line remains available even if an old row was not JSON.
            }
            locator = {
                kind: batch.sourceType === "XLSX" ? "SPREADSHEET" : "CSV",
                sheetName: null,
                rowNumber: row.rowNumber,
                cells: JSON.parse(JSON.stringify(cells)),
            };
        } else if (batch.sourceType.startsWith("PDF")) {
            const pageNumber = Math.max(
                1,
                Number(parsed.pageNumber || String(parsed.sourceCitation || "").match(/p\.(\d+)/i)?.[1] || 1),
            );
            locator = {
                kind: "PDF",
                pageNumber,
                region: normalizedSourceRegion(parsed.raw?.boundingBox),
                searchText: row.rawText || null,
            };
        } else {
            locator = {
                kind: "IMAGE",
                region: normalizedSourceRegion(parsed.raw?.boundingBox),
            };
        }
        return prisma.productImportRow.update({
            where: { id: row.id },
            data: { sourceLocator: locator },
        });
    });

    for (let index = 0; index < updates.length; index += 100) {
        await prisma.$transaction(updates.slice(index, index + 100));
    }
    return { updatedCount: updates.length };
}

export async function getProductImportSource(batchId: string) {
    const batch = await prisma.productImportBatch.findFirst({
        where: { id: batchId, deletedAt: null },
        select: {
            id: true,
            fileName: true,
            sourceStoredFileName: true,
            sourceStoredPath: true,
            sourceMimeType: true,
        },
    });
    if (!batch) throw new Error("Product import batch was not found.");
    const filePath = getImportSourcePath(batch);
    if (!filePath) throw new Error("The original import source is not available.");
    return {
        filePath,
        fileName: batch.fileName || "import-source",
        mimeType: batch.sourceMimeType || "application/octet-stream",
    };
}

export async function removeProductImportSource(batchId: string) {
    const source = await prisma.productImportBatch.findUnique({
        where: { id: batchId },
        select: { sourceStoredPath: true, sourceStoredFileName: true },
    });
    if (source) await removeImportSource(source);
}

export async function getProductImportBatch(batchId: string) {
    const batch = await prisma.productImportBatch.findFirst({
        where: { id: batchId, deletedAt: null },
        include: {
            rows: {
                orderBy: { rowNumber: "asc" },
            },
            createdBy: {
                select: { id: true, name: true, role: true },
            },
        },
    });

    if (!batch) {
        throw new Error("Product import batch was not found.");
    }

    return omitPrivateImportStorage(batch);
}

export async function getProductImportReview(input: {
    batchId: string;
    page?: number;
    pageSize?: number;
    search?: string;
    comparisonStatus?: string;
    rowStatus?: string;
}) {
    const page = Math.max(1, Math.floor(input.page || 1));
    const pageSize = Math.max(1, Math.min(100, Math.floor(input.pageSize || 25)));
    const batch = await prisma.productImportBatch.findFirst({
        where: { id: input.batchId, deletedAt: null },
        include: { createdBy: { select: { id: true, name: true, role: true } } },
    });
    if (!batch) throw new Error("Product import batch was not found.");

    const where: Prisma.ProductImportRowWhereInput = { batchId: input.batchId };
    if (input.comparisonStatus) {
        where.comparisonStatus = input.comparisonStatus as any;
    }
    if (input.rowStatus) where.status = input.rowStatus;
    const search = normalizeCsvText(input.search);
    if (search) {
        where.OR = [
            { rawText: { contains: search } },
            { error: { contains: search } },
        ];
    }

    const [rows, total, grouped, decisionRows] = await Promise.all([
        prisma.productImportRow.findMany({
            where,
            orderBy: { rowNumber: "asc" },
            skip: (page - 1) * pageSize,
            take: pageSize,
        }),
        prisma.productImportRow.count({ where }),
        prisma.productImportRow.groupBy({
            by: ["comparisonStatus"],
            where: { batchId: input.batchId },
            _count: { _all: true },
        }),
        prisma.productImportRow.findMany({
            where: { batchId: input.batchId },
            select: { resolution: true, status: true, parsed: true },
        }),
    ]);

    const decisionCounts = {
        create: 0,
        update: 0,
        keep: 0,
        ignore: 0,
        unresolved: 0,
        committed: 0,
    };
    for (const row of decisionRows) {
        if (["IMPORTED", "UPDATED", "KEPT_EXISTING"].includes(row.status)) {
            decisionCounts.committed += 1;
        } else if (row.resolution === "CREATE_NEW") decisionCounts.create += 1;
        else if (row.resolution === "UPDATE_MATCHED") decisionCounts.update += 1;
        else if (row.resolution === "KEEP_EXISTING") decisionCounts.keep += 1;
        else if (row.resolution === "IGNORE" || row.status === "IGNORED") decisionCounts.ignore += 1;
        else decisionCounts.unresolved += 1;
    }

    return {
        batch: omitPrivateImportStorage(batch),
        rows,
        pagination: {
            page,
            pageSize,
            total,
            totalPages: Math.max(1, Math.ceil(total / pageSize)),
        },
        comparisonCounts: Object.fromEntries(
            grouped.map((item) => [item.comparisonStatus, item._count._all]),
        ),
        decisionCounts,
        priceMapping: getImportPriceMappingState({ ...batch, rows: decisionRows }),
    };
}

type ImportPriceDestination = "ratePerPiece" | "retailPrice" | "wholesalePrice";

type StoredImportPriceCandidate = {
    key: string;
    label: string;
    value: number;
};

function standardImportPriceCandidates(parsed: Record<string, unknown>) {
    const definitions: Array<{
        field: ImportPriceDestination;
        key: string;
        label: string;
    }> = [
        { field: "ratePerPiece", key: "sourceRatePerPiece", label: "Extracted purchase rate" },
        { field: "retailPrice", key: "sourceRetailPrice", label: "Extracted retail price" },
        { field: "wholesalePrice", key: "sourceWholesalePrice", label: "Extracted wholesale price" },
    ];
    return definitions.flatMap((definition) => {
        const value = Number(parsed[definition.field]);
        return Number.isFinite(value) && value > 0
            ? [{ key: definition.key, label: definition.label, value: roundCurrency(value) }]
            : [];
    });
}

function importPriceCandidates(parsedValue: unknown): StoredImportPriceCandidate[] {
    const parsed = parsedValue && typeof parsedValue === "object" && !Array.isArray(parsedValue)
        ? parsedValue as Record<string, unknown>
        : {};
    const extracted = Array.isArray(parsed.extractedPrices)
        ? parsed.extractedPrices.flatMap((candidate): StoredImportPriceCandidate[] => {
            if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
            const key = normalizeCsvText((candidate as any).key);
            const label = normalizeCsvText((candidate as any).label) || key;
            const value = Number((candidate as any).value);
            return key && Number.isFinite(value) && value > 0
                ? [{ key, label, value: roundCurrency(value) }]
                : [];
        })
        : [];
    return extracted.length > 0 ? extracted : standardImportPriceCandidates(parsed);
}

function defaultImportPriceDestination(key: string): ImportPriceDestination | "" {
    if (key === "sourceRatePerPiece") return "ratePerPiece";
    if (key === "sourceRetailPrice") return "retailPrice";
    if (key === "sourceWholesalePrice") return "wholesalePrice";
    return "";
}

export function getImportPriceMappingState(batch: {
    extractionMeta?: Prisma.JsonValue | null;
    priceMapping?: Prisma.JsonValue | null;
    rows?: Array<{ parsed?: unknown }>;
}) {
    const meta = batch.extractionMeta && typeof batch.extractionMeta === "object" && !Array.isArray(batch.extractionMeta)
        ? batch.extractionMeta as Record<string, unknown>
        : {};
    const metadataColumns = Array.isArray(meta.priceColumns)
        ? meta.priceColumns
            .map((column) => column && typeof column === "object" && !Array.isArray(column)
                ? { key: normalizeCsvText((column as any).key), label: normalizeCsvText((column as any).label) }
                : null)
            .filter((column): column is { key: string; label: string } => Boolean(column?.key && column?.label))
        : [];
    const inferredCandidateCounts = new Map<string, { key: string; label: string; count: number }>();
    for (const row of batch.rows || []) {
        const uniqueCandidates = new Map(
            importPriceCandidates(row.parsed).map((candidate) => [candidate.key, candidate]),
        );
        for (const candidate of uniqueCandidates.values()) {
            const current = inferredCandidateCounts.get(candidate.key);
            inferredCandidateCounts.set(candidate.key, {
                key: candidate.key,
                label: candidate.label,
                count: (current?.count || 0) + 1,
            });
        }
    }
    const minimumInferredOccurrences = (batch.rows?.length || 0) <= 5
        ? 1
        : Math.max(2, Math.ceil((batch.rows?.length || 0) * 0.02));
    const inferredColumns = Array.from(inferredCandidateCounts.values())
        .filter((candidate) => candidate.count >= minimumInferredOccurrences)
        .map(({ key, label }) => ({ key, label }));
    const columns = metadataColumns.length > 0 ? metadataColumns : inferredColumns;
    const stored = batch.priceMapping && typeof batch.priceMapping === "object" && !Array.isArray(batch.priceMapping)
        ? batch.priceMapping as Record<string, unknown>
        : {};
    const mapping = Object.fromEntries(columns.map((column) => {
        const storedDestination = typeof stored[column.key] === "string"
            ? String(stored[column.key])
            : "";
        return [column.key, storedDestination || defaultImportPriceDestination(column.key)];
    }));
    const destinations = Object.values(mapping).filter(Boolean);
    return {
        required: columns.length > 0,
        complete:
            columns.length === 0
            || (columns.every((column) => mapping[column.key]) && new Set(destinations).size === destinations.length),
        columns,
        mapping,
    };
}

export async function setProductImportPriceMapping(input: {
    batchId: string;
    mapping: Record<string, unknown>;
    actorId: string;
}) {
    const batch = await prisma.productImportBatch.findFirst({
        where: { id: input.batchId, deletedAt: null },
        include: { rows: { orderBy: { rowNumber: "asc" } } },
    });
    if (!batch) throw new Error("Product import batch was not found.");
    const state = getImportPriceMappingState(batch);
    if (!state.required) throw new Error("This import has no extracted price columns to map.");

    const allowed = new Set<ImportPriceDestination>([
        "ratePerPiece",
        "retailPrice",
        "wholesalePrice",
    ]);
    const mapping: Record<string, ImportPriceDestination> = {};
    for (const column of state.columns) {
        const destination = String(input.mapping?.[column.key] || "") as ImportPriceDestination;
        if (!allowed.has(destination)) {
            throw new Error(`Choose Purchase rate, Retail price or Wholesale price for “${column.label}”.`);
        }
        mapping[column.key] = destination;
    }
    if (new Set(Object.values(mapping)).size !== Object.values(mapping).length) {
        throw new Error("Each extracted price column must map to a different KhataSathi price field.");
    }

    const drafts: ProductImportPreviewRowDraft[] = batch.rows.map((row) => {
        const parsed = row.parsed && typeof row.parsed === "object" && !Array.isArray(row.parsed)
            ? { ...(row.parsed as Record<string, unknown>) }
            : {};
        const prices = importPriceCandidates(parsed);
        parsed.extractedPrices = prices;
        for (const previousDestination of Object.values(state.mapping)) {
            if (["ratePerPiece", "retailPrice", "wholesalePrice"].includes(previousDestination)) {
                parsed[previousDestination] = null;
            }
        }
        for (const candidate of prices) {
            const key = candidate.key;
            const value = candidate.value;
            const destination = mapping[key];
            if (destination && Number.isFinite(value) && value > 0) parsed[destination] = roundCurrency(value);
        }
        return {
            rowNumber: row.rowNumber,
            rawText: row.rawText,
            sourceLocator: row.sourceLocator || undefined,
            status: row.status,
            error: row.error,
            parsed: parsed as Prisma.InputJsonValue,
            extracted: row.extracted || undefined,
            comparisonStatus: row.comparisonStatus,
            matchedProductId: row.matchedProductId,
            changeSet: row.changeSet || undefined,
            resolution: row.resolution,
        };
    });
    await classifyProductPreviewRows(drafts);

    await prisma.$transaction([
        prisma.productImportBatch.update({
            where: { id: batch.id },
            data: { priceMapping: mapping },
        }),
        ...batch.rows.map((row, index) => prisma.productImportRow.update({
            where: { id: row.id },
            data: {
                parsed: drafts[index].parsed || Prisma.DbNull,
                extracted: drafts[index].extracted || Prisma.DbNull,
                status: drafts[index].status,
                error: drafts[index].error || null,
                comparisonStatus: drafts[index].comparisonStatus,
                matchedProductId: drafts[index].matchedProductId || null,
                changeSet: drafts[index].changeSet || Prisma.DbNull,
                resolution: drafts[index].resolution || null,
            },
        })),
        prisma.auditLog.create({
            data: {
                actorId: input.actorId,
                action: "PRODUCT_IMPORT_PRICE_MAPPING_UPDATED",
                entityType: "ProductImportBatch",
                entityId: batch.id,
                meta: { mapping },
            },
        }),
    ]);
    return getImportPriceMappingState({
        extractionMeta: batch.extractionMeta,
        priceMapping: mapping,
        rows: drafts.map((draft) => ({ parsed: draft.parsed || null })),
    });
}

export async function getProductImportSourceContext(input: {
    batchId: string;
    rowId?: string;
    radius?: number;
}) {
    const active = input.rowId
        ? await prisma.productImportRow.findFirst({
            where: { id: input.rowId, batchId: input.batchId },
        })
        : null;

    const rows = await prisma.productImportRow.findMany({
        where: { batchId: input.batchId },
        orderBy: { rowNumber: "asc" },
        take: 500,
        select: { id: true, rowNumber: true, rawText: true, sourceLocator: true },
    });

    return {
        activeRowId: active?.id || input.rowId || rows[0]?.id || "",
        rows,
    };
}

export async function saveReviewedProductImportRows(
    batchId: string,
    inputRows: ReviewedPdfImportRowInput[],
    actorId: string,
) {
    if (!Array.isArray(inputRows) || inputRows.length === 0) {
        throw new ReviewedImportRowValidationError("Choose at least one review row to save.");
    }
    if (inputRows.length > 200) {
        throw new ReviewedImportRowValidationError("A maximum of 200 review rows can be saved at once.");
    }
    const preparedRows = inputRows.map(prepareReviewedImportRowDraft);
    const uniqueRowIds = new Set(preparedRows.map((row) => row.rowId));
    if (uniqueRowIds.size !== preparedRows.length) {
        throw new ReviewedImportRowValidationError("The same review row was submitted more than once.");
    }
    const batch = await prisma.productImportBatch.findFirst({
        where: { id: batchId, deletedAt: null },
        include: { rows: true },
    });
    if (!batch) throw new Error("Product import batch was not found.");
    const batchRows = new Map<string, ProductImportRow>(
        batch.rows.map((row) => [row.id, row]),
    );
    for (const row of preparedRows) {
        const stored = batchRows.get(row.rowId);
        if (!stored) {
            throw new ReviewedImportRowValidationError(
                "One or more rows do not belong to this import review.",
            );
        }
        if (stored.status === "IMPORTED") {
            throw new ReviewedImportRowValidationError(
                `Row ${stored.rowNumber} has already been imported and cannot be edited.`,
            );
        }
    }

    const duplicateSku = preparedRows.find(
        (row, index) =>
            preparedRows.findIndex(
                (candidate) => candidate.sku.toLowerCase() === row.sku.toLowerCase(),
            ) !== index,
    );
    if (duplicateSku) {
        throw new ReviewedImportRowValidationError(
            `SKU ${duplicateSku.sku} appears more than once in the rows being saved.`,
        );
    }
    const barcodes = preparedRows
        .map((row) => row.barcode)
        .filter((barcode): barcode is string => !!barcode);
    if (new Set(barcodes.map((barcode) => barcode.toLowerCase())).size !== barcodes.length) {
        throw new ReviewedImportRowValidationError(
            "The same barcode appears more than once in the rows being saved.",
        );
    }
    const reviewedDrafts: ProductImportPreviewRowDraft[] = preparedRows.map((row, index) => {
        const { rowId: _rowId, resolution, ...parsedDraft } = row;
        return {
            rowNumber: batchRows.get(row.rowId)?.rowNumber ?? index + 1,
            rawText: batchRows.get(row.rowId)?.rawText ?? null,
            status: "READY",
            resolution: resolution || null,
            parsed: JSON.parse(JSON.stringify({
                sourceType: "REVIEWED_ROW_DRAFT",
                ...parsedDraft,
            })) as Prisma.InputJsonValue,
        };
    });
    await classifyProductPreviewRows(reviewedDrafts);

    const savedRows = await prisma.$transaction(async (tx) => {
        const results: ProductImportRow[] = [];
        for (let index = 0; index < preparedRows.length; index += 1) {
            const row = preparedRows[index];
            const classified = reviewedDrafts[index];
            results.push(
                await tx.productImportRow.update({
                    where: { id: row.rowId },
                    data: {
                        status: classified.status,
                        error: classified.error || null,
                        parsed: classified.parsed,
                        extracted: classified.extracted,
                        comparisonStatus: classified.comparisonStatus,
                        matchedProductId: classified.matchedProductId,
                        changeSet: classified.changeSet,
                        resolution: classified.resolution,
                    },
                }),
            );
        }
        await tx.auditLog.create({
            data: {
                actorId,
                action: "PRODUCT_IMPORT_REVIEW_ROWS_SAVED",
                entityType: "ProductImportBatch",
                entityId: batchId,
                meta: {
                    rowIds: preparedRows.map((row) => row.rowId),
                    rowCount: preparedRows.length,
                },
            },
        });
        return results;
    });
    return { rows: savedRows, savedCount: savedRows.length };
}

export async function setProductImportRowResolution(input: {
    batchId: string;
    rowId: string;
    resolution: "KEEP_EXISTING" | "IGNORE";
    actorId: string;
}) {
    const row = await prisma.productImportRow.findFirst({
        where: { id: input.rowId, batchId: input.batchId },
    });
    if (!row) throw new ReviewedImportRowValidationError("Import review row was not found.");
    if (["IMPORTED", "UPDATED", "KEPT_EXISTING"].includes(row.status)) {
        throw new ReviewedImportRowValidationError("This row has already been committed.");
    }
    if (
        input.resolution === "KEEP_EXISTING" &&
        !["EXACT_DUPLICATE", "MATCHED_WITH_CHANGES"].includes(row.comparisonStatus)
    ) {
        throw new ReviewedImportRowValidationError(
            "Keep existing is only valid when this row matches an existing product.",
        );
    }

    const updated = await prisma.$transaction(async (tx) => {
        const result = await tx.productImportRow.update({
            where: { id: row.id },
            data: {
                resolution: input.resolution,
                status: input.resolution === "IGNORE" ? "IGNORED" : "READY",
                error: input.resolution === "IGNORE" ? null : row.error,
            },
        });
        await tx.auditLog.create({
            data: {
                actorId: input.actorId,
                action: "PRODUCT_IMPORT_ROW_DECISION_SET",
                entityType: "ProductImportRow",
                entityId: row.id,
                meta: {
                    batchId: input.batchId,
                    rowNumber: row.rowNumber,
                    resolution: input.resolution,
                },
            },
        });
        return result;
    });
    return { row: updated };
}

export async function listProductImportBatches(filters?: {
    sourceType?: string;
    status?: string;
    supplier?: string;
    search?: string;
    page?: number;
    pageSize?: number;
}) {
    const page = Math.max(1, filters?.page || 1);
    const pageSize = Math.max(1, Math.min(100, filters?.pageSize || 30));
    const where: any = { deletedAt: null };
    if (filters?.sourceType) where.sourceType = filters.sourceType;
    if (filters?.status) where.status = filters.status;
    if (filters?.supplier) where.supplier = { contains: filters.supplier };
    if (filters?.search) {
        where.OR = [
            { fileName: { contains: filters.search } },
            { supplier: { contains: filters.search } },
            { sourceType: { contains: filters.search } },
        ];
    }

    const batches = await prisma.productImportBatch.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
            createdBy: {
                select: { id: true, name: true, role: true },
            },
            rows: {
                orderBy: { rowNumber: "asc" },
                take: 3,
            },
        },
    });
    return batches.map(omitPrivateImportStorage);
}

export async function deleteProductImportBatch(batchId: string, userId: string) {
    const batch = await prisma.productImportBatch.findFirst({
        where: { id: batchId, deletedAt: null },
        select: {
            id: true,
            fileName: true,
            sourceType: true,
            supplier: true,
            status: true,
            totalRows: true,
            importedRows: true,
            failedRows: true,
        },
    });

    if (!batch) {
        throw new Error("Product import batch was not found.");
    }

    const purgeAfter = new Date();
    purgeAfter.setDate(purgeAfter.getDate() + 30);

    await prisma.$transaction([
        prisma.productImportBatch.update({
            where: { id: batchId },
            data: {
                deletedAt: new Date(),
                purgeAfter,
                deleteReason: "Deleted from import reviews",
                deletedById: userId,
            },
        }),
        prisma.softDeleteRecord.create({
            data: {
                entityType: "ProductImportBatch",
                entityId: batchId,
                entityLabel: batch.fileName || `${batch.sourceType} import review`,
                deletedById: userId,
                deleteReason: "Deleted from import reviews",
                purgeAfter,
                entitySnapshot: batch,
            },
        }),
        prisma.auditLog.create({
            data: {
                actorId: userId,
                action: "PRODUCT_IMPORT_BATCH_DELETED",
                entityType: "ProductImportBatch",
                entityId: batchId,
                meta: {
                    fileName: batch.fileName,
                    sourceType: batch.sourceType,
                    supplier: batch.supplier,
                    status: batch.status,
                    totalRows: batch.totalRows,
                    importedRows: batch.importedRows,
                    failedRows: batch.failedRows,
                },
            },
        }),
    ]);

    return {
        deleted: true,
        batch,
        message: "Import review deleted. Products that were already imported were not removed.",
    };
}

export async function listProductImportTemplates(sourceType?: string) {
    return prisma.productImportTemplate.findMany({
        where: sourceType ? { sourceType } : undefined,
        orderBy: [{ supplier: "asc" }, { updatedAt: "desc" }],
        include: {
            createdBy: {
                select: { id: true, name: true, role: true },
            },
        },
    });
}

export async function upsertProductImportTemplate(input: {
    id?: string;
    name?: string;
    supplier: string;
    sourceType?: string;
    fieldMap: ProductImportColumnMap;
    defaults?: ProductImportDefaults;
    createdById: string;
}) {
    const supplier = normalizeCsvText(input.supplier);
    if (!supplier) {
        throw new Error("Supplier name is required for an import template.");
    }

    const sourceType = normalizeCsvText(input.sourceType || "CSV").toUpperCase();
    const name = normalizeCsvText(input.name) || `${supplier} ${sourceType} template`;
    const fieldMap = input.fieldMap || {};
    const defaults = input.defaults || {};

    if (input.id) {
        return prisma.productImportTemplate.update({
            where: { id: input.id },
            data: {
                name,
                supplier,
                sourceType,
                fieldMap: fieldMap as Prisma.InputJsonValue,
                defaults: defaults as Prisma.InputJsonValue,
            },
        });
    }

    return prisma.productImportTemplate.upsert({
        where: {
            supplier_sourceType: {
                supplier,
                sourceType,
            },
        },
        create: {
            name,
            supplier,
            sourceType,
            fieldMap: fieldMap as Prisma.InputJsonValue,
            defaults: defaults as Prisma.InputJsonValue,
            createdById: input.createdById,
        },
        update: {
            name,
            fieldMap: fieldMap as Prisma.InputJsonValue,
            defaults: defaults as Prisma.InputJsonValue,
        },
    });
}

export async function deleteProductImportTemplate(id: string) {
    const template = await prisma.productImportTemplate.findUnique({
        where: { id },
        select: { id: true, supplier: true, sourceType: true },
    });

    if (!template) {
        throw new Error("Product import template was not found.");
    }

    await prisma.productImportTemplate.delete({ where: { id } });
    return { deleted: true, template };
}

function reviewedPdfRowToCsvRow(input: ReviewedPdfImportRowInput) {
    return {
        name: input.name,
        sku: input.sku,
        barcode: input.barcode,
        brand: input.brand || input.vendorSource,
        category: input.category || input.vendorSource,
        categoryGroup: input.categoryGroup || input.category || input.vendorSource,
        vendorSource: input.vendorSource,
        productCodeVariant: input.productCodeVariant,
        sizeValue: input.sizeValue ?? undefined,
        sizeUnit: input.sizeUnit || "STANDARD",
        ratePerPiece: input.ratePerPiece ?? null,
        packageQuantity: input.packageQuantity ?? null,
        packageUnit: input.packageUnit || "PIECE",
        saleUnit: input.saleUnit || "PIECE",
        allowFractionalQty: input.allowFractionalQty ? "true" : "false",
        quantityStep: input.quantityStep ?? 1,
        wholesaleEligible: input.wholesaleEligible === false ? "false" : "true",
        sourceCitation: input.sourceCitation,
        searchAliases: input.searchAliases,
        retailPrice: input.retailPrice,
        wholesalePrice: input.wholesalePrice,
        stock: input.stock ?? 0,
    };
}

async function updateMatchedProductFromImport(input: {
    row: ReturnType<typeof prepareReviewedImportRowDraft>;
    matchedProductId: string;
    changes: Array<{ field?: unknown; currentValue?: unknown; incomingValue?: unknown }>;
    actorId: string;
    batchId: string;
    rowNumber: number;
}) {
    const allowedChanges = new Set(
        input.changes.map((change) => String(change.field || "")),
    );
    if (allowedChanges.size === 0) {
        throw new Error(`Row ${input.rowNumber}: no catalog changes are available to apply.`);
    }

    return prisma.$transaction(async (tx) => {
        const current = await tx.product.findUnique({
            where: { id: input.matchedProductId },
            select: {
                id: true,
                name: true,
                productName: true,
                category: true,
                categoryGroup: true,
                productCodeVariant: true,
                packageQuantity: true,
                ratePerPiece: true,
                retailPrice: true,
                wholesalePrice: true,
                availabilityStatus: true,
                sourceCitation: true,
            },
        });
        if (!current) {
            throw new Error(`Row ${input.rowNumber}: the matched catalog product no longer exists.`);
        }

        const data: Prisma.ProductUpdateInput = {};
        if (allowedChanges.has("name")) {
            data.name = input.row.name;
            data.productName = input.row.name;
        }
        if (allowedChanges.has("category")) {
            data.category = input.row.category || null;
            data.categoryGroup = input.row.categoryGroup || input.row.category || null;
        }
        if (allowedChanges.has("productCodeVariant")) {
            data.productCodeVariant = input.row.productCodeVariant || null;
        }
        if (allowedChanges.has("packageQuantity")) {
            data.packageQuantity = input.row.packageQuantity;
        }
        if (allowedChanges.has("ratePerPiece")) {
            data.ratePerPiece = input.row.ratePerPiece;
        }
        if (allowedChanges.has("retailPrice")) {
            data.retailPrice = input.row.retailPrice;
        }
        if (allowedChanges.has("wholesalePrice")) {
            data.wholesalePrice = input.row.wholesalePrice;
        }
        if (allowedChanges.has("availabilityStatus")) {
            data.availabilityStatus = resolveProductAvailability(
                input.row.ratePerPiece,
                input.row.retailPrice,
                input.row.wholesalePrice,
            );
        }
        if (allowedChanges.has("retailPrice") || allowedChanges.has("wholesalePrice")) {
            data.sellingPriceStatus = resolveSellingPriceStatus(
                allowedChanges.has("retailPrice") ? input.row.retailPrice : current.retailPrice,
                allowedChanges.has("wholesalePrice") ? input.row.wholesalePrice : current.wholesalePrice,
            );
        }
        if (input.row.sourceCitation) {
            data.sourceCitation = input.row.sourceCitation;
        }

        const updated = await tx.product.update({
            where: { id: current.id },
            data,
            select: { id: true, sku: true, name: true },
        });
        await rebuildProductSearchDocument(updated.id, tx);
        await tx.auditLog.create({
            data: {
                actorId: input.actorId,
                action: "PRODUCT_IMPORT_MATCHED_UPDATE",
                entityType: "Product",
                entityId: updated.id,
                meta: {
                    batchId: input.batchId,
                    rowNumber: input.rowNumber,
                    changes: input.changes,
                    before: current,
                },
            },
        });
        return updated;
    });
}

type ReviewedImportCommitInput = {
    rows: ReviewedPdfImportRowInput[];
    ignoredRowIds?: string[];
    actorId: string;
    approved: true;
    commitToken?: string;
};

async function executeReviewedPdfRows(
    batchId: string,
    input: ReviewedImportCommitInput,
) {
    if (input.approved !== true) {
        throw new Error(
            "Final import approval is required. Review the selected rows and confirm the import.",
        );
    }
    const batch = await prisma.productImportBatch.findUnique({
        where: { id: batchId },
        include: { rows: true },
    });

    if (!batch) {
        throw new Error("Product import batch was not found.");
    }

    const existingRowsById = new Map<string, ProductImportRow>(
        batch.rows.map((row) => [row.id, row]),
    );
    const rows = Array.isArray(input.rows) ? input.rows : [];
    const ignoredRowIds = Array.isArray(input.ignoredRowIds) ? input.ignoredRowIds : [];

    for (const row of rows) {
        if (!existingRowsById.has(row.rowId)) {
            throw new Error("One or more selected rows do not belong to this import batch.");
        }
    }

    for (const rowId of ignoredRowIds) {
        if (!existingRowsById.has(rowId)) {
            throw new Error("One or more ignored rows do not belong to this import batch.");
        }
    }

    const preparedRows = rows.map(prepareReviewedImportRowDraft);
    const classifiedRows: ProductImportPreviewRowDraft[] = preparedRows.map((row) => {
        const { rowId, resolution, ...parsed } = row;
        return {
            rowNumber: existingRowsById.get(rowId)?.rowNumber || 0,
            rawText: existingRowsById.get(rowId)?.rawText || null,
            status: "READY",
            resolution: resolution || null,
            parsed: {
                sourceType: "FINAL_REVIEWED_ROW",
                ...parsed,
            } as Prisma.InputJsonValue,
        };
    });
    await classifyProductPreviewRows(classifiedRows);

    const decisions = preparedRows.map((row, index) => ({
        row,
        classified: classifiedRows[index],
        stored: existingRowsById.get(row.rowId)!,
    }));
    for (const decision of decisions) {
        const resolution = decision.classified.resolution;
        const comparison = decision.classified.comparisonStatus;
        const valid =
            (resolution === "CREATE_NEW" && comparison === "READY_NEW") ||
            (resolution === "UPDATE_MATCHED" && comparison === "MATCHED_WITH_CHANGES" && !!decision.classified.matchedProductId) ||
            (resolution === "KEEP_EXISTING" && (comparison === "EXACT_DUPLICATE" || comparison === "MATCHED_WITH_CHANGES")) ||
            resolution === "IGNORE";
        if (!valid) {
            throw new Error(
                `Row ${decision.stored.rowNumber} needs an explicit valid decision before commit. Identifier conflicts cannot be created or updated automatically.`,
            );
        }
    }

    await Promise.all(decisions.map((decision) =>
        prisma.productImportRow.update({
            where: { id: decision.row.rowId },
            data: {
                comparisonStatus: decision.classified.comparisonStatus,
                matchedProductId: decision.classified.matchedProductId,
                changeSet: decision.classified.changeSet,
                resolution: decision.classified.resolution,
                parsed: decision.classified.parsed,
                extracted: decision.classified.extracted,
                status: decision.classified.status,
                error: decision.classified.error || null,
            },
        }),
    ));

    const ignoredIds = new Set([
        ...ignoredRowIds,
        ...decisions
            .filter((decision) => decision.classified.resolution === "IGNORE")
            .map((decision) => decision.row.rowId),
    ]);
    if (ignoredIds.size > 0) {
        await prisma.productImportRow.updateMany({
            where: { id: { in: [...ignoredIds] } },
            data: { status: "IGNORED", error: null, resolution: "IGNORE" },
        });
    }

    if (decisions.length === 0) {
        const refreshed = await getProductImportBatch(batchId);
        return {
            totalRows: 0,
            createdCount: 0,
            errorCount: 0,
            updatedCount: 0,
            keptCount: 0,
            errors: [],
            batch: refreshed,
        };
    }

    await prisma.auditLog.create({
        data: {
            actorId: input.actorId,
            action: "PRODUCT_IMPORT_APPROVED",
            entityType: "ProductImportBatch",
            entityId: batchId,
            meta: {
                fileName: batch.fileName,
                sourceType: batch.sourceType,
                selectedRowIds: decisions.map((decision) => decision.row.rowId),
                selectedCount: decisions.length,
                ignoredCount: ignoredIds.size,
            },
        },
    });

    const createDecisions = decisions.filter(
        (decision) => decision.classified.resolution === "CREATE_NEW",
    );
    const updateDecisions = decisions.filter(
        (decision) => decision.classified.resolution === "UPDATE_MATCHED",
    );
    const keepDecisions = decisions.filter(
        (decision) => decision.classified.resolution === "KEEP_EXISTING",
    );
    const createResult = createDecisions.length > 0
        ? await importProductsFromCsv(
            createDecisions.map((decision) => reviewedPdfRowToCsvRow(decision.row)),
            { actorId: input.actorId },
        )
        : {
            totalRows: 0,
            createdCount: 0,
            errorCount: 0,
            createdProducts: [] as Array<{ id: string; sku: string; name: string }>,
            errors: [] as CsvImportError[],
        };
    const errors: CsvImportError[] = [];
    const rowErrors = new Map<string, string>();
    createResult.errors.forEach((error) => {
        const decision = createDecisions[error.rowNumber - 2];
        if (!decision) return;
        const mapped = {
            ...error,
            rowNumber: decision.stored.rowNumber,
            name: decision.row.name,
            sku: decision.row.sku,
        };
        errors.push(mapped);
        rowErrors.set(decision.row.rowId, mapped.message);
    });

    const updatedProducts: Array<{ id: string; sku: string; name: string }> = [];
    for (const decision of updateDecisions) {
        try {
            const changes = Array.isArray(decision.classified.changeSet)
                ? decision.classified.changeSet as Array<{ field?: unknown; currentValue?: unknown; incomingValue?: unknown }>
                : [];
            const updated = await updateMatchedProductFromImport({
                row: decision.row,
                matchedProductId: decision.classified.matchedProductId!,
                changes,
                actorId: input.actorId,
                batchId,
                rowNumber: decision.stored.rowNumber,
            });
            updatedProducts.push(updated);
        } catch (error: any) {
            const message = error?.message || `Row ${decision.stored.rowNumber}: matched update failed.`;
            errors.push({
                rowNumber: decision.stored.rowNumber,
                name: decision.row.name,
                sku: decision.row.sku,
                message,
            });
            rowErrors.set(decision.row.rowId, message);
        }
    }

    await Promise.all(decisions.map((decision) => {
        const error = rowErrors.get(decision.row.rowId);
        const resolution = decision.classified.resolution;
        const status = error
            ? "FAILED"
            : resolution === "CREATE_NEW"
                ? "IMPORTED"
                : resolution === "UPDATE_MATCHED"
                    ? "UPDATED"
                    : resolution === "KEEP_EXISTING"
                        ? "KEPT_EXISTING"
                        : "IGNORED";
        return prisma.productImportRow.update({
            where: { id: decision.row.rowId },
            data: {
                status,
                error: error || null,
                resolution,
            },
        });
    }));

    const importedRows = await prisma.productImportRow.count({
        where: { batchId, status: { in: ["IMPORTED", "UPDATED", "KEPT_EXISTING"] } },
    });
    const failedRows = await prisma.productImportRow.count({
        where: { batchId, status: "FAILED" },
    });
    const actionableRows = await prisma.productImportRow.count({
        where: { batchId, status: { in: ["READY", "FAILED", "DUPLICATE"] } },
    });

    await prisma.productImportBatch.update({
        where: { id: batchId },
        data: {
            importedRows,
            failedRows,
            status: actionableRows > 0 ? "DRAFT" : "IMPORTED",
        },
    });

    const result = {
        totalRows: decisions.length,
        createdCount: createResult.createdCount,
        updatedCount: updatedProducts.length,
        keptCount: keepDecisions.length,
        ignoredCount: ignoredIds.size,
        errorCount: errors.length,
        createdProducts: createResult.createdProducts,
        updatedProducts,
        errors,
    };

    if (input.actorId && (result.createdCount > 0 || result.updatedCount > 0 || result.keptCount > 0)) {
        await prisma.auditLog.create({
            data: {
                actorId: input.actorId,
                action: "PRODUCT_IMPORT_COMPLETED",
                entityType: "ProductImportBatch",
                entityId: batchId,
                meta: {
                    fileName: batch.fileName,
                    sourceType: batch.sourceType,
                    supplier: batch.supplier,
                    totalRows: result.totalRows,
                    createdCount: result.createdCount,
                    updatedCount: result.updatedCount,
                    keptCount: result.keptCount,
                    errorCount: result.errorCount,
                },
            },
        });
    }

    const refreshed = await getProductImportBatch(batchId);
    return {
        ...result,
        batch: refreshed,
    };
}

export async function importReviewedPdfRows(
    batchId: string,
    input: ReviewedImportCommitInput,
) {
    const canonicalRequest = {
        batchId,
        rows: [...(Array.isArray(input.rows) ? input.rows : [])]
            .sort((left, right) => String(left.rowId).localeCompare(String(right.rowId))),
        ignoredRowIds: [...(Array.isArray(input.ignoredRowIds) ? input.ignoredRowIds : [])].sort(),
        actorId: input.actorId,
        approved: input.approved,
    };
    const requestHash = fingerprintImportFile(
        Buffer.from(JSON.stringify(canonicalRequest), "utf8"),
    );
    const requestedToken = String(input.commitToken || "").trim();
    if (requestedToken && !/^[A-Za-z0-9_-]{8,64}$/.test(requestedToken)) {
        throw new Error("Import commit token must contain 8 to 64 letters, numbers, underscores, or hyphens.");
    }
    const token = requestedToken || requestHash;
    const existing = await prisma.productImportCommit.findUnique({
        where: { batchId_token: { batchId, token } },
    });
    if (existing) {
        if (existing.requestHash !== requestHash) {
            throw new Error("This import commit token was already used for a different selection.");
        }
        if (existing.status === "COMPLETED" && existing.result) {
            return {
                ...(existing.result as Record<string, unknown>),
                commitToken: token,
                replayed: true,
            };
        }
        if (existing.status === "FAILED") {
            throw new Error(
                "This import attempt failed and was not retried automatically. Review the rows and submit again with a new commit token.",
            );
        }
        throw new Error("This import commit is already in progress. Wait and reopen the review before trying again.");
    }

    const commit = await prisma.productImportCommit.create({
        data: {
            batchId,
            token,
            requestHash,
            actorId: input.actorId,
        },
    });
    try {
        const result = await executeReviewedPdfRows(batchId, input);
        const storedResult = JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue;
        await prisma.productImportCommit.update({
            where: { id: commit.id },
            data: {
                status: "COMPLETED",
                result: storedResult,
                completedAt: new Date(),
            },
        });
        return {
            ...result,
            commitToken: token,
            replayed: false,
        };
    } catch (error: any) {
        await prisma.productImportCommit.update({
            where: { id: commit.id },
            data: {
                status: "FAILED",
                error: error?.message || "Import commit failed.",
                completedAt: new Date(),
            },
        }).catch(() => undefined);
        throw error;
    }
}

export async function importSavedProductImportBatch(input: {
    batchId: string;
    actorId: string;
    approved: true;
    commitToken?: string;
}) {
    if (input.approved !== true) {
        throw new Error("Final import approval is required.");
    }
    const batch = await prisma.productImportBatch.findFirst({
        where: { id: input.batchId, deletedAt: null },
        include: { rows: { orderBy: { rowNumber: "asc" } } },
    });
    if (!batch) throw new Error("Product import batch was not found.");
    const priceMapping = getImportPriceMappingState(batch);
    if (priceMapping.required && !priceMapping.complete) {
        throw new Error(
            "Map every extracted price column to Purchase rate, Retail price or Wholesale price before final import.",
        );
    }

    const finishedStatuses = new Set(["IMPORTED", "UPDATED", "KEPT_EXISTING"]);
    const unresolved = batch.rows.filter(
        (row) => !finishedStatuses.has(row.status) && row.status !== "IGNORED" && !row.resolution,
    );
    if (unresolved.length > 0) {
        const samples = unresolved.slice(0, 5).map((row) => row.rowNumber).join(", ");
        throw new Error(
            `${unresolved.length} row${unresolved.length === 1 ? " still needs" : "s still need"} an import decision before final commit. Review row${unresolved.length === 1 ? "" : "s"} ${samples}${unresolved.length > 5 ? ", …" : ""}.`,
        );
    }

    const rows = batch.rows
        .filter(
            (row) =>
                !finishedStatuses.has(row.status) &&
                row.resolution &&
                row.resolution !== "IGNORE",
        )
        .map((row) => ({
            ...((row.parsed && typeof row.parsed === "object"
                ? row.parsed
                : {}) as Record<string, unknown>),
            rowId: row.id,
            resolution: row.resolution,
        })) as ReviewedPdfImportRowInput[];
    const ignoredRowIds = batch.rows
        .filter((row) => row.resolution === "IGNORE" || row.status === "IGNORED")
        .map((row) => row.id);

    if (rows.length === 0 && ignoredRowIds.length === 0) {
        throw new Error("There are no reviewed rows ready to commit.");
    }

    return importReviewedPdfRows(input.batchId, {
        rows,
        ignoredRowIds,
        actorId: input.actorId,
        approved: true,
        commitToken: input.commitToken,
    });
}
