ALTER TABLE `Product`
  ADD COLUMN `catalogIdentityHash` CHAR(64) NULL;

CREATE UNIQUE INDEX `Product_catalogIdentityHash_key`
  ON `Product`(`catalogIdentityHash`);
