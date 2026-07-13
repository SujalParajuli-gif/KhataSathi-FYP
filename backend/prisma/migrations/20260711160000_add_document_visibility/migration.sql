-- Add document visibility so sensitive files can be restricted by role.
ALTER TABLE `Document`
  ADD COLUMN `visibility` ENUM('ALL_AUTHENTICATED', 'ADMIN_MANAGER', 'ADMIN_ONLY')
  NOT NULL DEFAULT 'ALL_AUTHENTICATED';

CREATE INDEX `Document_visibility_idx` ON `Document`(`visibility`);
