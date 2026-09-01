-- Supplier catalogs may contain only the shop's purchase cost. Keeping the
-- selling prices nullable prevents us from inventing retail/wholesale values.
ALTER TABLE `Product`
    ADD COLUMN `sellingPriceStatus` ENUM('PENDING', 'READY') NOT NULL DEFAULT 'READY',
    MODIFY `retailPrice` DOUBLE NULL,
    MODIFY `wholesalePrice` DOUBLE NULL;

CREATE INDEX `Product_sellingPriceStatus_isActive_idx`
    ON `Product`(`sellingPriceStatus`, `isActive`);
