-- AlterTable
ALTER TABLE `Invoice` ADD COLUMN `correctionCredit` DOUBLE NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `InvoiceCorrectionSettlement` (
    `id` VARCHAR(191) NOT NULL,
    `sourceInvoiceId` VARCHAR(191) NOT NULL,
    `targetInvoiceId` VARCHAR(191) NULL,
    `originalCustomerId` VARCHAR(191) NULL,
    `action` VARCHAR(16) NOT NULL,
    `receipts` JSON NOT NULL,
    `originalPayable` INTEGER NOT NULL,
    `recordedReceipts` DOUBLE NOT NULL,
    `transferredCredit` DOUBLE NOT NULL,
    `retainedCredit` DOUBLE NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `actorId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `operationKey` VARCHAR(120) NOT NULL,
    `payloadHash` CHAR(64) NOT NULL,
    `responseJson` JSON NOT NULL,

    UNIQUE INDEX `InvoiceCorrectionSettlement_sourceInvoiceId_key`(`sourceInvoiceId`),
    UNIQUE INDEX `InvoiceCorrectionSettlement_targetInvoiceId_key`(`targetInvoiceId`),
    UNIQUE INDEX `InvoiceCorrectionSettlement_operationKey_key`(`operationKey`),
    INDEX `InvoiceCorrectionSettlement_actorId_createdAt_idx`(`actorId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `InvoiceCorrectionSettlement` ADD CONSTRAINT `InvoiceCorrectionSettlement_sourceInvoiceId_fkey` FOREIGN KEY (`sourceInvoiceId`) REFERENCES `Invoice`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `InvoiceCorrectionSettlement` ADD CONSTRAINT `InvoiceCorrectionSettlement_targetInvoiceId_fkey` FOREIGN KEY (`targetInvoiceId`) REFERENCES `Invoice`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `InvoiceCorrectionSettlement` ADD CONSTRAINT `InvoiceCorrectionSettlement_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
