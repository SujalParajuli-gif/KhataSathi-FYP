# KhataSathi

KhataSathi is a production-deployed billing, inventory, and product-catalog web application designed for a single wholesale/retail shop in Nepal. It combines day-to-day shop operations with role-based access, auditability, responsive interfaces, and a containerized recovery strategy.

The system can begin as a catalog-only deployment and enable inventory or full point-of-sale workflows later without maintaining separate applications.

## What the system does

### Product catalog and search

- Product, brand, category, SKU, barcode, unit, package, price, and media management
- Automatically allocated internal SKUs and barcodes when identifiers are not supplied
- Retail, wholesale, and quantity-threshold pricing
- Role-aware visibility for purchase cost and wholesale prices
- Product images with optimized display and thumbnail variants
- Search normalization for English and Nepali input, Devanagari digits, units, aliases, synonyms, prefixes, and bounded typo tolerance
- Search-selection and unmatched-query logging for catalog improvement
- Bulk product selection, price updates, activation/deactivation, and guarded permanent deletion

### Product imports

- CSV and modern XLSX supplier spreadsheet parsing
- Header detection below supplier title rows
- Review batches that keep extracted rows separate from the live catalog until approval
- Saved supplier import templates and field mappings
- Duplicate SKU/barcode detection and row-level validation feedback
- Text-based PDF extraction into a review workflow
- Optional Gemini-assisted PNG/JPG/WEBP supplier rate-list extraction
- Import history, soft deletion, and audit records

Scanned PDFs require OCR or image-based extraction. AI-assisted image import also requires a separately configured Gemini API key; it is not necessary for CSV/XLSX imports.

### Inventory operations

- Stock receiving with supplier/bill metadata and receive-batch history
- Manual stock corrections with an auditable transaction ledger
- Reserved-stock tracking for active operational workflows
- Low-stock thresholds and alerts
- Fractional quantities and configurable sale/package units
- Stock restoration for cancellations and approved returns

### Billing and invoices

- Draft invoices with add, update, and remove item operations
- Atomic checkout with stock-conflict detection
- Stock deduction only when an invoice is finalized
- Parked bills with expiry, resume, discard, and supervisor transfer flows
- Customer loyalty and wholesale discounts
- Manager-authorized price overrides with PIN policy and lockout tracking
- Invoice modification through credit-note and replacement-invoice records
- Cancellation, soft deletion, printing, and detailed invoice history
- Staff-to-cashier billing draft requests with assignment and resolution tracking

### Payments, returns, and cash control

- Cash, eSewa, Fonepay, and bank-transfer payment records
- Partial payments, overpayment prevention, cash tendered, and change calculation
- Payment voiding with permission and authorization checks
- Return requests, approval/rejection, refunds, stock restoration, and reversal handling
- Cash-drawer open/close sessions, cash events, expected totals, and difference tracking

The included eSewa integration is configured for sandbox/testing by default. Production payment activation requires separate operational approval and gateway credentials.

### Users, permissions, and operating modes

Four roles are supported:

| Role | Primary scope |
|---|---|
| Admin | System configuration, users, permissions, catalog, operations, analytics, audit, backup, and recovery |
| Manager | Catalog, inventory, billing, invoices, returns, operational analytics, documents, and approvals |
| Cashier | Billing, invoices, payments, customer workflows, alerts, and assigned permissions |
| Staff | Product lookup, personal profile, and staff billing-draft requests |

The saved business mode determines which operational capabilities are enabled:

| Mode | Catalog | Inventory | Billing/POS |
|---|:---:|:---:|:---:|
| `CATALOG_ONLY` | Yes | No | No |
| `INVENTORY_ONLY` | Yes | Yes | No |
| `FULL_POS` | Yes | Yes | Yes |

Backend middleware enforces roles and business capabilities; navigation visibility is not treated as a security boundary.

### Documents, audit, and reporting

- Protected document uploads with metadata, visibility rules, previews, and image thumbnails
- Recycle-bin workflows and retention-aware permanent deletion
- Operational alerts with per-user read, dismiss, and resolution state
- Categorized audit/history views for products, stock, sales, returns, payments, imports, documents, and system events
- Sales summaries, best sellers, cashier performance, date-range analytics, and CSV/Excel exports
- Read-only storage-integrity reporting for missing, orphaned, or stale files

## Security approach

- Random opaque sessions stored as hashes in MySQL
- Signed HttpOnly session cookies and separate CSRF tokens
- `Secure` production cookies over HTTPS with `SameSite=Lax`
- Password hashing with bcrypt
- Phone-first login with optional normalized email identity
- Forced password change for temporary credentials
- Session revocation and expiry cleanup
- Login, API, background-request, and media rate-limit buckets
- Helmet security headers, request IDs, bounded request bodies, and restricted CORS
- Server-side role, privilege, ownership, and business-capability checks
- MySQL isolated on a private Docker network in production

## Architecture

```text
Browser
  |
  v
Caddy (HTTPS, static frontend, reverse proxy)
  |
  +--> React 19 + React Router 7 application
  |
  +--> Express 5 REST API
          |
          +--> Authentication / CSRF / RBAC / capability middleware
          +--> Business services and background maintenance jobs
          +--> Prisma ORM
                  |
                  v
              MySQL 8.4

Persistent Docker volumes:
  MySQL | uploads | protected documents | backup state | Caddy certificates
```

### Technology stack

| Layer | Technology |
|---|---|
| Frontend | React 19, React Router 7 framework mode, TypeScript, Vite 7 |
| Styling | Tailwind CSS 4, IBM Plex Sans, Space Mono |
| Forms and validation | React Hook Form, Zod |
| Data and charts | Axios, Recharts, ExcelJS |
| Backend | Node.js 22, Express 5, TypeScript |
| Database | MySQL 8.4, Prisma 5 |
| File processing | Multer, Sharp, ExcelJS, csv-parse, pdf-parse |
| Production edge | Caddy with automatic HTTPS |
| Deployment | Docker Compose |
| Recovery | MySQL dumps plus encrypted, deduplicated Restic snapshots |

## Repository layout

```text
backend/
  prisma/                 Schema, migrations, and development seed
  src/config/             Environment validation
  src/middleware/         Authentication, authorization, sanitization
  src/modules/            Feature routes, controllers, and services
  src/scripts/            Audit, import, backfill, and pilot utilities
  src/tests/              Node test suite

frontend/
  app/components/         Reusable layout, UI, and feature components
  app/lib/                API client and frontend domain logic
  app/routes/             React Router pages
  public/                 Fonts, icons, and static assets

deploy/
  recovery/               Isolated Restic recovery image
  scripts/                Backup, restore verification, and health checks
  systemd/                VPS backup timer definitions

compose.production.yml    Production service and volume definition
```

## Local development

### Requirements

- Node.js 22
- pnpm 10
- MySQL

Install dependencies separately:

```bash
cd backend
pnpm install
pnpm exec prisma generate

cd ../frontend
pnpm install
```

Create local `backend/.env` and `frontend/.env` files. Never commit environment files, database credentials, API keys, production data, or SSH keys.

Prepare the local database:

```bash
cd backend
pnpm exec prisma migrate dev
pnpm exec prisma db seed
```

The development seed requires explicit local-only password variables and refuses to run when `NODE_ENV=production`.

Start both applications in separate terminals:

```bash
cd backend
pnpm dev
```

```bash
cd frontend
pnpm dev
```

Default development addresses:

- Frontend: `http://localhost:5173`
- API: `http://localhost:4000`
- Health check: `http://localhost:4000/api/health`

## Verification

```bash
# Backend schema, build, and tests
cd backend
pnpm exec prisma validate
pnpm test

# Frontend types, focused tests, and production build
cd ../frontend
pnpm typecheck
pnpm test:routes
pnpm build
```

Database migrations must be tested against an isolated production-like copy before release. Never run the development seed or `prisma db push` against production.

## Production deployment and recovery

Production Compose starts Caddy, the Express backend, and MySQL. The backend applies committed Prisma migrations with `prisma migrate deploy` before accepting traffic. MySQL is not published to the public network.

Recovery has two distinct levels:

- Database-only SQL checkpoints for narrow database restore scenarios
- Full Restic recovery snapshots containing a transaction-consistent MySQL dump, uploads, protected documents, and a manifest

Full recovery snapshots must be stored in an independent off-VPS repository and periodically verified through the isolated restore-verification script. A Docker volume on the same VPS is persistent storage, not disaster recovery.

Before every production release:

1. Create and verify a full recovery snapshot.
2. Record the current Git commit and container state.
3. Run schema, backend, frontend, and migration checks.
4. Deploy outside peak shop hours.
5. Verify health, logs, authentication, catalog lookup, uploads, and the enabled business mode.

## Scope

KhataSathi currently targets one shop and one deployment. It is not yet a multi-tenant, multi-branch, offline-first, or full accounting/VAT filing platform.

## Author

Sujal Parajuli — BSc (Hons) Computing, Final Year Project
