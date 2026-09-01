ALTER TABLE `ProductImportBatch`
    ADD COLUMN `extractionMeta` JSON NULL,
    ADD COLUMN `priceMapping` JSON NULL;
