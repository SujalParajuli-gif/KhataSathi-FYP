-- Add a visible shop-level default for initial stock and a concurrency-safe
-- sequence for SKUs generated when the user leaves SKU blank.
ALTER TABLE `BusinessSettings`
    ADD COLUMN `defaultInitialStock` DOUBLE NOT NULL DEFAULT 30;

CREATE TABLE `ProductSequence` (
    `id` VARCHAR(191) NOT NULL,
    `lastNumber` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
