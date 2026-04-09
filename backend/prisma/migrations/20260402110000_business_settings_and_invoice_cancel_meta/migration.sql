CREATE TABLE `BusinessSettings` (
    `id` INTEGER NOT NULL,
    `defaultLowStockThreshold` INTEGER NOT NULL DEFAULT 5,
    `defaultWholesaleQtyThreshold` INTEGER NOT NULL DEFAULT 15,
    `loyaltyDiscountPercent` DOUBLE NOT NULL DEFAULT 2,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `BusinessSettings` (
    `id`,
    `defaultLowStockThreshold`,
    `defaultWholesaleQtyThreshold`,
    `loyaltyDiscountPercent`,
    `updatedAt`
)
VALUES (1, 5, 15, 2, CURRENT_TIMESTAMP(3));

ALTER TABLE `Product`
    ADD COLUMN `usesDefaultWholesaleQtyThreshold` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `usesDefaultLowStockThreshold` BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE `Invoice`
    ADD COLUMN `cancelledById` VARCHAR(191) NULL,
    ADD COLUMN `cancelledAt` DATETIME(3) NULL;

CREATE INDEX `Invoice_cancelledById_idx` ON `Invoice`(`cancelledById`);

ALTER TABLE `Invoice`
    ADD CONSTRAINT `Invoice_cancelledById_fkey`
    FOREIGN KEY (`cancelledById`) REFERENCES `User`(`id`)
    ON DELETE SET NULL
    ON UPDATE CASCADE;
