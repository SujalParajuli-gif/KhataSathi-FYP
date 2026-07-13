ALTER TABLE `Customer`
  ADD COLUMN `createdById` VARCHAR(191) NULL,
  ADD COLUMN `createdByRole` ENUM('ADMIN', 'CASHIER') NULL,
  ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

CREATE INDEX `Customer_createdById_idx` ON `Customer`(`createdById`);

ALTER TABLE `Customer`
  ADD CONSTRAINT `Customer_createdById_fkey`
  FOREIGN KEY (`createdById`) REFERENCES `User`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE `CashierPrivilege` (
  `id` VARCHAR(191) NOT NULL,
  `userId` VARCHAR(191) NOT NULL,
  `canCreateDiscountedCustomer` BOOLEAN NOT NULL DEFAULT false,
  `maxCustomerLoyaltyPercent` DOUBLE NOT NULL DEFAULT 5,
  `maxCustomerWholesalePercent` DOUBLE NOT NULL DEFAULT 10,
  `canRequestCustomerDiscount` BOOLEAN NOT NULL DEFAULT true,
  `canOverrideBillingPrice` BOOLEAN NOT NULL DEFAULT false,
  `canApplyManualDiscount` BOOLEAN NOT NULL DEFAULT false,
  `canVoidPayment` BOOLEAN NOT NULL DEFAULT false,
  `updatedById` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `CashierPrivilege_userId_key`(`userId`),
  INDEX `CashierPrivilege_updatedById_idx`(`updatedById`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `CashierPrivilege`
  ADD CONSTRAINT `CashierPrivilege_userId_fkey`
  FOREIGN KEY (`userId`) REFERENCES `User`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `CashierPrivilege`
  ADD CONSTRAINT `CashierPrivilege_updatedById_fkey`
  FOREIGN KEY (`updatedById`) REFERENCES `User`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
