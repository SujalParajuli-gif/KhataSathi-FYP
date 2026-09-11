CREATE TABLE `CheckoutOperation` (
    `id` VARCHAR(191) NOT NULL,
    `operationKey` VARCHAR(120) NOT NULL,
    `actorId` VARCHAR(191) NOT NULL,
    `payloadHash` CHAR(64) NOT NULL,
    `invoiceId` VARCHAR(191) NULL,
    `responseJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,

    UNIQUE INDEX `CheckoutOperation_operationKey_key`(`operationKey`),
    UNIQUE INDEX `CheckoutOperation_invoiceId_key`(`invoiceId`),
    INDEX `CheckoutOperation_actorId_createdAt_idx`(`actorId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CheckoutOperation`
    ADD CONSTRAINT `CheckoutOperation_actorId_fkey`
    FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `CheckoutOperation`
    ADD CONSTRAINT `CheckoutOperation_invoiceId_fkey`
    FOREIGN KEY (`invoiceId`) REFERENCES `Invoice`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
