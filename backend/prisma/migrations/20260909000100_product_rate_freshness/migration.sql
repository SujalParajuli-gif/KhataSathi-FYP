-- Existing rates retain an unknown date; unrelated product edits are not evidence
-- that a supplier rate was checked recently.
ALTER TABLE `Product` ADD COLUMN `rateUpdatedAt` DATETIME(3) NULL;
