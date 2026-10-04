import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SCHEMA_PATH = path.resolve(__dirname, "../../prisma/schema.prisma");
const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../prisma/migrations/20261004120000_phase2_bill_record_foundation/migration.sql",
);

test("Prisma schema contains all required Phase 2 foundation enums and nullable fields", () => {
  const schemaContent = fs.readFileSync(SCHEMA_PATH, "utf8");

  // Enums
  assert.match(schemaContent, /enum\s+BillingChannel\s*\{[\s\S]*?MANUAL_EXTERNAL[\s\S]*?IRD_ELECTRONIC[\s\S]*?\}/);
  assert.match(schemaContent, /enum\s+ExternalDocumentType\s*\{[\s\S]*?PAN_INVOICE[\s\S]*?VAT_TAX_INVOICE[\s\S]*?ABBREVIATED_TAX_INVOICE[\s\S]*?OTHER_MANUAL_SALES_DOCUMENT[\s\S]*?\}/);
  assert.match(schemaContent, /enum\s+BillRecordStatus\s*\{[\s\S]*?PENDING[\s\S]*?RECORDED[\s\S]*?VERIFIED[\s\S]*?MISSING[\s\S]*?\}/);
  assert.match(schemaContent, /enum\s+SaleRecoveryStatus\s*\{[\s\S]*?UNRESOLVED[\s\S]*?ATTACHED[\s\S]*?ARCHIVED[\s\S]*?\}/);

  // DocumentType enum expansion preserves order and includes SALE_BILL
  assert.match(schemaContent, /enum\s+DocumentType\s*\{[\s\S]*?STOCK_BILL[\s\S]*?PRODUCT_IMPORT[\s\S]*?RETURN_PROOF[\s\S]*?PAYMENT_PROOF[\s\S]*?DISCOUNT_PROOF[\s\S]*?GENERAL[\s\S]*?SALE_BILL[\s\S]*?\}/);

  // Invoice model additions (nullable, no default)
  assert.match(schemaContent, /billingChannel\s+BillingChannel\?/);
  assert.match(schemaContent, /externalDocumentType\s+ExternalDocumentType\?/);
  assert.match(schemaContent, /externalBillNo\s+String\?\s+@db\.VarChar\(100\)/);
  assert.match(schemaContent, /externalBillDate\s+DateTime\?\s+@db\.Date/);
  assert.match(schemaContent, /billRecordStatus\s+BillRecordStatus\?/);

  // BusinessSettings model additions (nullable, no default)
  assert.match(schemaContent, /defaultBillingChannel\s+BillingChannel\?/);

  // Document model additions (nullable, unique key with 120 chars, hash with 64 chars)
  assert.match(schemaContent, /saleRecoveryStatus\s+SaleRecoveryStatus\?/);
  assert.match(schemaContent, /recoveryCheckoutOperationKey\s+String\?\s+@unique\s+@db\.VarChar\(120\)/);
  assert.match(schemaContent, /recoveryCheckoutPayloadHash\s+String\?\s+@db\.Char\(64\)/);
});

test("Phase 2 migration SQL is strictly additive with no destructive DDL or data updates", () => {
  assert.ok(fs.existsSync(MIGRATION_PATH), "Migration file must exist at exact expected path");
  const sqlContent = fs.readFileSync(MIGRATION_PATH, "utf8");

  // Verify presence of ALTER TABLE statements
  assert.match(sqlContent, /ALTER TABLE\s+`Invoice`/i);
  assert.match(sqlContent, /ADD COLUMN\s+`billRecordStatus`\s+ENUM\('PENDING',\s*'RECORDED',\s*'VERIFIED',\s*'MISSING'\)\s+NULL/i);
  assert.match(sqlContent, /ADD COLUMN\s+`billingChannel`\s+ENUM\('MANUAL_EXTERNAL',\s*'IRD_ELECTRONIC'\)\s+NULL/i);
  assert.match(sqlContent, /ADD COLUMN\s+`externalBillDate`\s+DATE\s+NULL/i);
  assert.match(sqlContent, /ADD COLUMN\s+`externalBillNo`\s+VARCHAR\(100\)\s+NULL/i);
  assert.match(sqlContent, /ADD COLUMN\s+`externalDocumentType`\s+ENUM\('PAN_INVOICE',\s*'VAT_TAX_INVOICE',\s*'ABBREVIATED_TAX_INVOICE',\s*'OTHER_MANUAL_SALES_DOCUMENT'\)\s+NULL/i);

  assert.match(sqlContent, /ALTER TABLE\s+`BusinessSettings`/i);
  assert.match(sqlContent, /ADD COLUMN\s+`defaultBillingChannel`\s+ENUM\('MANUAL_EXTERNAL',\s*'IRD_ELECTRONIC'\)\s+NULL/i);

  assert.match(sqlContent, /ALTER TABLE\s+`Document`/i);
  assert.match(sqlContent, /ADD COLUMN\s+`recoveryCheckoutOperationKey`\s+VARCHAR\(120\)\s+NULL/i);
  assert.match(sqlContent, /ADD COLUMN\s+`recoveryCheckoutPayloadHash`\s+CHAR\(64\)\s+NULL/i);
  assert.match(sqlContent, /ADD COLUMN\s+`saleRecoveryStatus`\s+ENUM\('UNRESOLVED',\s*'ATTACHED',\s*'ARCHIVED'\)\s+NULL/i);
  assert.match(sqlContent, /MODIFY\s+`documentType`\s+ENUM\('STOCK_BILL',\s*'PRODUCT_IMPORT',\s*'RETURN_PROOF',\s*'PAYMENT_PROOF',\s*'DISCOUNT_PROOF',\s*'GENERAL',\s*'SALE_BILL'\)\s+NOT NULL/i);

  assert.match(sqlContent, /CREATE UNIQUE INDEX\s+`Document_recoveryCheckoutOperationKey_key`\s+ON\s+`Document`\(`recoveryCheckoutOperationKey`\)/i);

  // Prohibit destructive keywords and data fabrication
  assert.doesNotMatch(sqlContent, /\bDROP\b/i);
  assert.doesNotMatch(sqlContent, /\bDELETE\b/i);
  assert.doesNotMatch(sqlContent, /\bUPDATE\b/i);
  assert.doesNotMatch(sqlContent, /\bINSERT\b/i);
  assert.doesNotMatch(sqlContent, /\bTRUNCATE\b/i);
  assert.doesNotMatch(sqlContent, /\bDEFAULT\b/i);
});
