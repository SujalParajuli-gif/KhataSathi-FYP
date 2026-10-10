-- AlterTable
ALTER TABLE `Invoice` ADD COLUMN `creditApplied` DOUBLE NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `CustomerCreditApplication` (
    `id` VARCHAR(191) NOT NULL,
    `sourceInvoiceId` VARCHAR(191) NOT NULL,
    `targetInvoiceId` VARCHAR(191) NOT NULL,
    `sourceReturnId` VARCHAR(191) NOT NULL,
    `originalCustomerId` VARCHAR(191) NOT NULL,
    `amount` DOUBLE NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `actorId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `reversedAt` DATETIME(3) NULL,
    `reversedById` VARCHAR(191) NULL,
    `reversalReason` VARCHAR(500) NULL,

    INDEX `CustomerCreditApplication_sourceInvoiceId_reversedAt_idx`(`sourceInvoiceId`, `reversedAt`),
    INDEX `CustomerCreditApplication_targetInvoiceId_reversedAt_idx`(`targetInvoiceId`, `reversedAt`),
    INDEX `CustomerCreditApplication_sourceReturnId_reversedAt_idx`(`sourceReturnId`, `reversedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CustomerCreditOperation` (
    `id` VARCHAR(191) NOT NULL,
    `operationKey` VARCHAR(120) NOT NULL,
    `payloadHash` CHAR(64) NOT NULL,
    `actorId` VARCHAR(191) NOT NULL,
    `applicationId` VARCHAR(191) NOT NULL,
    `action` VARCHAR(16) NOT NULL,
    `responseJson` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `CustomerCreditOperation_operationKey_key`(`operationKey`),
    INDEX `CustomerCreditOperation_applicationId_createdAt_idx`(`applicationId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `CustomerCreditApplication` ADD CONSTRAINT `CustomerCreditApplication_sourceInvoiceId_fkey` FOREIGN KEY (`sourceInvoiceId`) REFERENCES `Invoice`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CustomerCreditApplication` ADD CONSTRAINT `CustomerCreditApplication_targetInvoiceId_fkey` FOREIGN KEY (`targetInvoiceId`) REFERENCES `Invoice`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CustomerCreditApplication` ADD CONSTRAINT `CustomerCreditApplication_sourceReturnId_fkey` FOREIGN KEY (`sourceReturnId`) REFERENCES `ReturnRequest`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CustomerCreditApplication` ADD CONSTRAINT `CustomerCreditApplication_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CustomerCreditApplication` ADD CONSTRAINT `CustomerCreditApplication_reversedById_fkey` FOREIGN KEY (`reversedById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CustomerCreditOperation` ADD CONSTRAINT `CustomerCreditOperation_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CustomerCreditOperation` ADD CONSTRAINT `CustomerCreditOperation_applicationId_fkey` FOREIGN KEY (`applicationId`) REFERENCES `CustomerCreditApplication`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
