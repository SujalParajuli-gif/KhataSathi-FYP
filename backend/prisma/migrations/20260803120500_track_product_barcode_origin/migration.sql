-- Distinguish manufacturer barcodes from KhataSathi-generated internal codes.
ALTER TABLE `Product`
    ADD COLUMN `barcodeOrigin` VARCHAR(191) NOT NULL DEFAULT 'MANUFACTURER';
