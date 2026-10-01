-- AlterTable
ALTER TABLE `fee_assignments` ADD COLUMN `semester` ENUM('FIRST', 'SECOND') NULL,
    ADD COLUMN `session` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `receipts` ADD COLUMN `convenienceFee` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `gatewayFee` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `serviceCharge` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `totalAmount` DECIMAL(15, 2) NOT NULL;

-- AlterTable
ALTER TABLE `transactions` ADD COLUMN `proofOfPaymentReference` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `Counter` (
    `id` VARCHAR(191) NOT NULL DEFAULT 'receipt_number',
    `value` INTEGER NOT NULL DEFAULT 1,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GeneralLedger` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `transactionDate` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `entryType` ENUM('PAYMENT_SUCCESS', 'REFUND_ISSUED', 'CONVENIENCE_FEE_INCOME', 'SERVICE_CHARGE_INCOME', 'GATEWAY_FEE_EXPENSE', 'WALLET_CREDIT') NOT NULL,
    `description` VARCHAR(191) NULL,
    `amount` DECIMAL(15, 2) NOT NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'NGN',
    `account` VARCHAR(191) NOT NULL,
    `counterpartyAccount` VARCHAR(191) NULL,
    `transactionId` INTEGER NULL,
    `receiptId` INTEGER NULL,
    `userId` INTEGER NULL,
    `invoiceId` INTEGER NULL,
    `meta` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `GeneralLedger_transactionDate_entryType_account_idx`(`transactionDate`, `entryType`, `account`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `fee_assignments_targetStudentId_feeId_idx` ON `fee_assignments`(`targetStudentId`, `feeId`);

