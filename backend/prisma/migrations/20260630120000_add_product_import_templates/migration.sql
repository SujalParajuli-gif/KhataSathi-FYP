CREATE TABLE `ProductImportTemplate` (
  `id` VARCHAR(191) NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `supplier` VARCHAR(191) NOT NULL,
  `sourceType` VARCHAR(191) NOT NULL DEFAULT 'CSV',
  `fieldMap` JSON NOT NULL,
  `defaults` JSON NULL,
  `createdById` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  UNIQUE INDEX `ProductImportTemplate_supplier_sourceType_key`(`supplier`, `sourceType`),
  INDEX `ProductImportTemplate_sourceType_supplier_idx`(`sourceType`, `supplier`),
  INDEX `ProductImportTemplate_createdById_idx`(`createdById`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ProductImportTemplate`
  ADD CONSTRAINT `ProductImportTemplate_createdById_fkey`
  FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
