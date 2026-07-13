-- AlterTable
ALTER TABLE `Payment`
  ADD COLUMN `kind` ENUM('CHARGE', 'REFUND') NOT NULL DEFAULT 'CHARGE',
  ADD COLUMN `returnRequestId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `Payment_returnRequestId_idx` ON `Payment`(`returnRequestId`);

-- AddForeignKey
ALTER TABLE `Payment` ADD CONSTRAINT `Payment_returnRequestId_fkey` FOREIGN KEY (`returnRequestId`) REFERENCES `ReturnRequest`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
