CREATE TABLE `ProductSearchSynonym` (
  `id` VARCHAR(191) NOT NULL,
  `alias` VARCHAR(191) NOT NULL,
  `normalizedAlias` VARCHAR(191) NOT NULL,
  `canonicalTerm` VARCHAR(191) NOT NULL,
  `normalizedCanonicalTerm` VARCHAR(191) NOT NULL,
  `source` VARCHAR(191) NOT NULL,
  `isEnabled` BOOLEAN NOT NULL DEFAULT true,
  `approvedById` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `ProductSearchSynonym_normalizedAlias_key`(`normalizedAlias`),
  INDEX `ProductSearchSynonym_isEnabled_normalizedCanonicalTerm_idx`(`isEnabled`, `normalizedCanonicalTerm`),
  INDEX `ProductSearchSynonym_approvedById_idx`(`approvedById`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ProductSearchAlias` (
  `id` VARCHAR(191) NOT NULL,
  `productId` VARCHAR(191) NOT NULL,
  `alias` VARCHAR(191) NOT NULL,
  `normalizedAlias` VARCHAR(191) NOT NULL,
  `source` VARCHAR(191) NOT NULL,
  `isEnabled` BOOLEAN NOT NULL DEFAULT true,
  `approvedById` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `ProductSearchAlias_productId_normalizedAlias_key`(`productId`, `normalizedAlias`),
  INDEX `ProductSearchAlias_productId_isEnabled_idx`(`productId`, `isEnabled`),
  INDEX `ProductSearchAlias_approvedById_idx`(`approvedById`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ProductSearchDocument` (
  `productId` VARCHAR(191) NOT NULL,
  `normalizedText` LONGTEXT NOT NULL,
  `normalizerVersion` INTEGER NOT NULL,
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `ProductSearchDocument_normalizerVersion_idx`(`normalizerVersion`),
  PRIMARY KEY (`productId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ProductSearchSynonym`
  ADD CONSTRAINT `ProductSearchSynonym_approvedById_fkey`
  FOREIGN KEY (`approvedById`) REFERENCES `User`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `ProductSearchAlias`
  ADD CONSTRAINT `ProductSearchAlias_productId_fkey`
  FOREIGN KEY (`productId`) REFERENCES `Product`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `ProductSearchAlias`
  ADD CONSTRAINT `ProductSearchAlias_approvedById_fkey`
  FOREIGN KEY (`approvedById`) REFERENCES `User`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `ProductSearchDocument`
  ADD CONSTRAINT `ProductSearchDocument_productId_fkey`
  FOREIGN KEY (`productId`) REFERENCES `Product`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
