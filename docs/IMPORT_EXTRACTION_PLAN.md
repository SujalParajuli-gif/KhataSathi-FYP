# KhataSathi Import Extraction Plan

Last reviewed: 2026-09-09

This is the canonical plan for future discussions about the product-catalog import pipeline. Before proposing or implementing import-extraction changes, read this file and compare it with the current branch. The plan intentionally excludes VPS deployment and production-data cutover; those require their own approval and rehearsal.

## Objective

Make catalog extraction reliable for CSV, XLSX, native-text PDF, scanned PDF, PNG, and JPEG without making paid AI APIs a permanent production dependency. Preserve the existing review workflow and require explicit human approval before catalog changes are committed.

## Existing system to preserve

- Persistent import batches and editable staging rows.
- Stored source documents with spreadsheet rows, PDF pages, and image/PDF highlight regions.
- Paginated review with create, update, keep-existing, and ignore decisions.
- Batch-wide and selected-row price-field reassignment for neutral Rate, Retail, and Wholesale prices.
- Coming-soon products with no announced price and zero stock.
- Package quantity kept separate from inventory stock.
- Conservative catalog comparison using barcode where reliable, otherwise normalized brand plus product name, with supplier code as a cautious secondary signal.
- Repeated-file fingerprints, supplier spreadsheet templates, audit logs, and idempotent commit tokens.
- Explicit final confirmation; extraction confidence must never cause an automatic production import.

## Agreed extraction architecture

1. CSV and XLSX use direct structured parsing. They must never be OCRed.
2. Native-text PDFs use PDF.js text and coordinates plus a deterministic, geometry-aware table parser.
3. Images and scanned PDFs retain the current optional image reader while local layout-aware OCR is evaluated. PaddleOCR PP-StructureV3 is a candidate, not an approved replacement; compare it with Docling on the same approved corpus and VPS budget before choosing.
4. Every extractor returns the same normalized staging contract: product fields, extracted price candidates, category context, source page/row, source region, uncertainty information, and original evidence.
5. Existing TypeScript code remains responsible for normalization, price-field decisions, validation, duplicate/change comparison, review, audit, and final commit.

## Required work order

### Implemented locally in this revision (not deployed)

- One backend spreadsheet parser serves both preview and import. Operators choose the worksheet and header row; the preview states how many rows are included. CSV extra cells, oversized tables, and duplicate-header collisions cannot silently discard values. XLSX preserves zero-padded identifiers and flags missing formula results, cell errors, and numeric identifier precision risks. Name-only coming-soon lists remain readable.
- Native PDF parsing uses physical header columns where available. Blank price cells retain their position, packing requires header evidence, and source coordinates are retained. Missing prices and possible headings require review. A single WSP/MRP column is not silently treated as the neutral Rate.
- PDF/image uploads are saved before extraction and queued in the existing database. A single background loop in the backend processes pages and saves each page transactionally. Mixed PDFs are routed per page, rather than by the presence of any text anywhere in the file.
- Progress, stopping, interrupted jobs, and page failures are visible. Retry skips saved pages. Partially read pages retain usable candidates and require a separate crop/import of missing products; retries do not overwrite saved corrections or duplicate candidates. Final commit requires explicit acknowledgement of incomplete coverage.
- Commit attempts claim the batch; product changes and row-completion markers are transactional. Concurrent tokens cannot apply the same batch. Saved tokens and a status endpoint recover lost responses. Updates reject a catalog value that changed after review. Restart recovery runs before the API listener opens.
- Review navigation protects unsaved edits. Save-and-next refreshes decisions. Final confirmation uses the shared accessible dialog. Empty source-context responses cannot cause an infinite fetch loop, and progress polling recovers after temporary failures.
- Original extracted evidence survives review and commit. Page metadata records extractor, duration, candidate counts, and completion; review audit entries record fields changed by each save.
- Announced retail/wholesale prices can be retained without inventing a purchase Rate. The same rule applies to product editing and manual price changes. Actual Rate changes record `rateUpdatedAt`; unrelated edits do not renew it. Existing rate dates remain unknown. Successful backups older than 36 hours show as stale. Generic upload failures include request IDs.

This implementation deliberately uses the existing database and backend process. It assumes **one backend instance**; it is not a multi-instance queue, and cancellation is cooperative between parser operations. Limits are 100 PDF pages, 5,000 staged rows, and a ten-minute job budget for processing checks and remote calls. A parser crash can still interrupt the backend; process isolation is a later decision if measured load warrants it.

The synthetic regression tests and local MySQL/browser checks are engineering validation, **not a measured supplier-catalog accuracy claim**. Complex wrapping, category continuation across pages, rotated layouts, and mixed image/text tables within one page still need real-source corpus evidence before broader parsing changes.

### Completed reliability foundation (2026-09-09)

- Production storage directories are created with the runtime user's ownership and write-tested before startup.
- API health now includes persistent storage readiness; imports check storage before expensive extraction.
- Document upload storage failures return a safe service-unavailable response instead of crashing the backend.
- Remote image/page reading has bounded request and total timeouts, controlled fallback, and clear failure messages.
- Images are auto-rotated and compressed for reading; tall catalogues are split into overlapping sections and recombined while retaining source-row coordinates.
- Completely failed repeated imports are processed again rather than reopening an unusable review.
- Import and document upload screens now show an accessible processing state; direct product imports can be cancelled from the UI.

This foundation fixes operational reliability but does not replace the planned golden corpus or local OCR proof of concept below.

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

A read-only comparison command is available after `pnpm build` in `backend`:

```powershell
pnpm imports:benchmark src/tests/fixtures/import-corpus/manifest.json
pnpm imports:benchmark path/to/private-approved-manifest.json
```

Use the synthetic manifest as the format example. Each fixture names a file and approved expected rows with exact names and price cells. Spreadsheet fixtures specify `nameColumn`, `priceColumns`, and, when needed, `sheetName` and `headerRowNumber`. PDFs compare native extracted price keys such as `rate`, `wsp`, and `mrp`; expected rows can specify `pageNumber`. An optional `candidatesFile` supplies normalized OCR candidates (`name`, `prices`, optional `pageNumber`) for comparing an external/local extractor without changing production code. The command does not call OCR APIs or write products. A mismatch exits nonzero. It reports missing/extra names, exact expected price-cell matches, elapsed time, and whole-process peak memory; it does not pretend to score categories or highlight alignment automatically.

Keep real supplier files, approved expected data, and generated results outside tracked source control. Manually review source highlights and categorization as part of corpus approval.

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
