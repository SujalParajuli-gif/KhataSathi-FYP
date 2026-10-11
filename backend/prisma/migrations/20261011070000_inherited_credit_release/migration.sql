ALTER TABLE `Invoice` ADD COLUMN `correctionCreditReleased` DOUBLE NOT NULL DEFAULT 0;

ALTER TABLE `InvoiceCorrectionSettlement` ADD COLUMN `inheritedFunding` JSON NULL;
