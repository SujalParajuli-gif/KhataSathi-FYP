# Khata Sathi

> Final Year Project focused on point of sale, inventory control, invoicing, and day-to-day retail operations.

## Overview

Khata Sathi is a full-stack POS and Inventory Management System built to help shops and small-to-medium businesses manage billing, products, stock, customers, invoices, cashier activity, and operational records from a single web application. The project is designed around practical retail workflows where speed, billing accuracy, and clear inventory visibility matter every day.

It combines role-based access, product and customer management, payment handling, reporting, and inventory tracking into one structured system so that routine business tasks can be completed with less manual effort and better operational consistency.

## Problem Statement

Many shops still depend on manual billing, disconnected spreadsheets, or loosely organized records for sales, stock, and customer information. This often leads to:

- slow checkout and billing delays
- stock mismatch and poor inventory visibility
- difficulty tracking invoices and payment status
- limited insight into cashier activity and sales performance
- inconsistent customer records and discount handling

## Solution Summary

Khata Sathi addresses these challenges by providing a centralized web-based platform where administrators and cashiers can manage the full sales cycle, from product setup and customer selection to billing, invoice generation, payment recording, stock updates, and reporting.

The system is structured to support real shop operations with role-based workflows, organized master data, low-stock awareness, invoice history, and business reporting that helps store owners monitor daily activity more effectively.

## Core Features

- role-based authentication for admin and cashier users
- product management with SKU, barcode, pricing, stock, and image support
- brand and category-based product organization
- customer management with loyalty and wholesale discount handling
- billing workflow for product selection, quantity handling, and payment capture
- invoice creation, viewing, printing, and payment status tracking
- stock updates tied to sales, restocking, and manual adjustments
- low-stock alerts and operational notifications
- analytics and reporting with chart-based summaries
- payment handling for cash and configurable digital payment flow support
- profile and settings management for business-level defaults
- audit and login activity visibility for operational traceability

## User Roles

| Role | Responsibilities |
| --- | --- |
| Admin | Manage products, brands, customers, discounts, users, settings, inventory rules, alerts, invoices, analytics, and operational records. |
| Cashier | Handle billing, customer selection, payment collection, invoice creation, invoice history review, alerts, and personal profile management. |

## System Modules / Major Pages

- Dashboard: business overview, recent activity, and stock-aware operational summary
- Billing: cashier-focused sales flow with cart handling, customer selection, discounts, and payment processing
- Products: product catalog management with stock, pricing, brand, category, and image support
- Invoices: invoice listing, payment status visibility, editing/settlement flow, and print support
- Analytics: sales trends, payment distribution, cashier performance, top products, top customers, and brand performance
- Discounts: loyalty and customer-specific wholesale discount management
- History: invoice/payment history review for operational tracking
- Alerts: low-stock and invoice-related alert visibility
- Settings: business defaults, thresholds, brand administration, and system-level controls
- Profile: admin and cashier profile management
- Customer Discounts: cashier-accessible view of loyalty and wholesale discount information
- Authentication and Print Routes: login flow, invoice print route, and payment result handling

## Tech Stack

The current repository reflects the following stack:

| Category | Technology |
| --- | --- |
| Frontend | React 19, React Router 7, TypeScript, Vite |
| Styling | Tailwind CSS 4 |
| Backend | Node.js, Express 5, TypeScript |
| Database | MySQL |
| ORM | Prisma |
| API Client | Axios |
| Forms and Validation | React Hook Form, Zod |
| Authentication | JWT-based auth, bcryptjs |
| Reporting and Charts | Recharts, ExcelJS, CSV export support |
| File Handling | Multer and local uploads directory |
| Payments | Cash workflow and eSewa-related integration support |
| Package Manager | pnpm |

If your local or final submission setup differs, you can update this section without changing the rest of the documentation structure.

## Architecture / How the System Works

Khata Sathi follows a full-stack web application structure with a dedicated frontend and backend:

```text
Frontend (React + React Router)
        |
        v
REST API Layer (Express)
        |
        v
Business Logic + Validation + Role Checks
        |
        v
Prisma ORM
        |
        v
MySQL Database
```

At runtime, authenticated users interact with the frontend interface, which communicates with the backend API using token-based requests. The backend applies authentication, role-based access control, validation, and business rules before reading from or writing to the database. Operational data such as invoices, payments, stock movements, customers, and product records are then surfaced back to the UI for billing, monitoring, and reporting.

## Key Business Workflows

1. Admin or cashier logs in to the system through role-based authentication.
2. The user accesses the appropriate dashboard or billing workspace based on role.
3. Products are selected, customer information is attached if needed, and discounts are applied according to business rules.
4. Payment is recorded and an invoice is generated.
5. Product stock is updated automatically through inventory transactions.
6. Invoice history, alerts, analytics, and reports reflect the completed operation for later review.

Typical retail flow:

```text
Login -> Product/Customer Selection -> Billing -> Payment -> Invoice Generation -> Stock Update -> History/Analytics Visibility
```

## Screens / Feature Highlights

The project currently includes screens and workflows for:

- dashboard overview and operational summary
- billing and checkout flow
- products and stock administration
- invoice listing, detail review, and print support
- analytics and report visualization
- discount and customer discount management
- alerts, settings, and user profile management

> Add screenshots or short GIFs here when preparing the public repository showcase. Recommended highlights: Dashboard, Billing, Products, Invoices, and Analytics.

## Installation and Setup

### Prerequisites

- Node.js 20+ recommended
- pnpm 10+ recommended
- MySQL database instance
- Git

### Clone the Repository

```bash
git clone <your-repository-url>
cd KhataSathi-FYP
```

### Install Dependencies

```bash
cd backend
pnpm install

cd ../frontend
pnpm install
```

If you prefer `npm`, you can replace the package manager commands accordingly.

## Environment Variables

Create environment files before running the project.

### Backend `.env`

```env
DATABASE_URL="mysql://username:password@localhost:3306/khatasathi"
JWT_SECRET="replace_with_a_secure_secret"
PORT=4000
FRONTEND_BASE_URL="http://localhost:5173"
BACKEND_BASE_URL="http://localhost:4000"

# Optional payment configuration
ESEWA_PRODUCT_CODE=""
ESEWA_SECRET_KEY=""
ESEWA_FORM_URL=""
ESEWA_STATUS_CHECK_URL=""

# Optional backup configuration
MYSQLDUMP_PATH=""
MYSQL_BIN_DIR=""
MYSQL_HOME=""
```

### Frontend `.env`

```env
VITE_API_BASE_URL="http://localhost:4000"
```

Only keep the variables relevant to your environment. Add, rename, or remove fields based on your final deployment or academic submission needs.

## How to Run Frontend and Backend

### Run the Backend

```bash
cd backend
pnpm dev
```

The backend API is expected to run on:

```text
http://localhost:4000
```

### Run the Frontend

```bash
cd frontend
pnpm dev
```

The frontend development server is expected to run on:

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

Khata Sathi currently uses Prisma with a MySQL datasource.

### Recommended Setup Flow

1. Create a MySQL database for the project.
2. Update `DATABASE_URL` in `backend/.env`.
3. Generate the Prisma client if needed.
4. Run migrations.
5. Seed development data if you want sample records for testing.

### Example Commands

```bash
cd backend
pnpm prisma generate
pnpm prisma migrate dev
pnpm prisma db seed
```

The seed flow can be used to prepare local demo data for development. Review and adjust seeded accounts or sample business data before using the system beyond local testing.

## Folder Structure Overview

```text
KhataSathi-FYP/
|-- backend/
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
`-- README.md
```

This structure separates presentation, API logic, database schema, and uploaded assets in a way that is easy to extend as the project grows.

## Future Improvements / Scalability

- supplier and purchase order management
- barcode scanner integration for faster checkout
- returns, refunds, and exchange workflows
- multi-branch or multi-store support
- advanced role and permission granularity
- automated testing, CI/CD, and deployment pipelines
- containerized deployment and environment standardization
- richer financial reporting and downloadable statements
- offline-first or sync-capable billing support for unstable network environments

## Academic Project Note

This repository was developed as a Final Year Project and is intended to demonstrate practical full-stack software engineering in the domain of POS and inventory management. It combines business workflow design, database modeling, API development, frontend implementation, reporting, and role-based system behavior in one academic project.

You can extend this section with your institution, department, supervisor, or submission details if required for final documentation.

## Contribution

This project is primarily maintained as an academic and portfolio repository. Constructive suggestions, issue reports, and improvement ideas are welcome. If you plan to contribute, open an issue first for major changes so the scope and direction can be discussed clearly.

## License

A repository-level license has not been finalized yet. If you plan to distribute, reuse, or open-source this project more formally, add a `LICENSE` file and update this section accordingly.

## Author

**Name:** [Your Name]  
**Program:** [Your Program / Department]  
**Institution:** [Your College or University]  
**Project:** Final Year Project - Khata Sathi
