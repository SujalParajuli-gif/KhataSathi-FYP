-- CreateTable
CREATE TABLE `Expense` (
    `id` VARCHAR(191) NOT NULL,
    `amount` DECIMAL(20, 2) NOT NULL,
    `occurredOn` DATE NOT NULL,
    `category` VARCHAR(80) NOT NULL,
    `description` VARCHAR(500) NOT NULL,
    `status` ENUM('RECORDED', 'VOIDED') NOT NULL DEFAULT 'RECORDED',
    `revision` INTEGER NOT NULL DEFAULT 1,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Expense_occurredOn_id_idx`(`occurredOn`, `id`),
    INDEX `Expense_status_occurredOn_idx`(`status`, `occurredOn`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ExpenseRevision` (
    `id` VARCHAR(191) NOT NULL,
    `expenseId` VARCHAR(191) NOT NULL,
    `revision` INTEGER NOT NULL,
    `action` ENUM('CREATE', 'CORRECT', 'VOID') NOT NULL,
    `amount` DECIMAL(20, 2) NOT NULL,
    `occurredOn` DATE NOT NULL,
    `category` VARCHAR(80) NOT NULL,
    `description` VARCHAR(500) NOT NULL,
    `status` ENUM('RECORDED', 'VOIDED') NOT NULL,
    `reason` VARCHAR(500) NULL,
    `actorId` VARCHAR(191) NOT NULL,
    `operationKey` VARCHAR(120) NOT NULL,
    `payloadHash` CHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ExpenseRevision_operationKey_key`(`operationKey`),
    INDEX `ExpenseRevision_actorId_idx`(`actorId`),
    UNIQUE INDEX `ExpenseRevision_expenseId_revision_key`(`expenseId`, `revision`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Expense` ADD CONSTRAINT `Expense_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ExpenseRevision` ADD CONSTRAINT `ExpenseRevision_expenseId_fkey` FOREIGN KEY (`expenseId`) REFERENCES `Expense`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ExpenseRevision` ADD CONSTRAINT `ExpenseRevision_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

