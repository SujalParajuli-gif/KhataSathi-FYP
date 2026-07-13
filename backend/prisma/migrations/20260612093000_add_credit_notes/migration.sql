-- CreateTable
CREATE TABLE `CreditNoteSequence` (
    `businessDate` VARCHAR(191) NOT NULL,
    `lastNumber` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`businessDate`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CreditNote` (
    `id` VARCHAR(191) NOT NULL,
    `creditNoteNo` VARCHAR(191) NOT NULL,
    `originalInvoiceId` VARCHAR(191) NOT NULL,
    `replacementInvoiceId` VARCHAR(191) NULL,
    `reason` VARCHAR(191) NULL,
    `originalNetTotal` DOUBLE NOT NULL,
    `originalPaidTotal` DOUBLE NOT NULL,
    `replacementNetTotal` DOUBLE NULL,
    `creditedAmount` DOUBLE NOT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `CreditNote_creditNoteNo_key`(`creditNoteNo`),
    UNIQUE INDEX `CreditNote_replacementInvoiceId_key`(`replacementInvoiceId`),
    INDEX `CreditNote_originalInvoiceId_idx`(`originalInvoiceId`),
    INDEX `CreditNote_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `CreditNote` ADD CONSTRAINT `CreditNote_originalInvoiceId_fkey` FOREIGN KEY (`originalInvoiceId`) REFERENCES `Invoice`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CreditNote` ADD CONSTRAINT `CreditNote_replacementInvoiceId_fkey` FOREIGN KEY (`replacementInvoiceId`) REFERENCES `Invoice`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CreditNote` ADD CONSTRAINT `CreditNote_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
