-- Import originals belong to the review batch and use the same protected
-- storage volume as documents without becoming independent Document records.
ALTER TABLE `ProductImportBatch`
  ADD COLUMN `sourceStoredFileName` VARCHAR(191) NULL,
  ADD COLUMN `sourceStoredPath` VARCHAR(191) NULL,
  ADD COLUMN `sourceMimeType` VARCHAR(191) NULL,
  ADD COLUMN `sourceChecksum` VARCHAR(64) NULL;

-- Flexible source coordinates support spreadsheet rows now and PDF/image
-- regions when an extractor can provide a trustworthy location.
ALTER TABLE `ProductImportRow`
  ADD COLUMN `sourceLocator` JSON NULL;
