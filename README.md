# KhataSathi

> Final Year Project for a web-based billing and inventory management system designed for a single-shop wholesale and retail environment in Nepal.

## Overview

KhataSathi is a full-stack billing and inventory management system built around the day-to-day workflow of a shop. It brings billing, product management, stock tracking, customer discounts, invoice handling, payment recording, analytics, and operational history into one web application used by Admin and Cashier roles.

The project was developed for practical single-shop use. The current implementation supports one shop, cash payments, eSewa sandbox payment flow, inventory operations, invoice lifecycle handling, audit visibility, and manual database backup. It is not a multi-branch platform, does not include Khalti in the completed implementation, and is not intended to replace a full accounting or VAT filing system.

## Project Preview

### Demo Video

Our Systems walkthrough video link:

[Watch Demo Video](https://drive.google.com/file/d/1bBHBIjrcKxBGoasQc-mBcoLOoG20-TQ3/view?usp=drive_link)

[![KhataSathi Demo](./screenshots/SystemDemo.png)](https://drive.google.com/file/d/1bBHBIjrcKxBGoasQc-mBcoLOoG20-TQ3/view?usp=drive_link)

## Overview Images

![Dashboard Preview](./screenshots/Dashboard.png)
![Billing Preview](./screenshots/Billing.png)

## Problem Statement

Many small wholesale and retail shops still depend on handwritten bills, spreadsheets, or loosely managed records for products, sales, customers, and stock. This often creates issues such as:

- slow billing during busy counter hours
- stock mismatch after repeated sales or manual changes
- difficulty tracking unpaid and partially paid invoices
- inconsistent handling of loyalty and wholesale discounts
- poor visibility into cashier activity and sales summaries
- weak traceability when invoice, price, or stock changes happen

## Solution Summary

KhataSathi addresses these issues through a centralized web-based system where administrators and cashiers can manage billing, products, customers, invoices, payments, stock, and reporting from one controlled workflow.

The implementation is based on the actual business rules used in the system. Draft invoices can be edited before finalization, stock is deducted only when an invoice is finalized, cancelled finalized invoices restore stock, quantity-threshold wholesale pricing can apply automatically, customer-wide wholesale discounts take priority over threshold pricing, loyalty discount applies when wholesale discount is absent, and payment handling supports partial settlement with overpayment prevention.

### Business Rules Implemented in the System

- invoices are first created in `DRAFT` state and remain editable until finalization
- every invoice is linked to the cashier who created it
- finalization is blocked if the invoice has no items
- stock is deducted only when an invoice is finalized, not when the draft is created
- cancelling a finalized invoice restores stock through reverse stock transactions
- quantity-threshold wholesale pricing uses the product's wholesale quantity threshold and wholesale price
- if a customer has a wholesale discount percentage, that subtotal discount takes priority over quantity-threshold wholesale pricing
- loyalty discount is used when wholesale discount is not applied
- applied unit prices and discount amounts are stored with invoice data for later review and auditability
- invoice payment status changes based on successful payments, with support for unpaid, partially paid, fully paid, and cancelled states

## Core Features

### Authentication and Access Control

- role-based authentication for `Admin` and `Cashier`
- opaque server-side sessions in signed, HttpOnly cookies
- CSRF protection for authenticated write operations
- protected route handling
- login attempt logging

### Master Data Management

- user management for admin and cashier accounts
- brand management
- product catalog management
- customer management with loyalty and wholesale discount fields
- product image upload
- CSV product import

### Product and Pricing Logic

- SKU and optional barcode support
- retail price and wholesale price support
- wholesale quantity threshold per product
- low-stock threshold management
- quantity-threshold wholesale pricing at item level
- customer-wide wholesale discount at subtotal level
- loyalty discount when wholesale discount is not applied

### Billing and Invoice Workflow

- draft invoice creation
- add, update, and remove item operations while invoice is in `DRAFT`
- invoice finalization only after at least one item exists
- invoice cancellation after finalization
- applied unit prices and discount values stored for auditability
- printable invoice route

### Payments and Stock Handling

- `CASH` and `ESEWA` payment methods
- partial payment support
- overpayment prevention
- payment records with `PENDING`, `SUCCESS`, and `FAILED` states
- stock deduction on invoice finalization
- stock restoration on cancelled finalized invoices
- manual restock and stock adjustment operations
- low-stock alert visibility

### Reporting and Support Features

- analytics for selectable date ranges
- CSV and Excel export
- audit logs
- login attempt history
- manual admin-triggered database backup

## User Roles

| Role    | Responsibilities                                                                                                                                                 |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin   | Manage users, brands, products, customers, settings, discounts, inventory operations, analytics, invoices, alerts, audit visibility, and manual database backup. |
| Cashier | Handle billing, customer selection, invoice creation, payment recording, invoice review, alerts, and profile management.                                         |

## System Modules / Major Pages

- **Dashboard** - admin overview of sales, invoices, payment summary, and low-stock information
- **Billing** - cashier-focused billing workflow with product selection, customer selection, draft invoice creation, finalization, and payment handling
- **Products** - product catalog management with stock, thresholds, pricing, image upload, and CSV import
- **Invoices** - invoice listing, detail review, payment handling, cancellation, and print access
- **History** - invoice history and review workflow
- **Analytics** - date-range based reporting, charts, summaries, and export
- **Discounts** - customer loyalty and wholesale discount management
- **Customer Discounts** - cashier-side read-only view of customer discount information
- **Alerts** - low-stock and invoice-related alert visibility
- **Settings** - business defaults, brand administration, login attempts, audit visibility, and manual backup
- **Profile** - admin and cashier profile management
- **Authentication / Print Routes** - login flow, printable invoice route, and eSewa result handling

## Tech Stack

| Category                      | Technology                               |
| ----------------------------- | ---------------------------------------- |
| Frontend                      | React, TypeScript, React Router v7, Vite |
| Styling                       | Tailwind CSS                             |
| Charts and Export             | Recharts, ExcelJS                        |
| API and Form Handling         | Axios, React Hook Form                   |
| Backend                       | Node.js, Express, TypeScript             |
| Validation and Security       | Zod, server sessions, CSRF, bcryptjs    |
| File and CSV Handling         | multer, csv-parse                        |
| Database                      | MySQL                                    |
| ORM                           | Prisma                                   |
| Payments                      | Cash flow and eSewa sandbox integration  |
| Backup                        | `mysqldump`-based manual SQL backup      |
| Package Manager / Dev Tooling | pnpm, ts-node-dev                        |

## Architecture / How the System Works

KhataSathi follows a full-stack web application structure with separate frontend and backend layers:

```text
Frontend (React + React Router)
        |
        v
REST API Layer (Express)
        |
        v
Authentication + Role Checks + Business Rules
        |
        v
Prisma ORM
        |
        v
MySQL Database
```

At runtime, the browser authenticates through an opaque server-side session. Its signed session cookie is HttpOnly, authenticated writes require a matching CSRF token, and the backend applies role checks, invoice logic, stock handling rules, pricing and discount rules, and payment validation before reading from or writing to MySQL through Prisma. Uploaded product and profile images are stored in the local `uploads` directory, while invoice, payment, stock, customer, and audit data are stored in the database.

## Key Business Workflows

1. Admin or cashier logs in, and the system records the login attempt.
2. Active products and customers are loaded into the workflow.
3. A cashier creates a draft invoice and adds, updates, or removes items while the invoice remains in `DRAFT`.
4. The system applies product threshold pricing and customer discount rules.
5. The invoice is finalized only when it contains at least one item, and stock is deducted at that point.
6. Payment is recorded through `CASH` or eSewa sandbox flow, with support for partial settlement and overpayment prevention.
7. If a finalized invoice is cancelled, stock is restored and the invoice state is updated accordingly.
8. Alerts, analytics, invoice history, and audit logs reflect the completed activity.

Typical sales flow:

```text
Login -> Select Products -> Select Customer -> Create Draft Invoice -> Apply Pricing / Discount Rules -> Finalize Invoice -> Record Payment -> Print / Review Invoice -> Stock and Analytics Update
```

## Screenshots

### Login

![Login Page](./screenshots/login.png)

### Dashboard

![Dashboard](./screenshots/Dashboard.png)

### Billing

![Billing](./screenshots/Billing.png)

### Products

![Products](./screenshots/products.png)

### Invoices

![Invoices](./screenshots/Invoices.png)

### Analytics

![Analytics](./screenshots/analytics.jpeg)

### Settings / Backup

![Settings](./screenshots/settings.png)

### Payment / QR

![Payment](./screenshots/PaymentEsewa.png)

## Installation and Setup

### Prerequisites

- Node.js 20+ recommended
- pnpm 10+ recommended
- MySQL database instance
- Git
- `mysqldump` available for the backup feature

### Clone the Repository

```bash
git clone https://github.com/SujalParajuli-gif/KhataSathi-FYP.git
cd KhataSathi-FYP
```

### Install Dependencies

Install backend and frontend dependencies separately:

```bash
cd backend
pnpm install

cd ../frontend
pnpm install
```

## Environment Variables

Create `.env` files in both `backend` and `frontend` before running the project.

### Backend `.env`

```env
DATABASE_URL="mysql://root:password@localhost:3306/khatasathi"
SESSION_SECRET="generate-a-unique-random-secret-with-at-least-32-characters"
SESSION_TTL_HOURS=168
PORT=4000
FRONTEND_BASE_URL="http://localhost:5173"
BACKEND_BASE_URL="http://localhost:4000"

ESEWA_PRODUCT_CODE="EPAYTEST"
ESEWA_SECRET_KEY="esewa_secret"
ESEWA_FORM_URL="https://rc-epay.esewa.com.np/api/epay/main/v2/form"
ESEWA_STATUS_CHECK_URL="https://uat.esewa.com.np/api/epay/transaction/status/"

MYSQLDUMP_PATH=""
MYSQL_BIN_DIR=""
MYSQL_HOME=""
```

### Frontend `.env`

```env
VITE_API_BASE_URL="http://localhost:4000"
```

## How to Run Frontend and Backend

### Run the Backend

```bash
cd backend
pnpm dev
```

Backend API:

```text
http://localhost:4000
```

Health check endpoint:

```text
http://localhost:4000/api/health
```

The backend is API-only, so opening `http://localhost:4000` directly will show `Cannot GET /`, while `/api/health` confirms that the server is running correctly.

### Run the Frontend

```bash
cd frontend
pnpm dev
```

Frontend development server:

```text
http://localhost:5173
```

### Production Build

```bash
# backend
cd backend
pnpm build
pnpm start

# frontend
cd frontend
pnpm build
pnpm start
```

## Database Setup Overview

KhataSathi uses Prisma with a MySQL datasource.

### Recommended Setup Flow

1. Create a MySQL database named `khatasathi`
2. Set `DATABASE_URL` in `backend/.env`
3. Generate the Prisma client
4. Run migrations
5. Seed the database for local testing

### Example Commands

```bash
cd backend
pnpm exec prisma generate
pnpm exec prisma migrate dev
pnpm exec prisma db seed
```

### Seeded Demo Accounts

The seed file can create two local testing accounts. Before running it, set
`SEED_ADMIN_PASSWORD` and `SEED_CASHIER_PASSWORD` in `backend/.env` to your own
local-only passwords of at least eight characters. Seed passwords are not kept
in Git, are not printed by the seed command, and the development seed refuses to
run when `NODE_ENV=production`.

## Folder Structure Overview

```text
KhataSathi-FYP/
|-- backend/
|   |-- backups/
|   |-- prisma/
|   |   |-- migrations/
|   |   |-- schema.prisma
|   |   `-- seed.ts
|   |-- src/
|   |   |-- db/
|   |   |-- lib/
|   |   |-- middleware/
|   |   `-- modules/
|   `-- package.json
|-- frontend/
|   |-- app/
|   |   |-- components/
|   |   |-- config/
|   |   |-- lib/
|   |   |-- routes/
|   |   `-- types/
|   |-- public/
|   `-- package.json
|-- uploads/
|-- screenshots/
`-- README.md
```

In practice, `backend/backups/` stores generated SQL backup files, `uploads/` stores locally uploaded profile and product images, and `Screenshots/` can be used to keep README or presentation visuals together with the project.

## Future Improvements / Scalability

- supplier and purchase-order management
- barcode scanner integration
- returns and refund workflow
- multi-branch support
- additional payment gateway support beyond eSewa sandbox
- stronger automated testing coverage
- deployment and CI/CD setup
- richer accounting and tax-related reporting

## Academic Project Note

KhataSathi was developed as a Final Year Project to model the core workflow of a single-shop wholesale and retail business in Nepal. The project focuses on billing, inventory, invoicing, payments, stock tracking, reporting, and operational visibility in a practical full-stack implementation.

The current completed scope is focused on real shop workflow. It supports one shop, uses eSewa sandbox for digital payment flow, does not include Khalti in the completed implementation, and does not aim to replace a full accounting or VAT filing system.

## Author

**Sujal Parajuli**  
BSc (Hons) Computing  
Final Year Project - KhataSathi
