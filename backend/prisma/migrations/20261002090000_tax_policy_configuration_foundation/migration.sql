-- Add explicit safe tax states. Existing business and product rows remain
-- unknown until an ADMIN verifies the seller mode and each product category.
ALTER TABLE `BusinessSettings`
  ADD COLUMN `taxCalculationMode` ENUM('UNKNOWN', 'NO_VAT', 'VAT_EXCLUSIVE') NOT NULL DEFAULT 'UNKNOWN';

ALTER TABLE `Product`
  ADD COLUMN `taxCategory` ENUM('UNSPECIFIED', 'STANDARD_VAT', 'VAT_EXEMPT') NOT NULL DEFAULT 'UNSPECIFIED';
