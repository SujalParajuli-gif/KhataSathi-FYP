# Clean Catalog Pilot Data Workflow

## Purpose

Prepare a clean, reversible first-shop catalog without copying local/demo business data or changing the live VPS before final approval. The pilot uses separate Docker volumes and remains isolated until its users, catalog, backups, and restore path have been verified.

## Accounts preserved from the live site

Preserve the five accounts that currently exist on the live site, with their current roles and access. The clean pilot process must read these accounts from the live database; it must not substitute the 11 local/Docker accounts.

The transfer preserves IDs, names, normalized phone numbers, optional emails, password hashes, approved profile details/images, and applicable permission records. Passwords are never exported as plaintext.

Durga Parajuli is the confirmed Admin for the clean pilot. The preflight report must still show all five resolved live accounts before creation is allowed.

## Data intentionally excluded

- all current live products and brands;
- invoices, payments, customers, returns, stock transactions, and billing drafts;
- documents and import-review batches;
- alerts, audit history, login attempts, deleted records, and browser sessions;
- all local-only or archived test accounts.

The source database and its Docker volumes remain untouched and recoverable until a separately approved cutover and retention decision.

## Approved replacement catalog

The complete 1,536-row owner-approved catalog is the only product source for the clean pilot:

- Bagmati: 686
- SPL: 297
- United Plastic: 245
- Pradeep: 140
- Panas Pet: 77
- JSR: 74
- KI Mop: 17

Pricing rules for this prepared batch:

- every supplier Purchase/Rate or MRP/Retail source value becomes the neutral **Rate**;
- Rate does not claim to be a cost, Retail price, or Wholesale price;
- Retail and Wholesale remain blank for the shop to set later;
- 1,522 products have a Rate;
- 14 products without a source price are explicitly marked **Coming soon**;
- all 1,536 products start with zero stock;
- every product has a unique SKU and a unique Brand + Product name.

Generate the deployment artifact from the immutable owner-approved file with:

```powershell
cd backend
pnpm catalog:prepare-approved -- <owner-approved.csv> <vps-ready.csv>
```

The command refuses to overwrite the source file and writes a SHA-256 audit receipt next to the output. Do not deploy a file whose counts or hashes differ from the reviewed receipt.

## Safety controls

1. `Preflight` is read-only and is always run first.
2. The five live accounts must resolve unambiguously; local accounts are not a fallback.
3. `Create` requires the exact confirmation phrase.
4. A fresh Restic backup and successful restore test are required before creating or replacing anything.
5. Existing target volumes are never silently reused or overwritten.
6. The target importer refuses a database that already contains business data.
7. Profile files are hash-checked during transfer.
8. Reports never print passwords, password hashes, API keys, or personal identity fields.
9. Catalog import happens only in the isolated pilot and must pass its final count/price/status audit.
10. Live activation remains a separate user-approved action.

## Step 1 — preflight

From the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/scripts/prepare-clean-pilot.ps1 -Action Preflight
```

Review `deploy/backup-output/clean-pilot-preflight.json`. Confirm it shows exactly the five current live accounts, Durga Parajuli as Admin, and the expected excluded-data counts. Stop if any identity is wrong.

## Step 2 — create the isolated clean pilot

Only after preflight, backup, and restore verification:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/scripts/prepare-clean-pilot.ps1 `
  -Action Create `
  -Confirmation CREATE-SEPARATE-CLEAN-PILOT
```

This creates separate pilot volumes and transfers only the approved accounts/settings. It does not take over the current web ports or activate the pilot publicly.

## Step 3 — import and audit the approved catalog

Use the generated neutral-Rate CSV in the isolated pilot. Before accepting the import, confirm:

- 1,536 products;
- 1,522 Rates;
- 14 Coming soon products;
- zero Retail prices and zero Wholesale prices;
- zero opening stock;
- no missing names, duplicate SKUs, or duplicate Brand + Product names;
- all rows show owner approval.

Do not recompute selling prices or fill missing product details during this step.

The guarded backend command is `catalog:import-approved`. Its compiled deployment
entry point requires both `--file=<approved.csv>` and the exact confirmation
`--confirmation=IMPORT-APPROVED-1536-CATALOG`. It refuses a file whose SHA-256,
approval fields, counts, pricing rules, or uniqueness checks differ from the
owner-approved artifact. It also refuses a target that does not contain exactly
the five approved active accounts or already contains business data.

## Step 4 — verification before activation

- sign in with each of the five live accounts and verify its role/access;
- verify Catalog Only behavior and hidden billing/POS routes;
- verify product search, Products, Product Lookup, images, alerts, and settings;
- verify normal products require a Rate and Coming soon products cannot be sold;
- verify import Price Setup, selected-product bulk changes, and source highlighting;
- restart the isolated services and confirm data/files persist;
- create and restore-test a pilot backup;
- compare the database audit with the prepared catalog receipt.

## Activation and rollback

Present the complete isolated-pilot results before changing the live VPS. Activation requires explicit user approval. Until the pilot is accepted, keep the original database, uploads, Docker volumes, and off-VPS backup intact so rollback remains immediate.

After approval, activate the verified pilot by stopping both stacks and setting
these values in the live `deploy/production.env` before restarting production:

```env
MYSQL_DATA_VOLUME_NAME=khatasathi-catalog-pilot-20260907_mysql_data
UPLOADS_VOLUME_NAME=khatasathi-catalog-pilot-20260907_uploads
DOCUMENT_STORAGE_VOLUME_NAME=khatasathi-catalog-pilot-20260907_document_storage
```

Do not delete or overwrite the original `khatasathi_mysql_data`,
`khatasathi_uploads`, or `khatasathi_document_storage` volumes. Rollback is the
reverse operation: stop production, restore the three original volume names in
`production.env`, and restart the production stack. Run a fresh recovery backup
and restore verification immediately before activation and again after the
new live stack passes its health and catalog audit.
