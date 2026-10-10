-- AlterTable
ALTER TABLE `Invoice` ADD COLUMN `returnAdjustment` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `ReturnRequest` ADD COLUMN `settlement` JSON NULL;

-- CreateTable
CREATE TABLE `ReturnOperation` (
    `id` VARCHAR(191) NOT NULL,
    `operationKey` VARCHAR(120) NOT NULL,
    `payloadHash` CHAR(64) NOT NULL,
    `actorId` VARCHAR(191) NOT NULL,
    `returnRequestId` VARCHAR(191) NOT NULL,
    `action` VARCHAR(16) NOT NULL,
    `responseJson` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ReturnOperation_operationKey_key`(`operationKey`),
    INDEX `ReturnOperation_returnRequestId_createdAt_idx`(`returnRequestId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ReturnOperation` ADD CONSTRAINT `ReturnOperation_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReturnOperation` ADD CONSTRAINT `ReturnOperation_returnRequestId_fkey` FOREIGN KEY (`returnRequestId`) REFERENCES `ReturnRequest`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
