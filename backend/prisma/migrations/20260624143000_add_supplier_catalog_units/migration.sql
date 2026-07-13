-- Product catalog metadata for supplier rate lists and dynamic unit/packaging support.
ALTER TABLE `Product`
  ADD COLUMN `productName` VARCHAR(191) NULL,
  ADD COLUMN `categoryGroup` VARCHAR(191) NULL,
  ADD COLUMN `vendorSource` VARCHAR(191) NULL,
  ADD COLUMN `productCodeVariant` VARCHAR(191) NULL,
  ADD COLUMN `sizeValue` DOUBLE NULL,
  ADD COLUMN `sizeUnit` VARCHAR(191) NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN `ratePerPiece` DOUBLE NOT NULL DEFAULT 0,
  ADD COLUMN `packageQuantity` DOUBLE NOT NULL DEFAULT 1,
  ADD COLUMN `packageUnit` VARCHAR(191) NOT NULL DEFAULT 'PIECE',
  ADD COLUMN `saleUnit` VARCHAR(191) NOT NULL DEFAULT 'PIECE',
  ADD COLUMN `allowFractionalQty` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `quantityStep` DOUBLE NOT NULL DEFAULT 1,
  ADD COLUMN `wholesaleEligible` BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN `sourceCitation` VARCHAR(191) NULL;

UPDATE `Product`
SET
  `productName` = `name`,
  `ratePerPiece` = `retailPrice`
WHERE `productName` IS NULL;

ALTER TABLE `Product`
  MODIFY `stock` DOUBLE NOT NULL DEFAULT 0,
  MODIFY `lowStockThreshold` DOUBLE NOT NULL DEFAULT 5,
  MODIFY `wholesaleQtyThreshold` DOUBLE NOT NULL DEFAULT 1;

ALTER TABLE `BusinessSettings`
  MODIFY `defaultLowStockThreshold` DOUBLE NOT NULL DEFAULT 5,
  MODIFY `defaultWholesaleQtyThreshold` DOUBLE NOT NULL DEFAULT 15;

ALTER TABLE `InvoiceItem`
  MODIFY `qty` DOUBLE NOT NULL;

ALTER TABLE `ReturnItem`
  MODIFY `qtyReturned` DOUBLE NOT NULL;

ALTER TABLE `StockTransaction`
  MODIFY `qtyDelta` DOUBLE NOT NULL;

CREATE INDEX `Product_categoryGroup_idx` ON `Product`(`categoryGroup`);
CREATE INDEX `Product_vendorSource_idx` ON `Product`(`vendorSource`);
CREATE INDEX `Product_sizeUnit_idx` ON `Product`(`sizeUnit`);
CREATE INDEX `Product_packageUnit_idx` ON `Product`(`packageUnit`);

CREATE TABLE `ProductImportBatch` (
  `id` VARCHAR(191) NOT NULL,
  `sourceType` VARCHAR(191) NOT NULL,
  `fileName` VARCHAR(191) NULL,
  `supplier` VARCHAR(191) NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'DRAFT',
  `totalRows` INTEGER NOT NULL DEFAULT 0,
  `importedRows` INTEGER NOT NULL DEFAULT 0,
  `failedRows` INTEGER NOT NULL DEFAULT 0,
  `createdById` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `ProductImportBatch_sourceType_status_createdAt_idx`(`sourceType`, `status`, `createdAt`),
  INDEX `ProductImportBatch_createdById_idx`(`createdById`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ProductImportRow` (
  `id` VARCHAR(191) NOT NULL,
  `batchId` VARCHAR(191) NOT NULL,
  `rowNumber` INTEGER NOT NULL,
  `rawText` TEXT NULL,
  `status` VARCHAR(191) NOT NULL DEFAULT 'READY',
  `error` TEXT NULL,
  `parsed` JSON NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  INDEX `ProductImportRow_batchId_idx`(`batchId`),
  INDEX `ProductImportRow_status_idx`(`status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ProductImportBatch`
  ADD CONSTRAINT `ProductImportBatch_createdById_fkey`
  FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `ProductImportRow`
  ADD CONSTRAINT `ProductImportRow_batchId_fkey`
  FOREIGN KEY (`batchId`) REFERENCES `ProductImportBatch`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
