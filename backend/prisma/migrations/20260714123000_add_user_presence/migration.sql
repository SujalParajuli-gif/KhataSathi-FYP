-- Track short-lived user presence for active cashier selection.
ALTER TABLE `User`
  ADD COLUMN `lastPresenceAt` DATETIME(3) NULL;

CREATE INDEX `User_role_isActive_lastPresenceAt_idx`
  ON `User`(`role`, `isActive`, `lastPresenceAt`);
