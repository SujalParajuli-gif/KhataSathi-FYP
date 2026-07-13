-- Add recoverable deletion state for generated alerts.
ALTER TABLE `UserAlertRead`
  ADD COLUMN `readAt` DATETIME(3) NULL,
  ADD COLUMN `resolvedAt` DATETIME(3) NULL,
  ADD COLUMN `deletedAt` DATETIME(3) NULL,
  ADD COLUMN `purgeAfter` DATETIME(3) NULL;

CREATE INDEX `UserAlertRead_userId_deletedAt_idx` ON `UserAlertRead`(`userId`, `deletedAt`);
CREATE INDEX `UserAlertRead_purgeAfter_idx` ON `UserAlertRead`(`purgeAfter`);

-- Add recoverable deletion state to long-lived upload/import records.
ALTER TABLE `ProductImportBatch`
  ADD COLUMN `deletedAt` DATETIME(3) NULL,
  ADD COLUMN `deletedById` VARCHAR(191) NULL,
  ADD COLUMN `deleteReason` TEXT NULL,
  ADD COLUMN `purgeAfter` DATETIME(3) NULL;

CREATE INDEX `ProductImportBatch_deletedAt_idx` ON `ProductImportBatch`(`deletedAt`);
CREATE INDEX `ProductImportBatch_purgeAfter_idx` ON `ProductImportBatch`(`purgeAfter`);

ALTER TABLE `Document`
  ADD COLUMN `deletedAt` DATETIME(3) NULL,
  ADD COLUMN `deletedById` VARCHAR(191) NULL,
  ADD COLUMN `deleteReason` TEXT NULL,
  ADD COLUMN `purgeAfter` DATETIME(3) NULL;

CREATE INDEX `Document_deletedAt_idx` ON `Document`(`deletedAt`);
CREATE INDEX `Document_purgeAfter_idx` ON `Document`(`purgeAfter`);

-- Create the universal bin registry used to restore or permanently purge records.
CREATE TABLE `SoftDeleteRecord` (
  `id` VARCHAR(191) NOT NULL,
  `entityType` VARCHAR(191) NOT NULL,
  `entityId` VARCHAR(191) NOT NULL,
  `entityLabel` VARCHAR(191) NULL,
  `deletedById` VARCHAR(191) NOT NULL,
  `deleteReason` TEXT NULL,
  `entitySnapshot` JSON NULL,
  `purgeAfter` DATETIME(3) NOT NULL,
  `purgedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `SoftDeleteRecord_entityType_purgeAfter_idx` ON `SoftDeleteRecord`(`entityType`, `purgeAfter`);
CREATE INDEX `SoftDeleteRecord_deletedById_idx` ON `SoftDeleteRecord`(`deletedById`);
CREATE INDEX `SoftDeleteRecord_purgedAt_idx` ON `SoftDeleteRecord`(`purgedAt`);

ALTER TABLE `SoftDeleteRecord`
  ADD CONSTRAINT `SoftDeleteRecord_deletedById_fkey`
  FOREIGN KEY (`deletedById`) REFERENCES `User`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;
