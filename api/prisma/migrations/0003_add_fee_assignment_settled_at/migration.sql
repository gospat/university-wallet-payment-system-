-- 0003_add_fee_assignment_settled_at
-- Forward-only migration: aligns fee_assignments table with schema.prisma which
-- already defines `settledAt DateTime?`. The column is used by PaymentService
-- when verifying direct-bill payments (marks assignments settled in bulk).
-- No corresponding DDL existed in migrations 0000-0002, causing production
-- Prisma queries that SELECT settledAt (e.g. GET /api/v1/student/fees/catalogue
-- Direct Bills and General Fees Catalogue panels) to throw a missing-column
-- error displayed to students as "Something went very wrong!".
--
-- Safety (populated production table):
--   * nullable (NULL), no default value => instant online-safe ALTER, no row rewrite.
--   * no indexes, no constraints, no foreign keys.
--   * no data movement. Does not modify or drop any existing column/row.

-- AlterTable
ALTER TABLE `fee_assignments` ADD COLUMN `settledAt` DATETIME(3) NULL;
