-- Product catalog readiness is distinct from active/inactive and selling-price readiness.
ALTER TABLE `Product`
  ADD COLUMN `availabilityStatus` ENUM('CATALOG_LISTED', 'COMING_SOON') NOT NULL DEFAULT 'CATALOG_LISTED',
  MODIFY COLUMN `packageQuantity` DOUBLE NULL;

CREATE INDEX `Product_availabilityStatus_isActive_idx`
  ON `Product`(`availabilityStatus`, `isActive`);

-- Original file identity supports repeat-upload warnings without making repeats impossible.
ALTER TABLE `ProductImportBatch`
  ADD COLUMN `fileFingerprint` VARCHAR(64) NULL,
  ADD COLUMN `fileSizeBytes` INTEGER NULL,
  ADD COLUMN `repeatedFromBatchId` VARCHAR(191) NULL;

CREATE INDEX `ProductImportBatch_fileFingerprint_createdAt_idx`
  ON `ProductImportBatch`(`fileFingerprint`, `createdAt`);
CREATE INDEX `ProductImportBatch_repeatedFromBatchId_idx`
  ON `ProductImportBatch`(`repeatedFromBatchId`);
ALTER TABLE `ProductImportBatch`
  ADD CONSTRAINT `ProductImportBatch_repeatedFromBatchId_fkey`
  FOREIGN KEY (`repeatedFromBatchId`) REFERENCES `ProductImportBatch`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Extraction, catalog comparison and operator resolution remain separate concerns.
ALTER TABLE `ProductImportRow`
  ADD COLUMN `extracted` JSON NULL,
  ADD COLUMN `comparisonStatus` ENUM(
    'READY_NEW',
    'EXACT_DUPLICATE',
    'MATCHED_WITH_CHANGES',
    'IDENTIFIER_CONFLICT',
    'IN_FILE_DUPLICATE',
    'NEEDS_REVIEW',
    'FAILED'
  ) NOT NULL DEFAULT 'NEEDS_REVIEW',
  ADD COLUMN `matchedProductId` VARCHAR(191) NULL,
  ADD COLUMN `changeSet` JSON NULL,
  ADD COLUMN `resolution` ENUM('CREATE_NEW', 'UPDATE_MATCHED', 'KEEP_EXISTING', 'IGNORE') NULL;

CREATE INDEX `ProductImportRow_comparisonStatus_idx`
  ON `ProductImportRow`(`comparisonStatus`);
CREATE INDEX `ProductImportRow_matchedProductId_idx`
  ON `ProductImportRow`(`matchedProductId`);
ALTER TABLE `ProductImportRow`
  ADD CONSTRAINT `ProductImportRow_matchedProductId_fkey`
  FOREIGN KEY (`matchedProductId`) REFERENCES `Product`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

-- One token represents one logical commit request. Replays return its stored result.
CREATE TABLE `ProductImportCommit` (
  `id` VARCHAR(191) NOT NULL,
  `batchId` VARCHAR(191) NOT NULL,
  `token` VARCHAR(64) NOT NULL,
  `status` ENUM('IN_PROGRESS', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'IN_PROGRESS',
  `requestHash` VARCHAR(64) NOT NULL,
  `result` JSON NULL,
  `error` TEXT NULL,
  `actorId` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `completedAt` DATETIME(3) NULL,

  UNIQUE INDEX `ProductImportCommit_batchId_token_key`(`batchId`, `token`),
  INDEX `ProductImportCommit_actorId_createdAt_idx`(`actorId`, `createdAt`),
  INDEX `ProductImportCommit_status_createdAt_idx`(`status`, `createdAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `ProductImportCommit_batchId_fkey`
    FOREIGN KEY (`batchId`) REFERENCES `ProductImportBatch`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `ProductImportCommit_actorId_fkey`
    FOREIGN KEY (`actorId`) REFERENCES `User`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
