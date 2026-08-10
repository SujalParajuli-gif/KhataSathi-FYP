CREATE TABLE `ProductSearchQueryLog` (
    `id` VARCHAR(191) NOT NULL,
    `rawQuery` VARCHAR(160) NOT NULL,
    `normalizedQuery` VARCHAR(160) NOT NULL,
    `source` VARCHAR(32) NOT NULL,
    `filters` JSON NULL,
    `filterFingerprint` VARCHAR(64) NOT NULL,
    `resultCount` INTEGER NOT NULL,
    `durationMs` INTEGER NOT NULL,
    `occurrenceCount` INTEGER NOT NULL DEFAULT 1,
    `sessionHash` VARCHAR(64) NULL,
    `actorId` VARCHAR(191) NULL,
    `lastSearchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PSQuery_result_last_idx`(`resultCount`, `lastSearchedAt`),
    INDEX `PSQuery_norm_source_last_idx`(`normalizedQuery`, `source`, `lastSearchedAt`),
    INDEX `PSQuery_session_filter_last_idx`(`sessionHash`, `filterFingerprint`, `lastSearchedAt`),
    INDEX `PSQuery_expires_idx`(`expiresAt`),
    INDEX `PSQuery_actor_idx`(`actorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ProductSearchSelection` (
    `id` VARCHAR(191) NOT NULL,
    `searchLogId` VARCHAR(191) NOT NULL,
    `productId` VARCHAR(191) NOT NULL,
    `actorId` VARCHAR(191) NULL,
    `action` VARCHAR(32) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PSSelection_search_product_action_key`(`searchLogId`, `productId`, `action`),
    INDEX `PSSelection_product_created_idx`(`productId`, `createdAt`),
    INDEX `PSSelection_actor_idx`(`actorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `ProductSearchQueryLog` ADD CONSTRAINT `ProductSearchQueryLog_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `ProductSearchSelection` ADD CONSTRAINT `ProductSearchSelection_searchLogId_fkey` FOREIGN KEY (`searchLogId`) REFERENCES `ProductSearchQueryLog`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ProductSearchSelection` ADD CONSTRAINT `ProductSearchSelection_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ProductSearchSelection` ADD CONSTRAINT `ProductSearchSelection_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
