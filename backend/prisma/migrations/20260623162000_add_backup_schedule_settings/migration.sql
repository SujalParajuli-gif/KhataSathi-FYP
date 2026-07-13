-- CreateTable
CREATE TABLE `BackupSettings` (
    `id` INTEGER NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `frequency` ENUM('DAILY', 'WEEKLY') NOT NULL DEFAULT 'DAILY',
    `timeOfDay` VARCHAR(191) NOT NULL DEFAULT '02:00',
    `dayOfWeek` INTEGER NULL,
    `lastRunAt` DATETIME(3) NULL,
    `updatedById` VARCHAR(191) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
