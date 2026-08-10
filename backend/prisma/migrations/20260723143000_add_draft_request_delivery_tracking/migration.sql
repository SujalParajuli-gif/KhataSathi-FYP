-- Track whether an assigned cashier has seen a queued staff request and
-- whether it was originally queued while that cashier was offline.
ALTER TABLE `BillingDraftRequest`
  ADD COLUMN `firstViewedAt` DATETIME(3) NULL,
  ADD COLUMN `queuedOfflineAt` DATETIME(3) NULL;

CREATE INDEX `BillingDraftRequest_assignedCashierId_firstViewedAt_status_idx`
  ON `BillingDraftRequest`(`assignedCashierId`, `firstViewedAt`, `status`);
