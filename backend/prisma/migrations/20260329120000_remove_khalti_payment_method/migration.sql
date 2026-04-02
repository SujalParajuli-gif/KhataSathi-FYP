-- Repo backups and the local database were checked before this change.
-- No rows were found using the removed legacy payment method, so the enum can be reduced safely.
ALTER TABLE `Payment`
  MODIFY `method` ENUM('CASH', 'ESEWA') NOT NULL;
