CREATE TABLE `PriceOverrideAuthorization` (
    `id` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `cashierId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `customerId` VARCHAR(191) NULL,
    `qty` DOUBLE NOT NULL,
    `originalUnitPrice` DOUBLE NOT NULL,
    `overrideUnitPrice` DOUBLE NOT NULL,
    `overrideReason` TEXT NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `usedInvoiceId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PriceOverrideAuthorization_tokenHash_key`(`tokenHash`),
    INDEX `PriceOverrideAuthorization_cashierId_expiresAt_idx`(`cashierId`, `expiresAt`),
    INDEX `PriceOverrideAuthorization_productId_idx`(`productId`),
    INDEX `PriceOverrideAuthorization_usedAt_idx`(`usedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `PriceOverrideAuthorization`
    ADD CONSTRAINT `PriceOverrideAuthorization_cashierId_fkey`
    FOREIGN KEY (`cashierId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `PriceOverrideAuthorization`
    ADD CONSTRAINT `PriceOverrideAuthorization_productId_fkey`
    FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
