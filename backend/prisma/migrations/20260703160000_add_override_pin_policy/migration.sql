ALTER TABLE `BusinessSettings`
  ADD COLUMN `overridePinHash` VARCHAR(191) NULL,
  ADD COLUMN `overridePinUpdatedAt` DATETIME(3) NULL;
