-- CreateTable
CREATE TABLE `InvoiceSequence` (
    `businessDate` VARCHAR(191) NOT NULL,
    `lastNumber` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`businessDate`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Seed counters from existing invoice numbers so the first post-migration invoice
-- continues from the highest INV-YYYYMMDD-NNNN value already present.
INSERT INTO `InvoiceSequence` (`businessDate`, `lastNumber`, `createdAt`, `updatedAt`)
SELECT
    SUBSTRING(`invoiceNo`, 5, 8) AS `businessDate`,
    MAX(CAST(SUBSTRING(`invoiceNo`, 14) AS UNSIGNED)) AS `lastNumber`,
    CURRENT_TIMESTAMP(3),
    CURRENT_TIMESTAMP(3)
FROM `Invoice`
WHERE `invoiceNo` REGEXP '^INV-[0-9]{8}-[0-9]+$'
GROUP BY SUBSTRING(`invoiceNo`, 5, 8);
