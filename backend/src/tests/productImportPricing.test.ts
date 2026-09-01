import test from "node:test";
import assert from "node:assert/strict";
import {
  getImportPriceMappingState,
  normalizeCsvImportRow,
  normalizedImageSourceRegions,
  normalizeSellingPrice,
  resolveSellingPriceStatus,
} from "../modules/products/service";

test("recognized spreadsheet and image prices still expose universal price reassignment", () => {
  const state = getImportPriceMappingState({
    rows: [
      {
        parsed: {
          ratePerPiece: 175,
          retailPrice: null,
          wholesalePrice: null,
        },
      },
    ],
  });

  assert.equal(state.required, true);
  assert.equal(state.complete, true);
  assert.deepEqual(state.columns, [
    { key: "sourceRatePerPiece", label: "Extracted purchase rate" },
  ]);
  assert.deepEqual(state.mapping, { sourceRatePerPiece: "ratePerPiece" });
});

test("unclassified PDF price columns remain blocked until the user assigns them", () => {
  const state = getImportPriceMappingState({
    extractionMeta: {
      priceColumns: [{ key: "rate", label: "Rate rs." }],
    },
    rows: [
      {
        parsed: {
          extractedPrices: [{ key: "rate", label: "Rate rs.", value: 10 }],
        },
      },
    ],
  });

  assert.equal(state.required, true);
  assert.equal(state.complete, false);
  assert.deepEqual(state.mapping, { rate: "" });
});

test("regular single-column image regions are corrected when Gemini points one row too low", () => {
  const regions = normalizedImageSourceRegions([
    { boundingBox: [482, 80, 512, 920] },
    { boundingBox: [512, 80, 542, 920] },
    { boundingBox: [542, 80, 572, 920] },
  ]);

  assert.deepEqual(regions[1], {
    top: 475,
    left: 80,
    bottom: 505,
    right: 920,
    scale: 1000,
  });
});

test("two-column image regions are not shifted by the single-column correction", () => {
  const regions = normalizedImageSourceRegions([
    { boundingBox: [80, 80, 92, 490] },
    { boundingBox: [92, 80, 104, 490] },
    { boundingBox: [104, 80, 116, 490] },
  ]);

  assert.deepEqual(regions[1], {
    top: 92,
    left: 80,
    bottom: 104,
    right: 490,
    scale: 1000,
  });
});

test("a bare supplier Rate becomes purchase cost without invented selling prices", () => {
  const row = normalizeCsvImportRow(
    {
      Product_Name: "BUCKET 13 LTR",
      Supplier: "Bagmati Plastic",
      Rate: "172",
      Package_Qty: "24",
    },
    2,
  );

  assert.equal(row.name, "BUCKET 13 LTR");
  assert.equal(row.ratePerPiece, 172);
  assert.equal(row.retailPrice, null);
  assert.equal(row.wholesalePrice, null);
  assert.equal(row.packageQuantity, 24);
});

test("a product name beginning with a size is preserved exactly", () => {
  const row = normalizeCsvImportRow(
    {
      Product_Name: "35ml jar",
      Supplier: "Panas Pet",
      Rate: "10",
    },
    2,
  );

  assert.equal(row.name, "35ml jar");
  assert.equal(row.productName, "35ml jar");
  assert.equal(row.sizeValue, 35);
  assert.equal(row.sizeUnit, "ML");
  assert.equal(row.ratePerPiece, 10);
});

test("fractional sizes preserve the full name and store the correct structured amount", () => {
  const row = normalizeCsvImportRow(
    { Product_Name: "1/2 kg honey hexa", Supplier: "Panas Pet", Rate: "18" },
    2,
  );

  assert.equal(row.name, "1/2 kg honey hexa");
  assert.equal(row.sizeValue, 0.5);
  assert.equal(row.sizeUnit, "KG");
});

test("catalog-specific name headers still use the complete source cell", () => {
  const row = normalizeCsvImportRow(
    {
      "Jar Name": "35ml jar",
      "Product code": "1",
      "Rate rs.": "10",
      Supplier: "Panas Pet",
    },
    2,
    { fieldMap: { ratePerPiece: "Rate rs." } },
  );

  assert.equal(row.name, "35ml jar");
  assert.equal(row.productName, "35ml jar");
  assert.equal(row.sizeValue, 35);
  assert.equal(row.sizeUnit, "ML");
  assert.equal(row.ratePerPiece, 10);
});

test("explicit store selling-price columns remain independent", () => {
  const row = normalizeCsvImportRow(
    {
      Product_Name: "BUCKET 13 LTR",
      Supplier: "Bagmati Plastic",
      Purchase_Cost: "172",
      Retail_Price: "240",
      Wholesale_Price: "220",
    },
    2,
  );

  assert.equal(row.ratePerPiece, 172);
  assert.equal(row.retailPrice, 240);
  assert.equal(row.wholesalePrice, 220);
});

test("a named supplier row can be saved as coming soon without price or package data", () => {
  const row = normalizeCsvImportRow(
    {
      Product_Name: "ROYAL PLANTER BIG",
      Supplier: "Bagmati",
      Rate: "",
      Package_Qty: "",
    },
    2,
  );

  assert.equal(row.name, "ROYAL PLANTER BIG");
  assert.equal(row.ratePerPiece, null);
  assert.equal(row.packageQuantity, null);
  assert.equal(row.retailPrice, null);
  assert.equal(row.wholesalePrice, null);
});

test("the approved Bagmati catalog headers map to their intended fields", () => {
  const row = normalizeCsvImportRow(
    {
      brand: "Bagmati",
      category: "BUCKET",
      catalogSerial: "1",
      productName: "BUCKET 3.5 LTR",
      productCode: "401",
      packageQuantity: "100",
      purchaseRate: "72",
      retailPrice: "",
      storeWholesalePrice: "",
      sourcePage: "3",
    },
    2,
  );

  assert.equal(row.brand, "Bagmati");
  assert.equal(row.productCodeVariant, "401");
  assert.equal(row.ratePerPiece, 72);
  assert.equal(row.packageQuantity, 100);
  assert.equal(row.sourceCitation, "3");
  assert.equal(row.retailPrice, null);
  assert.equal(row.wholesalePrice, null);
});

test("canonical extraction headers accept numeric Excel cells without losing prices or quantities", () => {
  const row = normalizeCsvImportRow(
    {
      Product_Name: "PRINTED BUCKET 13 LTR",
      SKU: "BAGMATI-101-PRINTED-BUCKET-13-LTR",
      Barcode: "",
      Brand: "Bagmati",
      Category: "RIO PRINTED BUCKET",
      Category_Group: "BUCKET",
      Supplier: "Bagmati",
      Product_Code_Variant: 401,
      Package_Quantity: 24,
      Package_Unit: "PIECE",
      Sale_Unit: "PIECE",
      Purchase_Rate: 172,
      Retail_Price: "",
      Wholesale_Price: "",
      Stock: 0,
      Source_Citation: "bagmati.pdf p.3 row 101",
      Search_Aliases: "printed balti; 13 litre bucket",
    },
    2,
  );

  assert.equal(row.name, "PRINTED BUCKET 13 LTR");
  assert.equal(row.sku, "BAGMATI-101-PRINTED-BUCKET-13-LTR");
  assert.equal(row.brand, "Bagmati");
  assert.equal(row.category, "RIO PRINTED BUCKET");
  assert.equal(row.categoryGroup, "BUCKET");
  assert.equal(row.productCodeVariant, "401");
  assert.equal(row.packageQuantity, 24);
  assert.equal(row.ratePerPiece, 172);
  assert.equal(row.retailPrice, null);
  assert.equal(row.wholesalePrice, null);
  assert.equal(row.stock, 0);
  assert.deepEqual(row.searchAliases, ["printed balti", "13 litre bucket"]);
});

test("generated supplier SKUs remain distinct when a catalog reuses its serial number", () => {
  const first = normalizeCsvImportRow({
    Product_Name: "RACK 3",
    Brand: "Bagmati",
    Supplier: "Bagmati",
    Catalog_Serial: "131",
    Purchase_Rate: 100,
  }, 2);
  const second = normalizeCsvImportRow({
    Product_Name: "MARRY GOLD PLANTER 14 INCH WITH PLATE",
    Brand: "Bagmati",
    Supplier: "Bagmati",
    Catalog_Serial: "131",
    Purchase_Rate: 200,
  }, 3);

  assert.notEqual(first.sku, second.sku);
  assert.equal(first.sku, normalizeCsvImportRow({
    Product_Name: "RACK 3",
    Brand: "Bagmati",
    Supplier: "Bagmati",
    Catalog_Serial: "131",
    Purchase_Rate: 100,
  }, 2).sku);
  assert.match(first.sku, /^BAGMATI-131-RACK-3-[A-F0-9]{8}$/);
});

test("selling prices are READY only when both positive values exist", () => {
  assert.equal(resolveSellingPriceStatus(null, null), "PENDING");
  assert.equal(resolveSellingPriceStatus(240, null), "PENDING");
  assert.equal(resolveSellingPriceStatus(240, 220), "READY");
  assert.equal(normalizeSellingPrice(0), null);
  assert.equal(normalizeSellingPrice("240.126"), 240.13);
});
