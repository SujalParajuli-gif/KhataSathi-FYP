# Import reliability validation — 2026-09-09

These engineering checks were completed before code release `738e4bd65b990e9557154a411c8f550256132c0e` was deployed to the live VPS on 2026-09-10. The additive production migration was applied during startup. No catalog rows were imported by the deployment.

## Results

| Check | Result |
| --- | --- |
| Backend TypeScript build | Passed |
| Backend tests with database integration enabled | 259 passed, 0 skipped |
| Frontend typecheck | Passed |
| Frontend production build | Passed |
| Existing frontend route/review tests | 26 passed |
| Chromium browser tests | 5 passed, including a 390px mobile viewport |
| Clean MySQL 8.4 migration rehearsal | All 63 migrations applied, including `20260909000100_product_rate_freshness` |
| Synthetic corpus benchmark | 2/2 exact names and 4/4 expected price cells; no missing or extra rows |

The database was a disposable local container on `127.0.0.1:33309`, database `khatasathi_import_test`. OCR keys were explicitly cleared for mixed-PDF integration tests, so those tests made no paid image-reading calls. Synthetic PDFs exercise actual PDF text extraction, coordinates, native-page routing, and the unavailable-OCR failure path.

The database scenarios cover exact duplicate retention, explicit price updates, lost-response replay, two concurrent commit tokens, row/product transaction completion, changed catalog values after review, ignore-only commits, retail-only products, rate dates surviving unrelated edits, incomplete-coverage rejection and acknowledgement, queued cancellation, page retry with saved corrections, partial-page retention, and price remapping after commit. The final additions to this integration scenario were rerun successfully after the full suite.

Browser scenarios cover progress polling after a temporary failure, empty source-context responses, unsaved navigation, saving edits, incomplete-page confirmation, Escape dismissal, recovered commit results without another commit request, multipart spreadsheet uploads, correction of an invalid header selection, and mobile editing.

## Repeatable checks

From `backend`, run `pnpm test`. The database scenario is opt-in: set `RUN_DB_INTEGRATION_TESTS=1`, `DATABASE_URL` to a disposable migrated database whose name contains `test`, and `DOCUMENT_STORAGE_ROOT` to a temporary test directory. Never point this test at shop data. Run the read-only corpus command described in [the extraction plan](IMPORT_EXTRACTION_PLAN.md).

From `frontend`, run `pnpm typecheck`, `pnpm test:routes`, `pnpm build`, and `pnpm test:browser`. Install the test browser once with `pnpm exec playwright install chromium`. Browser tests mock API responses and run a local frontend on port 5179.

## Before deployment

- Apply the additive rate-date migration through the normal release process before starting this backend. Old rate dates intentionally remain unknown.
- Run one backend instance; startup recovery assumes a single worker. The queue survives restarts, but parser execution remains in the backend process and cancellation is cooperative.
- Rehearse representative private supplier files and manually inspect source highlights on desktop and mobile. Synthetic tests do not establish real catalog accuracy.
- Benchmark local OCR candidates on approved expected data and the actual VPS before replacing the existing reader. No local OCR engine or new Python service was introduced.

Production deployment and isolated post-deployment restore verification completed on 2026-09-10. Supplier-corpus accuracy approval remains a separate step; synthetic tests do not establish it.

## Local follow-up validation — 2026-09-11

These checks cover later local changes and are not a production deployment record.

- The exact Panas Jars PDF routes pages 1 and 2 through native parsing with 29 and 22 rows. Page 3 contains only `0` and is classified as an empty completed page. The resulting 51 rows exclude category-only labels.
- The exact prefixed-namespace Super Plastic XLSX opens successfully with 44 rows and 17 columns. A synthetic prefixed-SpreadsheetML workbook is included as a regression test.
- The exact Super Plastic image detects a center gutter at x=877 and can return all 44 rows in one two-panel request. English aliases were returned for the Nepali rows. Repeated remote-model reads still vary: visually similar digits produced five incorrect announced prices in the accepted split benchmark (38/43 exact prices, 88.4%), although the decimal-scale error was removed. Every image row therefore remains subject to source-backed human review.
- Runtime source was searched for supplier and fixture names. No supplier- or filename-specific extraction branch was found or added.
- Validation passed after the combined changes: backend build and tests (265 passed, 1 intentionally skipped), frontend typecheck, 26 route tests, production build, and 5 Chromium browser tests. These should still be rerun immediately before deployment because the working tree contains the owner's concurrent UI changes.
