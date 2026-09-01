# Clean Catalog Pilot Data Workflow

## Purpose

This workflow prepares a clean, reversible KhataSathi pilot without deleting or editing the existing development database. It is designed for the first real shop rollout, where old demo/Kirana products and test billing records must not appear.

The clean pilot is a separate Docker Compose project with separate MySQL and upload volumes. The current stack remains the rollback source until the pilot has been verified and deliberately activated.

## What is preserved

The five approved active accounts:

- `ADMINSujal` — Admin
- `Sujal Manager` — Manager
- `Sakshyam Sharma` — Cashier
- `Sujalstaff` — Staff
- `Maniram Panthee` — Staff

For these five accounts, the transfer preserves:

- IDs, names, normalized phone numbers, and optional emails;
- password hashes, never plaintext passwords;
- profile details and available profile images;
- the Cashier permission record;
- safe business default values.

The target starts in `CATALOG_ONLY`, forces staff billing draft requests off, removes any saved POS override PIN, and applies the centrally reviewed search vocabulary.

## What is intentionally not copied

- demo, Kirana, or current product and brand rows;
- invoices, payments, customers, returns, stock transactions, or billing drafts;
- document records or document files;
- product/import review batches;
- old alerts, audit history, login attempts, or recycle-bin entries;
- current browser/login sessions;
- archived test accounts.

The omitted source data remains recoverable in the old Docker volumes and in the full recovery backup. It is not silently destroyed.

## Safety controls

1. `Preflight` is the default action and is read-only.
2. The Admin, Manager, and Cashier references must each resolve to one active account, and every Staff reference must resolve to a different active Staff account.
3. The `Create` action requires the exact confirmation phrase.
4. A fresh Restic full-recovery snapshot is required before the target is created.
5. Existing target volumes are never reused or overwritten.
6. The target importer refuses any database that already contains users, products, invoices, documents, import reviews, or audit records.
7. Profile images are transferred in memory and checked with SHA-256 before being written.
8. The transfer never prints password hashes or personal identity fields in its report.
9. Supplier files become review batches only; no catalogue row is inserted as a Product until the Admin completes final in-app approval.

## Step 1 — generate the preflight report

From Windows PowerShell in the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/scripts/prepare-clean-pilot.ps1 -Action Preflight
```

The ignored report is written to `deploy/backup-output/clean-pilot-preflight.json`.

Review the five preserved names/roles and every excluded count. If any selected account is wrong, stop and pass the correct ID, name, email, or phone explicitly through `-AdminIdentity`, `-ManagerIdentity`, `-CashierIdentity`, or `-StaffIdentities`.

## Step 2 — create the isolated clean pilot

Run this only after reviewing Step 1:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/scripts/prepare-clean-pilot.ps1 `
  -Action Create `
  -Confirmation CREATE-SEPARATE-CLEAN-PILOT
```

This action:

1. makes a new full recovery backup of the current stack;
2. creates the separate `khatasathi-catalog-pilot` MySQL/backend volumes;
3. transfers only the five approved accounts and their allowed settings/files;
4. verifies the target has five accounts and zero products, documents, sessions, or import reviews;
5. writes an ignored receipt to `deploy/backup-output/clean-pilot-import-receipt.json`.

It does not start the pilot web container because the current web container already owns ports 80/443. Activation/cutover is a separate, reviewable step.

## Step 3 — prepare one supplier catalogue for review

Do not combine this with database creation.

- CSV or XLSX from a trusted local path can be staged with `pnpm prepare:supplier-review -- <file>` inside the selected pilot backend environment.
- PDF or image catalogues must be opened through **Products → Import** so extraction, row correction, ignored rows, aliases, and final confirmation all use the same review UI.
- The staging command reports `productsCreated: 0`. That is the intended approval boundary.

For every approved catalogue, confirm these rules row by row before final import:

- map each supplier price column only after its meaning is confirmed for that source;
- Bagmati, JSR, KI Mop, Pradeep, Panas Pet, and United Plastic `Wholesale Rate` values map to Purchase Rate under the approved source rules;
- SPL and United Plastic `MRP` values map to Retail Price;
- leave shop Wholesale Price blank because none of the approved sources provides it;
- never calculate or copy a missing Purchase, Retail, or Wholesale value from another price field;
- brand/company and category are verified;
- package quantity, sale unit, size, and product-specific aliases are accurate;
- no Kirana/demo row is selected.

Coming-soon and nullable selling-price behavior must pass the implementation/browser gate before the first real catalogue is finally imported.

## Step 4 — verification before activation

- sign in again with each of the five accounts;
- verify role routes and price visibility;
- verify Catalog Only hides stock claims and all billing/POS routes;
- verify Product Lookup, Products, images, and Alerts;
- upload then remove one temporary image and one temporary document;
- restart the pilot backend and confirm the transferred profiles persist;
- generate a pilot backup and pass isolated restore verification;
- stage one supplier file and confirm it creates only a review batch.

## Rollback principle

Until the clean pilot has passed verification, never remove the original `khatasathi_*` volumes. If the target fails, stop its containers and return to the original project. Destruction of old volumes is a later retention decision after real pilot acceptance and a separately verified backup.
