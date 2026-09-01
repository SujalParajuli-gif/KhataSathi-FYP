# KhataSathi Import Extraction Plan

Last reviewed: 2026-08-31

This is the canonical plan for future discussions about the product-catalog import pipeline. Before proposing or implementing import-extraction changes, read this file and compare it with the current branch. The plan intentionally excludes VPS deployment and production-data cutover; those require their own approval and rehearsal.

## Objective

Make catalog extraction reliable for CSV, XLSX, native-text PDF, scanned PDF, PNG, and JPEG without making paid AI APIs a permanent production dependency. Preserve the existing review workflow and require explicit human approval before catalog changes are committed.

## Existing system to preserve

- Persistent import batches and editable staging rows.
- Stored source documents with spreadsheet rows, PDF pages, and image/PDF highlight regions.
- Paginated review with create, update, keep-existing, and ignore decisions.
- Batch-wide and selected-row price-field reassignment for purchase, retail, and wholesale prices.
- Coming-soon products with no announced price and zero stock.
- Package quantity kept separate from inventory stock.
- Conservative catalog comparison using barcode where reliable, otherwise normalized brand plus product name, with supplier code as a cautious secondary signal.
- Repeated-file fingerprints, supplier spreadsheet templates, audit logs, and idempotent commit tokens.
- Explicit final confirmation; extraction confidence must never cause an automatic production import.

## Agreed extraction architecture

1. CSV and XLSX use direct structured parsing. They must never be OCRed.
2. Native-text PDFs use PDF.js text and coordinates plus a deterministic, geometry-aware table parser.
3. Images and scanned PDFs eventually use a locally hosted layout-aware OCR worker, with PaddleOCR PP-StructureV3 as the first candidate to benchmark.
4. Every extractor returns the same normalized staging contract: product fields, extracted price candidates, category context, source page/row, source region, uncertainty information, and original evidence.
5. Existing TypeScript code remains responsible for normalization, price-field decisions, validation, duplicate/change comparison, review, audit, and final commit.

## Required work order

### 1. Golden regression corpus

Before replacing an extraction engine, build private test fixtures and approved expected results from Bagmati, Panas Jars, Panas Bottle, United Plastic, KI Mop, SPL spreadsheets, a coming-soon catalog, and a multi-column image catalog.

Measure:

- expected rows versus extracted rows;
- exact product-name and price accuracy;
- headers incorrectly classified as products;
- missing rows and incorrect categories;
- source-highlight alignment;
- runtime and peak memory;
- manual corrections made during review.

Accuracy claims are invalid unless they come from this corpus.

### 2. Improve native-text PDF parsing

Use existing PDF.js coordinates to detect header columns, cluster text into physical rows, map cells by horizontal boundaries, preserve the complete product-name cell, propagate category headings, and retain exact row coordinates. Avoid accumulating supplier- or filename-specific parsing branches.

Do not introduce PyMuPDF without an explicit licence decision. PyMuPDF uses AGPL or a commercial licence, and adding a Python service only for native PDFs is currently unnecessary.

### 3. Local OCR proof of concept

Implement the OCR engine behind an extractor interface or isolated internal worker. Benchmark PaddleOCR PP-StructureV3 against the golden corpus and the actual VPS resources before adopting it.

The worker must return table rows/cells, coordinates, OCR recognition scores, and uncertainty—not a flattened text blob. Keep the current remote AI extractor available only as a development fallback until the local worker meets the acceptance criteria. Do not remove it prematurely and do not require it in the final no-paid-API deployment.

### 4. Evidence-based review signals

Use actual OCR recognition confidence and deterministic warnings such as missing names, ambiguous price columns, invalid numbers, suspected headings, duplicate source rows, or missing source regions. Do not display invented percentage scores based only on field presence and do not auto-select or auto-import rows because of a confidence number.

### 5. Minimal extraction telemetry

Store extractor name/version, duration, raw candidate count, accepted row count, ambiguous/failed count, and reviewed-field correction counts in existing batch metadata or audit records. Do not build a separate analytics dashboard until the stored metrics demonstrate a real need.

## Explicitly rejected approaches

- Do not copy the files in `C:\Users\Nitro\Downloads\suggestion of claude` into the application; they are prototypes and contain incompatible and unsafe assumptions.
- Do not run three extraction engines on every file and merge them by vague voting.
- Do not use fuzzy name similarity to merge products automatically. It may only become a non-binding possible-match hint later.
- Do not map an ambiguous supplier price directly to retail or wholesale; require the existing price setup decision.
- Do not invent stock, selling prices, codes, categories, brands, or missing words.
- Do not drop rows merely because price, code, category, or package information is absent. Only product name is universally required; a missing price uses the coming-soon flow.
- Do not add PaddleOCR-VL, another local VLM, cell-crop storage, or a replacement review UI unless corpus evidence proves it is necessary.

## Deployment gate

The extractor work is ready for deployment only after the golden corpus passes, frontend/backend tests and production builds pass, source highlighting is manually checked on desktop and mobile, OCR resource use fits the VPS, database migrations are rehearsed against a disposable database, and the owner explicitly approves deployment and production-data cutover.
