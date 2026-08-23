-- Purchase cost is business data that may be unknown when a supplier catalogue
-- is first imported. It must not be fabricated from retail or wholesale prices.
ALTER TABLE `Product`
    MODIFY `ratePerPiece` DOUBLE NULL DEFAULT NULL;

-- A zero purchase cost was previously used as an "unknown" placeholder.
UPDATE `Product`
SET `ratePerPiece` = NULL
WHERE `ratePerPiece` = 0;
