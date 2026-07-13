-- AlterTable
ALTER TABLE `Invoice`
    ADD COLUMN `parkedLabel` VARCHAR(191) NULL,
    ADD COLUMN `parkedAt` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `Invoice_status_parkedAt_idx` ON `Invoice`(`status`, `parkedAt`);
