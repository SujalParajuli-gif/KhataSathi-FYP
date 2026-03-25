-- AlterTable
ALTER TABLE `Customer` ADD COLUMN `email` VARCHAR(191) NULL,
    ADD COLUMN `wholesalePercent` DOUBLE NOT NULL DEFAULT 0;
