ALTER TABLE `Invoice`
  ADD COLUMN `notes` TEXT NULL;

ALTER TABLE `BusinessSettings`
  ADD COLUMN `returnWindowDays` INTEGER NOT NULL DEFAULT 7,
  ADD COLUMN `parkedBillExpiryHours` INTEGER NOT NULL DEFAULT 8,
  ADD COLUMN `draftRequestExpiryMinutes` INTEGER NOT NULL DEFAULT 30;

CREATE TABLE `CashDrawer` (
  `id` VARCHAR(191) NOT NULL,
  `cashierId` VARCHAR(191) NOT NULL,
  `status` ENUM('OPEN', 'CLOSED') NOT NULL DEFAULT 'OPEN',
  `openedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `closedAt` DATETIME(3) NULL,
  `openingFloat` DOUBLE NOT NULL,
  `cashSalesTotal` DOUBLE NOT NULL DEFAULT 0,
  `cashInTotal` DOUBLE NOT NULL DEFAULT 0,
  `cashOutTotal` DOUBLE NOT NULL DEFAULT 0,
  `expectedTotal` DOUBLE NOT NULL DEFAULT 0,
  `actualTotal` DOUBLE NULL,
  `difference` DOUBLE NULL,
  `note` TEXT NULL,

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `CashDrawerEvent` (
  `id` VARCHAR(191) NOT NULL,
  `drawerId` VARCHAR(191) NOT NULL,
  `type` ENUM('OPEN', 'CASH_IN', 'CASH_OUT', 'CLOSE') NOT NULL,
  `amount` DOUBLE NOT NULL,
  `note` TEXT NULL,
  `createdById` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `CashDrawer_cashierId_status_openedAt_idx`
  ON `CashDrawer`(`cashierId`, `status`, `openedAt`);

CREATE INDEX `CashDrawerEvent_drawerId_createdAt_idx`
  ON `CashDrawerEvent`(`drawerId`, `createdAt`);

CREATE INDEX `CashDrawerEvent_createdById_idx`
  ON `CashDrawerEvent`(`createdById`);

ALTER TABLE `CashDrawer`
  ADD CONSTRAINT `CashDrawer_cashierId_fkey`
  FOREIGN KEY (`cashierId`) REFERENCES `User`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `CashDrawerEvent`
  ADD CONSTRAINT `CashDrawerEvent_drawerId_fkey`
  FOREIGN KEY (`drawerId`) REFERENCES `CashDrawer`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `CashDrawerEvent`
  ADD CONSTRAINT `CashDrawerEvent_createdById_fkey`
  FOREIGN KEY (`createdById`) REFERENCES `User`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;
