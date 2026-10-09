-- AlterTable
ALTER TABLE `Customer` ADD COLUMN `address` TEXT NULL,
    ADD COLUMN `panNo` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `Invoice` ADD COLUMN `customerAddressSnapshot` TEXT NULL,
    ADD COLUMN `customerNameSnapshot` VARCHAR(191) NULL,
    ADD COLUMN `customerPanSnapshot` VARCHAR(191) NULL,
    ADD COLUMN `customerSnapshotCapturedAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `BusinessSettings` ADD COLUMN `businessAddress` TEXT NULL,
    ADD COLUMN `businessName` VARCHAR(191) NULL,
    ADD COLUMN `businessPhone` VARCHAR(191) NULL,
    ADD COLUMN `legalName` VARCHAR(191) NULL,
    ADD COLUMN `panNo` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `InvoiceItem` ADD COLUMN `costAtSale` DOUBLE NULL,
    ADD COLUMN `productNameSnapshot` VARCHAR(191) NULL,
    ADD COLUMN `productSkuSnapshot` VARCHAR(191) NULL,
    ADD COLUMN `snapshotCapturedAt` DATETIME(3) NULL;
