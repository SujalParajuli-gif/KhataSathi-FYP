ALTER TABLE `Payment`
ADD COLUMN `transactionUuid` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `Payment_transactionUuid_key` ON `Payment`(`transactionUuid`);
