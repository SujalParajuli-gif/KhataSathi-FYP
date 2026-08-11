-- Protected, replaceable derivative used by document list views.
ALTER TABLE `Document`
  ADD COLUMN `thumbnailFileName` VARCHAR(191) NULL,
  ADD COLUMN `thumbnailSize` INTEGER NULL;
