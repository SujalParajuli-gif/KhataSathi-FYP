-- CreateTable
CREATE TABLE `PaymentReceivingAccount` (
    `id` VARCHAR(191) NOT NULL,
    `providerLabel` VARCHAR(120) NOT NULL,
    `accountHolder` VARCHAR(120) NOT NULL,
    `accountIdentifier` VARCHAR(120) NULL,
    `settlementMethod` ENUM('CASH', 'ESEWA', 'FONEPAY', 'BANK_TRANSFER') NULL,
    `confirmationMode` ENUM('MANUAL_RECEIPT', 'DISPLAY_ONLY') NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `version` INTEGER NOT NULL DEFAULT 1,
    `creationPayloadHash` CHAR(64) NOT NULL,
    `activeQrAssetId` VARCHAR(191) NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `updatedById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PaymentReceivingAccount_activeQrAssetId_key`(`activeQrAssetId`),
    INDEX `PaymentReceivingAccount_enabled_sortOrder_id_idx`(`enabled`, `sortOrder`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PaymentReceivingQrAsset` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `publicationExpectedVersion` INTEGER NOT NULL,
    `storedPath` VARCHAR(191) NOT NULL,
    `fileName` VARCHAR(191) NOT NULL,
    `thumbnailFileName` VARCHAR(191) NOT NULL,
    `mimeType` VARCHAR(32) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `thumbnailSizeBytes` INTEGER NOT NULL,
    `width` INTEGER NOT NULL,
    `height` INTEGER NOT NULL,
    `checksum` CHAR(64) NOT NULL,
    `sourceChecksum` CHAR(64) NOT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PaymentReceivingQrAsset_accountId_idx`(`accountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
ALTER TABLE `Payment` ADD COLUMN `receivingAccountId` VARCHAR(191) NULL,
    ADD COLUMN `receivingDestinationSnapshot` JSON NULL,
    ADD COLUMN `manualOperationKey` VARCHAR(120) NULL,
    ADD COLUMN `manualPayloadHash` CHAR(64) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `Payment_manualOperationKey_key` ON `Payment`(`manualOperationKey`);

-- CreateIndex
CREATE INDEX `Payment_receivingAccountId_idx` ON `Payment`(`receivingAccountId`);

-- AddForeignKey
ALTER TABLE `PaymentReceivingAccount` ADD CONSTRAINT `PaymentReceivingAccount_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaymentReceivingAccount` ADD CONSTRAINT `PaymentReceivingAccount_updatedById_fkey` FOREIGN KEY (`updatedById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaymentReceivingAccount` ADD CONSTRAINT `PaymentReceivingAccount_activeQrAssetId_fkey` FOREIGN KEY (`activeQrAssetId`) REFERENCES `PaymentReceivingQrAsset`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaymentReceivingQrAsset` ADD CONSTRAINT `PaymentReceivingQrAsset_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `PaymentReceivingAccount`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PaymentReceivingQrAsset` ADD CONSTRAINT `PaymentReceivingQrAsset_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_receivingAccountId_fkey` FOREIGN KEY (`receivingAccountId`) REFERENCES `PaymentReceivingAccount`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
