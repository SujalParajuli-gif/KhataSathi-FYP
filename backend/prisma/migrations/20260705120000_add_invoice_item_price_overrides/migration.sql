ALTER TABLE `InvoiceItem`
  ADD COLUMN `originalUnitPrice` DOUBLE NULL,
  ADD COLUMN `overrideUnitPrice` DOUBLE NULL,
  ADD COLUMN `overrideReason` TEXT NULL,
  ADD COLUMN `overrideById` VARCHAR(191) NULL,
  ADD COLUMN `overrideAt` DATETIME(3) NULL;

CREATE INDEX `InvoiceItem_overrideById_idx` ON `InvoiceItem`(`overrideById`);
