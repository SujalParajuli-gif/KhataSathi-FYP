-- AlterTable
ALTER TABLE `Invoice` ADD COLUMN `billRecordStatus` ENUM('PENDING', 'RECORDED', 'VERIFIED', 'MISSING') NULL,
    ADD COLUMN `billingChannel` ENUM('MANUAL_EXTERNAL', 'IRD_ELECTRONIC') NULL,
    ADD COLUMN `externalBillDate` DATE NULL,
    ADD COLUMN `externalBillNo` VARCHAR(100) NULL,
    ADD COLUMN `externalDocumentType` ENUM('PAN_INVOICE', 'VAT_TAX_INVOICE', 'ABBREVIATED_TAX_INVOICE', 'OTHER_MANUAL_SALES_DOCUMENT') NULL;

-- AlterTable
ALTER TABLE `BusinessSettings` ADD COLUMN `defaultBillingChannel` ENUM('MANUAL_EXTERNAL', 'IRD_ELECTRONIC') NULL;

-- AlterTable
ALTER TABLE `Document` ADD COLUMN `recoveryCheckoutOperationKey` VARCHAR(120) NULL,
    ADD COLUMN `recoveryCheckoutPayloadHash` CHAR(64) NULL,
    ADD COLUMN `saleRecoveryStatus` ENUM('UNRESOLVED', 'ATTACHED', 'ARCHIVED') NULL,
    MODIFY `documentType` ENUM('STOCK_BILL', 'PRODUCT_IMPORT', 'RETURN_PROOF', 'PAYMENT_PROOF', 'DISCOUNT_PROOF', 'GENERAL', 'SALE_BILL') NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX `Document_recoveryCheckoutOperationKey_key` ON `Document`(`recoveryCheckoutOperationKey`);
