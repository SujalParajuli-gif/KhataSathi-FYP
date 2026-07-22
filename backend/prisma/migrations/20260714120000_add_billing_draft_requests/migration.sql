-- Add staff-to-cashier billing draft requests.
CREATE TABLE `DraftRequestSequence` (
  `businessDate` VARCHAR(191) NOT NULL,
  `lastNumber` INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (`businessDate`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `BillingDraftRequest` (
  `id` VARCHAR(191) NOT NULL,
  `requestNo` VARCHAR(191) NOT NULL,
  `status` ENUM('PENDING', 'ACCEPTED', 'MODIFIED', 'REJECTED', 'COMPLETED', 'EXPIRED', 'CANCELLED_BY_STAFF', 'PARTIALLY_ACCEPTED') NOT NULL DEFAULT 'PENDING',
  `customerName` VARCHAR(191) NULL,
  `customerPhone` VARCHAR(191) NULL,
  `customerId` VARCHAR(191) NULL,
  `notes` TEXT NULL,
  `createdById` VARCHAR(191) NOT NULL,
  `assignedCashierId` VARCHAR(191) NULL,
  `acceptedById` VARCHAR(191) NULL,
  `completedInvoiceId` VARCHAR(191) NULL,
  `expiresAt` DATETIME(3) NULL,
  `modifiedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `acceptedAt` DATETIME(3) NULL,

  UNIQUE INDEX `BillingDraftRequest_requestNo_key`(`requestNo`),
  UNIQUE INDEX `BillingDraftRequest_completedInvoiceId_key`(`completedInvoiceId`),
  INDEX `BillingDraftRequest_status_createdAt_idx`(`status`, `createdAt`),
  INDEX `BillingDraftRequest_createdById_createdAt_idx`(`createdById`, `createdAt`),
  INDEX `BillingDraftRequest_assignedCashierId_status_createdAt_idx`(`assignedCashierId`, `status`, `createdAt`),
  INDEX `BillingDraftRequest_acceptedById_acceptedAt_idx`(`acceptedById`, `acceptedAt`),
  INDEX `BillingDraftRequest_expiresAt_idx`(`expiresAt`),
  INDEX `BillingDraftRequest_customerId_idx`(`customerId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `DraftRequestItem` (
  `id` VARCHAR(191) NOT NULL,
  `draftRequestId` VARCHAR(191) NOT NULL,
  `productId` VARCHAR(191) NOT NULL,
  `qty` DOUBLE NOT NULL,
  `note` TEXT NULL,

  INDEX `DraftRequestItem_draftRequestId_idx`(`draftRequestId`),
  INDEX `DraftRequestItem_productId_idx`(`productId`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `BillingDraftRequest`
  ADD CONSTRAINT `BillingDraftRequest_customerId_fkey`
  FOREIGN KEY (`customerId`) REFERENCES `Customer`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `BillingDraftRequest`
  ADD CONSTRAINT `BillingDraftRequest_createdById_fkey`
  FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `BillingDraftRequest`
  ADD CONSTRAINT `BillingDraftRequest_assignedCashierId_fkey`
  FOREIGN KEY (`assignedCashierId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `BillingDraftRequest`
  ADD CONSTRAINT `BillingDraftRequest_acceptedById_fkey`
  FOREIGN KEY (`acceptedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `BillingDraftRequest`
  ADD CONSTRAINT `BillingDraftRequest_completedInvoiceId_fkey`
  FOREIGN KEY (`completedInvoiceId`) REFERENCES `Invoice`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `DraftRequestItem`
  ADD CONSTRAINT `DraftRequestItem_draftRequestId_fkey`
  FOREIGN KEY (`draftRequestId`) REFERENCES `BillingDraftRequest`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `DraftRequestItem`
  ADD CONSTRAINT `DraftRequestItem_productId_fkey`
  FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
