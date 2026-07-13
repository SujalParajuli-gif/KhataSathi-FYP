CREATE TABLE `OverridePinAttempt` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `success` BOOLEAN NOT NULL DEFAULT false,
    `failureReason` VARCHAR(191) NULL,
    `lockedUntil` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `OverridePinAttempt_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `OverridePinAttempt_userId_success_createdAt_idx`(`userId`, `success`, `createdAt`),
    INDEX `OverridePinAttempt_lockedUntil_idx`(`lockedUntil`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `OverridePinAttempt`
    ADD CONSTRAINT `OverridePinAttempt_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
