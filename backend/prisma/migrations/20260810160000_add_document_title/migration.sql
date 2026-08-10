ALTER TABLE `Document`
  ADD COLUMN `title` VARCHAR(191) NULL;

CREATE INDEX `Document_title_idx` ON `Document`(`title`);
