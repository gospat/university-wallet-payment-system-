-- ==============================================================
-- 0002_reports_settlement_reportexport
-- Bursary Reports Module: new enums, tables, and report indexes.
-- Does NOT modify tables from 0000_init_baseline or 0001.
-- ==============================================================

-- Enums -------------------------------------------------------------------
-- MySQL does not have CREATE TYPE; Prisma creates native MySQL ENUM columns.
-- We use ALTER TABLE to set column type and Prisma applies ENUM check via schema.

-- Report indexes on existing tables (GROUP BY / filter acceleration) --------

-- transactions: date-range grouping by gateway + status + user (R1/R2/R3/R5/R10/R17)
CREATE INDEX `transactions_createdAt_status_gateway_idx`
  ON `transactions` (`createdAt`, `status`, `gateway`);

-- transactions: invoice join for fee/bill grouping (R4/R7)
CREATE INDEX `transactions_invoiceId_status_idx`
  ON `transactions` (`invoiceId`, `status`);

-- receipts: date-range grouping (all revenue/collection reports that require Receipt to actually exist)
CREATE INDEX `receipts_paidAt_isVoided_idx`
  ON `receipts` (`paidAt`, `isVoided`);

-- [SKIPPED] receipts: student + paidAt for statement (R6)
--   Index `receipts_studentId_paidAt_idx` on (`studentId`, `paidAt`) already exists
--   in the deployed production schema (from baseline 89e2cdd), column-identical.
--   Skip CREATE to avoid MySQL "Duplicate key name" error on first apply.

-- invoices: session + status for outstanding/debtors (R8) and collection perf (R7)
CREATE INDEX `invoices_session_status_idx`
  ON `invoices` (`session`, `status`);

-- [SKIPPED] invoices: studentId + status for per-student billing (R6/R8)
--   Index `invoices_studentId_status_idx` on (`studentId`, `status`) already exists
--   in the deployed production schema (from baseline 89e2cdd), column-identical.
--   Skip CREATE to avoid MySQL "Duplicate key name" error on first apply.

-- invoices: feeId + session for revenue-by-bill rollup (R4/R7/R9)
CREATE INDEX `invoices_feeId_session_idx`
  ON `invoices` (`feeId`, `session`);

-- GeneralLedger: entryType + transactionDate (R12 GL balance check, R15)
CREATE INDEX `GeneralLedger_entryType_transactionDate_idx`
  ON `GeneralLedger` (`entryType`, `transactionDate`);

CREATE INDEX `GeneralLedger_transactionId_idx`
  ON `GeneralLedger` (`transactionId`);

CREATE INDEX `GeneralLedger_receiptId_idx`
  ON `GeneralLedger` (`receiptId`);

-- [SKIPPED] refunds: status + createdAt (R13)
--   Index `refunds_status_createdAt_idx` on (`status`, `createdAt`) already exists
--   in the deployed production schema (from baseline 89e2cdd), column-identical.
--   Skip CREATE to avoid MySQL "Duplicate key name" error on first apply.

-- webhook events status (R12 exception "local missing at provider" / "provider missing locally")
CREATE INDEX `webhook_events_transactionReference_isProcessed_idx`
  ON `webhook_events` (`transactionReference`, `isProcessed`);

-- ---------------------------------------------------------------
-- CreateTable: settlements (R11 Settlement Report)
-- ---------------------------------------------------------------
CREATE TABLE `settlements` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `settlementRef` VARCHAR(80) NOT NULL,
    `transactionId` INTEGER NOT NULL,
    `gateway` ENUM('PAYSTACK', 'ALATPAY') NOT NULL,
    `paymentAmount` DECIMAL(15, 2) NOT NULL,
    `gatewayFee` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    `convenienceFee` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    `serviceCharge` DECIMAL(15, 2) NOT NULL DEFAULT 0,
    `expectedSettlement` DECIMAL(15, 2) NOT NULL,
    `actualSettlement` DECIMAL(15, 2) NULL,
    `variance` DECIMAL(15, 2) NULL,
    `paymentDate` DATETIME(3) NOT NULL,
    `expectedSettlementDate` DATETIME(3) NULL,
    `settlementDate` DATETIME(3) NULL,
    `bankStatementRef` VARCHAR(120) NULL,
    `status` ENUM('PENDING_SETTLEMENT', 'SETTLED', 'MATCHED', 'PARTIALLY_MATCHED', 'VARIANCE', 'UNMATCHED', 'UNDER_REVIEW') NOT NULL DEFAULT 'PENDING_SETTLEMENT',
    `reconciledById` INTEGER NULL,
    `reconciledAt` DATETIME(3) NULL,
    `notes` VARCHAR(2000) NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`),
    UNIQUE INDEX `settlements_settlementRef_key` (`settlementRef`),
    UNIQUE INDEX `settlements_transactionId_key` (`transactionId`),
    INDEX `settlements_status_createdAt_idx` (`status`, `createdAt`),
    INDEX `settlements_gateway_paymentDate_idx` (`gateway`, `paymentDate`),
    INDEX `settlements_settlementDate_idx` (`settlementDate`),
    INDEX `settlements_transactionId_idx` (`transactionId`),
    CONSTRAINT `settlements_transactionId_fkey` FOREIGN KEY (`transactionId`) REFERENCES `transactions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT `settlements_reconciledById_fkey` FOREIGN KEY (`reconciledById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------
-- CreateTable: scheduled_reports (R20 Scheduled Reports)
-- ---------------------------------------------------------------
CREATE TABLE `scheduled_reports` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(200) NOT NULL,
    `reportType` ENUM('DASHBOARD_SUMMARY', 'DAILY_COLLECTIONS', 'MONTHLY_COLLECTIONS', 'REVENUE_BY_BILL', 'PAYMENT_REGISTER', 'STUDENT_STATEMENT', 'BILL_COLLECTION_PERFORMANCE', 'OUTSTANDING_DEBTORS', 'HIERARCHICAL_REVENUE', 'PAYMENT_GATEWAY', 'SETTLEMENT', 'RECONCILIATION_EXCEPTIONS', 'REFUND', 'CHARGES_FEE_INCOME', 'GENERAL_LEDGER', 'RECEIPT_REGISTER', 'TRANSACTION_STATUS', 'COMPARATIVE', 'EXPORT_CENTRE', 'SCHEDULED', 'AUDIT_TRAIL') NOT NULL,
    `description` VARCHAR(1000) NULL,
    `frequency` ENUM('DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'CUSTOM_CRON') NOT NULL DEFAULT 'MONTHLY',
    `cronExpression` VARCHAR(120) NULL,
    `filters` JSON NULL,
    `format` ENUM('XLSX', 'PDF', 'CSV', 'JSON') NOT NULL DEFAULT 'XLSX',
    `recipients` JSON NULL,
    `subjectLine` VARCHAR(255) NULL,
    `lastRunAt` DATETIME(3) NULL,
    `nextRunAt` DATETIME(3) NULL,
    `createdById` INTEGER NOT NULL,
    `isActive` TINYINT(1) NOT NULL DEFAULT 1,
    `pausedAt` DATETIME(3) NULL,
    `pausedById` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`),
    INDEX `scheduled_reports_isActive_nextRunAt_idx` (`isActive`, `nextRunAt`),
    INDEX `scheduled_reports_reportType_frequency_idx` (`reportType`, `frequency`),
    INDEX `scheduled_reports_createdById_idx` (`createdById`),
    CONSTRAINT `scheduled_reports_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT `scheduled_reports_pausedById_fkey` FOREIGN KEY (`pausedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------
-- CreateTable: report_exports (R21 auditability)
-- ---------------------------------------------------------------
CREATE TABLE `report_exports` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `reportUuid` VARCHAR(64) NOT NULL,
    `reportType` ENUM('DASHBOARD_SUMMARY', 'DAILY_COLLECTIONS', 'MONTHLY_COLLECTIONS', 'REVENUE_BY_BILL', 'PAYMENT_REGISTER', 'STUDENT_STATEMENT', 'BILL_COLLECTION_PERFORMANCE', 'OUTSTANDING_DEBTORS', 'HIERARCHICAL_REVENUE', 'PAYMENT_GATEWAY', 'SETTLEMENT', 'RECONCILIATION_EXCEPTIONS', 'REFUND', 'CHARGES_FEE_INCOME', 'GENERAL_LEDGER', 'RECEIPT_REGISTER', 'TRANSACTION_STATUS', 'COMPARATIVE', 'EXPORT_CENTRE', 'SCHEDULED', 'AUDIT_TRAIL') NOT NULL,
    `reportName` VARCHAR(200) NULL,
    `format` ENUM('XLSX', 'PDF', 'CSV', 'JSON') NOT NULL,
    `status` ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'COMPLETED',
    `generatedById` INTEGER NOT NULL,
    `dateRangeStart` DATETIME(3) NULL,
    `dateRangeEnd` DATETIME(3) NULL,
    `filters` JSON NULL,
    `rowCount` INTEGER NOT NULL DEFAULT 0,
    `fileSizeBytes` BIGINT NULL,
    `fileChecksum` VARCHAR(128) NULL,
    `storagePath` VARCHAR(500) NULL,
    `downloadUrl` VARCHAR(1000) NULL,
    `errorMessage` VARCHAR(2000) NULL,
    `jobId` VARCHAR(128) NULL,
    `scheduledReportId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NULL,

    PRIMARY KEY (`id`),
    UNIQUE INDEX `report_exports_reportUuid_key` (`reportUuid`),
    INDEX `report_exports_reportType_createdAt_idx` (`reportType`, `createdAt`),
    INDEX `report_exports_generatedById_createdAt_idx` (`generatedById`, `createdAt`),
    INDEX `report_exports_status_createdAt_idx` (`status`, `createdAt`),
    INDEX `report_exports_format_createdAt_idx` (`format`, `createdAt`),
    INDEX `report_exports_scheduledReportId_idx` (`scheduledReportId`),
    CONSTRAINT `report_exports_generatedById_fkey` FOREIGN KEY (`generatedById`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT `report_exports_scheduledReportId_fkey` FOREIGN KEY (`scheduledReportId`) REFERENCES `scheduled_reports`(`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
