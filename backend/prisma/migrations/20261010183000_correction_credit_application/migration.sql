-- Expand the existing owned credit source while preserving all return links.
ALTER TABLE `CustomerCreditApplication`
    MODIFY `sourceReturnId` VARCHAR(191) NULL,
    ADD COLUMN `sourceCorrectionId` VARCHAR(191) NULL;

CREATE INDEX `CustomerCreditApplication_sourceCorrectionId_reversedAt_idx`
    ON `CustomerCreditApplication`(`sourceCorrectionId`, `reversedAt`);

ALTER TABLE `CustomerCreditApplication`
    ADD CONSTRAINT `CustomerCreditApplication_sourceCorrectionId_fkey`
    FOREIGN KEY (`sourceCorrectionId`) REFERENCES `InvoiceCorrectionSettlement`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
