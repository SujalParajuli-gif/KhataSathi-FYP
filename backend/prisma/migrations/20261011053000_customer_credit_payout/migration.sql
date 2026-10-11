-- CreateTable
CREATE TABLE `CustomerCreditPayout` (
    `id` VARCHAR(191) NOT NULL,
    `sourceInvoiceId` VARCHAR(191) NOT NULL,
    `originalCustomerId` VARCHAR(191) NOT NULL,
    `sourceReturnId` VARCHAR(191) NULL,
    `sourceCorrectionId` VARCHAR(191) NULL,
    `amount` DOUBLE NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `actorId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `payoutEventId` VARCHAR(191) NOT NULL,
    `recoveredAt` DATETIME(3) NULL,
    `recoveredById` VARCHAR(191) NULL,
    `recoveryReason` VARCHAR(500) NULL,
    `recoveryEventId` VARCHAR(191) NULL,

    UNIQUE INDEX `CustomerCreditPayout_payoutEventId_key`(`payoutEventId`),
    UNIQUE INDEX `CustomerCreditPayout_recoveryEventId_key`(`recoveryEventId`),
    INDEX `CustomerCreditPayout_sourceInvoiceId_recoveredAt_idx`(`sourceInvoiceId`, `recoveredAt`),
    INDEX `CustomerCreditPayout_sourceReturnId_recoveredAt_idx`(`sourceReturnId`, `recoveredAt`),
    INDEX `CustomerCreditPayout_sourceCorrectionId_recoveredAt_idx`(`sourceCorrectionId`, `recoveredAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CustomerCreditPayoutOperation` (
    `id` VARCHAR(191) NOT NULL,
    `operationKey` VARCHAR(120) NOT NULL,
    `payloadHash` CHAR(64) NOT NULL,
    `actorId` VARCHAR(191) NOT NULL,
    `payoutId` VARCHAR(191) NOT NULL,
    `action` VARCHAR(16) NOT NULL,
    `responseJson` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `CustomerCreditPayoutOperation_operationKey_key`(`operationKey`),
    INDEX `CustomerCreditPayoutOperation_payoutId_createdAt_idx`(`payoutId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `CustomerCreditPayout` ADD CONSTRAINT `CustomerCreditPayout_sourceInvoiceId_fkey` FOREIGN KEY (`sourceInvoiceId`) REFERENCES `Invoice`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CustomerCreditPayout` ADD CONSTRAINT `CustomerCreditPayout_sourceReturnId_fkey` FOREIGN KEY (`sourceReturnId`) REFERENCES `ReturnRequest`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CustomerCreditPayout` ADD CONSTRAINT `CustomerCreditPayout_sourceCorrectionId_fkey` FOREIGN KEY (`sourceCorrectionId`) REFERENCES `InvoiceCorrectionSettlement`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CustomerCreditPayout` ADD CONSTRAINT `CustomerCreditPayout_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CustomerCreditPayout` ADD CONSTRAINT `CustomerCreditPayout_recoveredById_fkey` FOREIGN KEY (`recoveredById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CustomerCreditPayout` ADD CONSTRAINT `CustomerCreditPayout_payoutEventId_fkey` FOREIGN KEY (`payoutEventId`) REFERENCES `CashDrawerEvent`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CustomerCreditPayout` ADD CONSTRAINT `CustomerCreditPayout_recoveryEventId_fkey` FOREIGN KEY (`recoveryEventId`) REFERENCES `CashDrawerEvent`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CustomerCreditPayoutOperation` ADD CONSTRAINT `CustomerCreditPayoutOperation_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CustomerCreditPayoutOperation` ADD CONSTRAINT `CustomerCreditPayoutOperation_payoutId_fkey` FOREIGN KEY (`payoutId`) REFERENCES `CustomerCreditPayout`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

