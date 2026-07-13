-- CreateTable
CREATE TABLE `BackupJob` (
    `id` VARCHAR(191) NOT NULL,
    `type` ENUM('BACKUP', 'RESTORE') NOT NULL,
    `status` ENUM('RUNNING', 'SUCCESS', 'FAILED') NOT NULL DEFAULT 'RUNNING',
    `filename` VARCHAR(191) NULL,
    `filepath` VARCHAR(191) NULL,
    `sizeBytes` INTEGER NULL,
    `message` VARCHAR(191) NULL,
    `detail` TEXT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,

    INDEX `BackupJob_type_status_createdAt_idx`(`type`, `status`, `createdAt`),
    INDEX `BackupJob_createdById_idx`(`createdById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `BackupJob` ADD CONSTRAINT `BackupJob_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
