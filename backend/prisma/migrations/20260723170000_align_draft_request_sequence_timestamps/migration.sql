-- Align DraftRequestSequence with the Prisma model used by sequence upserts.
-- Add the columns as nullable first so this is safe for databases that already
-- contain sequence rows, backfill them, and then enforce the model constraints.
ALTER TABLE `DraftRequestSequence`
    ADD COLUMN `createdAt` DATETIME(3) NULL,
    ADD COLUMN `updatedAt` DATETIME(3) NULL;

UPDATE `DraftRequestSequence`
SET
    `createdAt` = COALESCE(`createdAt`, CURRENT_TIMESTAMP(3)),
    `updatedAt` = COALESCE(`updatedAt`, CURRENT_TIMESTAMP(3));

ALTER TABLE `DraftRequestSequence`
    MODIFY `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    MODIFY `updatedAt` DATETIME(3) NOT NULL;
