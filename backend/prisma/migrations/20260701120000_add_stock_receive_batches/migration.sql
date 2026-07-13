-- CreateTable
CREATE TABLE `StockReceiveBatch` (
    `id` VARCHAR(191) NOT NULL,
    `supplierName` VARCHAR(191) NOT NULL,
    `billNumber` VARCHAR(191) NULL,
    `billDate` DATETIME(3) NULL,
    `billAmount` DOUBLE NULL,
    `remarks` TEXT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `StockReceiveBatch_supplierName_idx`(`supplierName`),
    INDEX `StockReceiveBatch_billDate_idx`(`billDate`),
    INDEX `StockReceiveBatch_createdById_idx`(`createdById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
ALTER TABLE `StockTransaction` ADD COLUMN `stockReceiveBatchId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `StockTransaction_stockReceiveBatchId_idx` ON `StockTransaction`(`stockReceiveBatchId`);

-- AddForeignKey
ALTER TABLE `StockReceiveBatch` ADD CONSTRAINT `StockReceiveBatch_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StockTransaction` ADD CONSTRAINT `StockTransaction_stockReceiveBatchId_fkey` FOREIGN KEY (`stockReceiveBatchId`) REFERENCES `StockReceiveBatch`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
