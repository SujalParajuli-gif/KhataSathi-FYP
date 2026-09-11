import test from "node:test";
import assert from "node:assert/strict";
import {
  rankProductSearchCandidates,
  restoreRankedProductOrder,
  type ProductSearchRankCandidate,
} from "../modules/products/searchRanking";
import { matchesProductSearchStockConstraint } from "../modules/products/productSearchService";
import { searchProductsWithDeterministicRanking } from "../modules/products/productSearchService";
import prisma from "../db/prisma";

function candidate(
  id: string,
  name: string,
  overrides: Partial<ProductSearchRankCandidate> = {},
): ProductSearchRankCandidate {
  const normalizedText = [name, overrides.sku, overrides.barcode]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return {
    id,
    name,
    productName: name,
    sku: `SKU-${id}`,
    barcode: null,
    brand: { name: "Bagmati Plastic" },
    searchDocument: { normalizedText },
    searchAliases: [],
    ...overrides,
  };
}

const baltiRule = [
  { normalizedAlias: "balti", normalizedCanonicalTerm: "bucket" },
];

test("exact barcode ranks above exact SKU and text matches", () => {
  const ranked = rankProductSearchCandidates(
    "CODE-100",
    [
      candidate("name", "CODE-100", { sku: "SKU-NAME" }),
      candidate("sku", "Code Holder", { sku: "CODE-100" }),
      candidate("barcode", "Barcode Holder", { barcode: "CODE-100" }),
    ],
    [],
  );
  assert.deepEqual(
    ranked.map((result) => result.tier),
    ["EXACT_BARCODE", "EXACT_SKU", "EXACT_NAME"],
  );
});

test("exact normalized name and approved product alias rank above token matches", () => {
  const ranked = rankProductSearchCandidates(
    "utility box",
    [
      candidate("token", "Large Utility Box Set"),
      candidate("alias", "Household Organizer", {
        searchAliases: [
          { normalizedAlias: "utility box", isEnabled: true },
        ],
        searchDocument: { normalizedText: "household organizer utility box" },
      }),
      candidate("name", "UTILITY BOX"),
    ],
    [],
  );
  assert.deepEqual(
    ranked.map((result) => result.tier),
    ["EXACT_NAME", "EXACT_PRODUCT_ALIAS", "ALL_EXACT_TOKENS"],
  );
});

test("all important token groups are required when a complete result exists", () => {
  const ranked = rankProductSearchCandidates(
    "blue bucket",
    [
      candidate("bucket", "Bucket 15 Ltr"),
      candidate("blue", "Blue Bottle"),
      candidate("both", "Blue Bucket 20 Ltr"),
    ],
    [],
  );
  assert.deepEqual(ranked.map((result) => result.candidate.id), ["both"]);
});

test("a reviewed synonym forms one alternative group instead of requiring both words", () => {
  const ranked = rankProductSearchCandidates(
    "balti",
    [candidate("bucket", "Titan Bucket 15 Ltrs")],
    baltiRule,
  );
  assert.equal(ranked[0]?.candidate.id, "bucket");
  assert.equal(ranked[0]?.tier, "ALL_EXACT_TOKENS");
});

test("a global product-type synonym finds every matching variant and respects extra size terms", () => {
  const basinRule = [
    { normalizedAlias: "bata", normalizedCanonicalTerm: "basin" },
  ];
  const products = [
    candidate("basin-12", "Basin 12 L"),
    candidate("basin-15", "Basin 15 L"),
    candidate("bucket-15", "Bucket 15 L"),
  ];

  assert.deepEqual(
    rankProductSearchCandidates("bata", products, basinRule).map((result) => result.candidate.id),
    ["basin-12", "basin-15"],
  );
  assert.deepEqual(
    rankProductSearchCandidates("bata 15", products, basinRule).map((result) => result.candidate.id),
    ["basin-15"],
  );
});

test("prefix matches rank above typo matches without relying on score constants", () => {
  const ranked = rankProductSearchCandidates(
    "botle",
    [
      candidate("typo", "Water Bottle"),
      candidate("prefix", "Botley Storage"),
    ],
    [],
  );
  assert.deepEqual(
    ranked.map((result) => result.tier),
    ["PREFIX_OR_MIXED_TOKENS", "TYPO_TOKENS"],
  );
});

test("numeric and canonical unit groups require exact tokens instead of prefixes", () => {
  assert.deepEqual(
    rankProductSearchCandidates(
      "100",
      [candidate("larger-number", "Bottle 1000 ML")],
      [],
    ),
    [],
  );
  assert.deepEqual(
    rankProductSearchCandidates(
      "meter",
      [candidate("unrelated-prefix", "Metering Device")],
      [],
    ),
    [],
  );
  assert.equal(
    rankProductSearchCandidates(
      "100",
      [candidate("exact-number", "Bottle 100 ML")],
      [],
    )[0]?.candidate.id,
    "exact-number",
  );
});

test("field priority, product name, and ID provide stable tie-breakers", () => {
  const ranked = rankProductSearchCandidates(
    "bagmati",
    [
      candidate("brand-z", "Zulu", { brand: { name: "Bagmati" } }),
      candidate("name-z", "Bagmati Zulu"),
      candidate("name-a2", "Bagmati Alpha"),
      candidate("name-a1", "Bagmati Alpha"),
    ],
    [],
  );
  assert.deepEqual(ranked.map((result) => result.candidate.id), [
    "name-a1",
    "name-a2",
    "name-z",
    "brand-z",
  ]);
});

test("lower typo distance wins before stable name tie-breakers", () => {
  const ranked = rankProductSearchCandidates(
    "contianxr",
    [
      candidate("two-edits", "Container Standard"),
      candidate("one-edit", "Contianer Special"),
    ],
    [],
  );
  assert.deepEqual(ranked.map((result) => result.candidate.id), [
    "one-edit",
    "two-edits",
  ]);
  assert.ok(ranked[0].typoDistance < ranked[1].typoDistance);
});

test("stock constraints use available stock and remain hard filters", () => {
  const product = {
    stock: 10,
    reservedStock: 6,
    lowStockThreshold: 5,
    usesDefaultLowStockThreshold: false,
  };
  const settings = { defaultLowStockThreshold: 5 } as any;
  assert.equal(
    matchesProductSearchStockConstraint(product, {
      stockStatus: "low",
      settings,
    }),
    true,
  );
  assert.equal(
    matchesProductSearchStockConstraint(product, {
      stockStatus: "in",
      settings,
    }),
    false,
  );
  assert.equal(
    matchesProductSearchStockConstraint(
      { ...product, reservedStock: 10 },
      { stockStatus: "out", settings },
    ),
    true,
  );
  assert.equal(
    matchesProductSearchStockConstraint(
      { ...product, stock: 5.5, reservedStock: 0.5 },
      { stockStatus: "low", settings },
    ),
    true,
  );
  assert.equal(
    matchesProductSearchStockConstraint(
      {
        ...product,
        stock: 6,
        reservedStock: 0,
        usesDefaultLowStockThreshold: true,
        lowStockThreshold: 1,
      },
      { stockStatus: "in", settings },
    ),
    true,
  );
  assert.equal(
    matchesProductSearchStockConstraint(
      { ...product, stock: 0.25, reservedStock: 0 },
      { stockStatus: "out", settings },
    ),
    false,
  );
});

test("full product fetches can be restored to ranked ID order", () => {
  assert.deepEqual(
    restoreRankedProductOrder(
      ["third", "first", "missing", "second"],
      [{ id: "first" }, { id: "second" }, { id: "third" }],
    ).map((product) => product.id),
    ["third", "first", "second"],
  );
});

test("an exact late-catalog match is not subject to the bounded relevant-candidate cap", async () => {
  const originalProductFindMany = prisma.product.findMany;
  const originalSynonymFindMany = prisma.productSearchSynonym.findMany;
  const exact = {
    ...candidate("late-2501", "Late Exact Product", { sku: "LATE-2501" }),
    stock: 10,
    reservedStock: 0,
    lowStockThreshold: 5,
    usesDefaultLowStockThreshold: false,
    productCodeVariant: null,
    category: null,
    categoryGroup: null,
    vendorSource: null,
  };
  try {
    prisma.productSearchSynonym.findMany = async () => [] as any;
    prisma.product.findMany = async (args: any) => {
      if (args.take) return [];
      if (args.include) return [{ ...exact, brand: { id: "brand", name: "Bagmati Plastic" } }];
      return [exact];
    };
    const result = await searchProductsWithDeterministicRanking({
      query: "LATE-2501",
      where: { isActive: true },
      page: 1,
      pageSize: 10,
      settings: { defaultLowStockThreshold: 5 } as any,
    });
    assert.deepEqual(result.products.map((product) => product.id), ["late-2501"]);
    assert.equal(result.search.totalIsExact, true);
  } finally {
    prisma.product.findMany = originalProductFindMany;
    prisma.productSearchSynonym.findMany = originalSynonymFindMany;
  }
});
