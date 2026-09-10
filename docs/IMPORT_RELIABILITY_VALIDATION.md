# Import reliability validation — 2026-09-09

These are local engineering checks for the current working-tree changes. Nothing was deployed to the live application, and no production database migration or catalog import was performed.

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

Production deployment, a production backup restore drill, and supplier-corpus accuracy approval remain separate operational steps. This receipt is not evidence that any of those steps occurred.
