import assert from "node:assert/strict";
import test from "node:test";
import { parsePdfTextCatalogPages } from "../modules/products/pdfTextCatalogParser.js";

test("PDF text catalog rejects United headings and separates structured fields", () => {
    const result = parsePdfTextCatalogPages([{ pageNumber: 1, text: [
      "UNITED PLASTIC INDUSTRIES PVT.LTD.",
      "PRICE LIST",
      "S.No. Product Name/Code \tUnit \tPacking Wholesale Rate \tRemarks",
      '1 CHAIR "LARGE"',
      "(a) Patty - 101 \tPcs \t20 \t805",
      "(b) Matty - 103 \tPcs \t20 \t780",
      '2 CHAIR "MEDIUM"',
      "(a) HEAVY \t[Flower - 202] \tPcs \t20 \t780",
      "(w.e.f. Jestha 5, 2083)",
    ].join("\n") }]);

    assert.equal(result.rows.length, 3);
    assert.deepEqual(result.priceColumns, [{ key: "wholesaleRate", label: "Wholesale rate" }]);
    assert.deepEqual(result.rows[0], {
      pageNumber: 1,
      lineNumber: 5,
      rawText: "(a) Patty - 101 Pcs 20 805",
      productName: "Patty - 101",
      productCodeVariant: "",
      category: "CHAIR LARGE",
      packageQuantity: 20,
      packageUnit: "PIECE",
      extractedPrices: [{ key: "wholesaleRate", label: "Wholesale rate", value: 805 }],
    });
    assert.equal(result.rows[2].productName, "HEAVY [Flower - 202]");
    assert.equal(result.rows[2].category, "CHAIR MEDIUM");
    assert.equal(result.rows[2].packageQuantity, 20);
});

test("PDF text catalog keeps two detected price columns distinct and unmapped", () => {
    const result = parsePdfTextCatalogPages([{ pageNumber: 1, text: [
      "Product Name \tUnit \tPacking WSP MRP",
      "Storage Box 5 Ltr \tPcs \t12 \t250 \t325",
    ].join("\n") }]);
    assert.deepEqual(result.priceColumns, [
      { key: "wsp", label: "WSP" },
      { key: "mrp", label: "MRP" },
    ]);
    assert.deepEqual(result.rows[0].extractedPrices.map((price) => price.value), [250, 325]);
});

test("PDF text catalog recognizes serial-name-code-Rate rs tables without a unit column", () => {
  const result = parsePdfTextCatalogPages([{
    pageNumber: 1,
    text: [
      "S.N Jar Name Product code Rate rs.",
      "1 35ml jar 1 10",
      "2 60ml jar 2 10.5",
      "53 Plastic jug 68",
    ].join("\n"),
  }]);

  assert.deepEqual(result.priceColumns, [{ key: "rate", label: "Rate" }]);
  assert.equal(result.rows.length, 3);
  assert.deepEqual(result.rows[0], {
    pageNumber: 1,
    lineNumber: 2,
    rawText: "1 35ml jar 1 10",
    productName: "35ml jar",
    productCodeVariant: "1",
    category: "Uncategorized",
    packageQuantity: null,
    packageUnit: "PIECE",
    extractedPrices: [{ key: "rate", label: "Rate", value: 10 }],
  });
  assert.equal(result.rows[1].productName, "60ml jar");
  assert.equal(result.rows[1].productCodeVariant, "2");
  assert.equal(result.rows[1].extractedPrices[0]?.value, 10.5);
  assert.equal(result.rows[2].productName, "Plastic jug");
  assert.equal(result.rows[2].productCodeVariant, "");
  assert.equal(result.rows[2].extractedPrices[0]?.value, 68);
});
