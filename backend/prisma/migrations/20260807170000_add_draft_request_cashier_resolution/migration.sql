-- Accepted staff requests must have an explicit, audited way to end when a
-- sale does not proceed. The request record is retained as history.
ALTER TABLE `BillingDraftRequest`
  MODIFY `status` ENUM(
    'PENDING',
    'ACCEPTED',
    'MODIFIED',
    'REJECTED',
    'COMPLETED',
    'EXPIRED',
    'CANCELLED_BY_STAFF',
    'CANCELLED_BY_CASHIER',
    'PARTIALLY_ACCEPTED'
  ) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN `cancelledAt` DATETIME(3) NULL,
  ADD COLUMN `cancelledById` VARCHAR(191) NULL,
  ADD COLUMN `cancellationReason` TEXT NULL;

CREATE INDEX `BillingDraftRequest_cancelledById_cancelledAt_idx`
  ON `BillingDraftRequest`(`cancelledById`, `cancelledAt`);

ALTER TABLE `BillingDraftRequest`
  ADD CONSTRAINT `BillingDraftRequest_cancelledById_fkey`
  FOREIGN KEY (`cancelledById`) REFERENCES `User`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
