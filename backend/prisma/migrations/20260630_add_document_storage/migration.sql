-- CreateEnum
-- Add DocumentType enum values (MySQL handles enums inline in column definitions)

-- CreateTable
CREATE TABLE `Document` (
    `id` VARCHAR(191) NOT NULL,
    `documentType` ENUM('STOCK_BILL', 'PRODUCT_IMPORT', 'RETURN_PROOF', 'PAYMENT_PROOF', 'DISCOUNT_PROOF', 'GENERAL') NOT NULL,
    `fileName` VARCHAR(191) NOT NULL,
    `storedFileName` VARCHAR(191) NOT NULL,
    `storedPath` VARCHAR(191) NOT NULL,
    `mimeType` VARCHAR(191) NOT NULL,
    `fileSize` INTEGER NOT NULL,
    `checksum` VARCHAR(191) NULL,
    `supplierName` VARCHAR(191) NULL,
    `billNumber` VARCHAR(191) NULL,
    `billDate` DATETIME(3) NULL,
    `billAmount` DOUBLE NULL,
    `remarks` TEXT NULL,
    `linkedEntityType` VARCHAR(191) NULL,
    `linkedEntityId` VARCHAR(191) NULL,
    `uploadedById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Document_documentType_createdAt_idx`(`documentType`, `createdAt`),
    INDEX `Document_linkedEntityType_linkedEntityId_idx`(`linkedEntityType`, `linkedEntityId`),
    INDEX `Document_supplierName_idx`(`supplierName`),
    INDEX `Document_billDate_idx`(`billDate`),
    INDEX `Document_uploadedById_idx`(`uploadedById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Document` ADD CONSTRAINT `Document_uploadedById_fkey` FOREIGN KEY (`uploadedById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
