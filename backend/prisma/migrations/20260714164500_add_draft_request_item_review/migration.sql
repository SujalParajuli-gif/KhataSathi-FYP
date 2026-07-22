-- Add cashier item-level review state for staff billing draft requests.
ALTER TABLE `DraftRequestItem`
  ADD COLUMN `reviewStatus` ENUM('PENDING', 'ACCEPTED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
  ADD COLUMN `acceptedQty` DOUBLE NULL,
  ADD COLUMN `rejectionReason` TEXT NULL,
  ADD COLUMN `reviewedAt` DATETIME(3) NULL;
