-- AlterTable
ALTER TABLE `Payment` ADD COLUMN `voidedAt` DATETIME(3) NULL,
    ADD COLUMN `voidedById` VARCHAR(191) NULL;

-- AddForeignKey
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_voidedById_fkey` FOREIGN KEY (`voidedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
