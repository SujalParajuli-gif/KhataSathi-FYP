-- AlterTable
ALTER TABLE `Document` MODIFY `documentType` ENUM('STOCK_BILL', 'PRODUCT_IMPORT', 'RETURN_PROOF', 'PAYMENT_PROOF', 'DISCOUNT_PROOF', 'GENERAL', 'SALE_BILL', 'PURCHASE_BILL') NOT NULL;

-- CreateTable
CREATE TABLE `Supplier` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `contact` VARCHAR(191) NULL,
    `phone` VARCHAR(191) NULL,
    `panNo` VARCHAR(191) NULL,
    `address` TEXT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Supplier_name_idx`(`name`),
    INDEX `Supplier_phone_idx`(`phone`),
    INDEX `Supplier_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
ALTER TABLE `StockReceiveBatch` ADD COLUMN `supplierId` VARCHAR(191) NULL,
    ADD COLUMN `payable` DECIMAL(20, 2) NULL,
    ADD COLUMN `postedAt` DATETIME(3) NULL,
    ADD COLUMN `operationKey` VARCHAR(120) NULL,
    ADD COLUMN `payloadHash` CHAR(64) NULL;

-- CreateTable
CREATE TABLE `StockReceiveBatchItem` (
    `id` VARCHAR(191) NOT NULL,
    `batchId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `lineOrder` INTEGER NOT NULL,
    `productNameSnapshot` VARCHAR(191) NOT NULL,
    `productSkuSnapshot` VARCHAR(191) NOT NULL,
    `saleUnitSnapshot` VARCHAR(191) NOT NULL,
    `inputUnit` VARCHAR(191) NOT NULL,
    `inputQty` DECIMAL(18, 3) NOT NULL,
    `conversionFactor` DECIMAL(18, 6) NOT NULL,
    `stockQty` DECIMAL(18, 3) NOT NULL,
    `unitAcquisitionCost` DECIMAL(20, 6) NOT NULL,
    `lineAmount` DECIMAL(20, 2) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `StockReceiveBatchItem_batchId_lineOrder_key`(`batchId`, `lineOrder`),
    INDEX `StockReceiveBatchItem_batchId_idx`(`batchId`),
    INDEX `StockReceiveBatchItem_productId_idx`(`productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SupplierPayment` (
    `id` VARCHAR(191) NOT NULL,
    `batchId` VARCHAR(191) NOT NULL,
    `operationKey` VARCHAR(120) NOT NULL,
    `payloadHash` CHAR(64) NOT NULL,
    `amount` DECIMAL(20, 2) NOT NULL,
    `method` VARCHAR(30) NOT NULL,
    `reference` VARCHAR(120) NULL,
    `paidAt` DATETIME(3) NOT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `voidedAt` DATETIME(3) NULL,
    `voidedById` VARCHAR(191) NULL,
    `voidReason` TEXT NULL,

    UNIQUE INDEX `SupplierPayment_operationKey_key`(`operationKey`),
    INDEX `SupplierPayment_batchId_createdAt_idx`(`batchId`, `createdAt`),
    INDEX `SupplierPayment_createdById_idx`(`createdById`),
    INDEX `SupplierPayment_voidedById_idx`(`voidedById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `StockReceiveBatch_operationKey_key` ON `StockReceiveBatch`(`operationKey`);

-- CreateIndex
CREATE INDEX `StockReceiveBatch_supplierId_idx` ON `StockReceiveBatch`(`supplierId`);

-- CreateIndex
CREATE INDEX `StockReceiveBatch_postedAt_idx` ON `StockReceiveBatch`(`postedAt`);

-- AddForeignKey
ALTER TABLE `StockReceiveBatch` ADD CONSTRAINT `StockReceiveBatch_supplierId_fkey` FOREIGN KEY (`supplierId`) REFERENCES `Supplier`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockReceiveBatchItem` ADD CONSTRAINT `StockReceiveBatchItem_batchId_fkey` FOREIGN KEY (`batchId`) REFERENCES `StockReceiveBatch`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockReceiveBatchItem` ADD CONSTRAINT `StockReceiveBatchItem_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupplierPayment` ADD CONSTRAINT `SupplierPayment_batchId_fkey` FOREIGN KEY (`batchId`) REFERENCES `StockReceiveBatch`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupplierPayment` ADD CONSTRAINT `SupplierPayment_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SupplierPayment` ADD CONSTRAINT `SupplierPayment_voidedById_fkey` FOREIGN KEY (`voidedById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
