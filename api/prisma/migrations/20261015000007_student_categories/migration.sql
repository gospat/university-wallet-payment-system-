-- ==============================================================
-- 20261015000007_student_categories
-- Dynamic, admin-managed student categories.
--
-- Replaces the hard-coded StudentType enum as the SOURCE OF TRUTH for
-- "what kind of student is this?" (Undergraduate, Postgraduate, Top-Up, …).
-- Admins can add new categories at any time; a category that already has
-- students attached cannot be hard-deleted (FK ON DELETE RESTRICT + a
-- service-level guard that reports the reference count).
--
-- Safety (populated production tables):
--   * new table only — nothing existing is modified except one ADD COLUMN
--     that is NULLable (instant, online-safe, no row rewrite).
--   * students are linked by a new nullable FK; legacy rows are BACKFILLED
--     from the existing users.studentType enum so no student loses its type.
--   * users.studentType keeps working as a compatibility mirror; TOP_UP is
--     APPENDED to that enum (metadata-only in MySQL 8, no row rewrite).
--   * no payment, receipt, settlement, invoice, GL, refund or balance data
--     is touched in any way.
-- ==============================================================

-- CreateTable ---------------------------------------------------------------
CREATE TABLE `student_categories` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(150) NOT NULL,
    `code` VARCHAR(40) NOT NULL,
    `description` VARCHAR(500) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT TRUE,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdById` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `student_categories_name_key`(`name`),
    UNIQUE INDEX `student_categories_code_key`(`code`),
    INDEX `student_categories_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Seed: the canonical set (1:1 with the legacy StudentType enum + TOP_UP) ----
INSERT INTO `student_categories` (`name`, `code`, `description`, `isActive`, `sortOrder`, `createdAt`, `updatedAt`) VALUES
  ('Undergraduate', 'UNDERGRADUATE', 'First-degree students', TRUE, 10, NOW(3), NOW(3)),
  ('Postgraduate', 'POSTGRADUATE', 'Masters, MPhil and PhD students', TRUE, 20, NOW(3), NOW(3)),
  ('Top-Up', 'TOP_UP', 'Top-up / conversion programme students', TRUE, 30, NOW(3), NOW(3)),
  ('Part-Time', 'PART_TIME', 'Part-time programme students', TRUE, 40, NOW(3), NOW(3)),
  ('JUPEB', 'JUPEB', 'JUPEB / A-Level / foundation students', TRUE, 50, NOW(3), NOW(3)),
  ('Other', 'OTHER', 'Any student whose category is not listed above', TRUE, 90, NOW(3), NOW(3));

-- AlterTable: link students to their category (nullable => instant) ----------
ALTER TABLE `users` ADD COLUMN `studentCategoryId` INTEGER NULL;

-- Backfill: preserve every existing student's type as its category -----------
UPDATE `users` u
  JOIN `student_categories` c ON c.`code` = u.`studentType`
SET u.`studentCategoryId` = c.`id`
WHERE u.`studentType` IS NOT NULL;

-- AlterTable: append TOP_UP to the legacy mirror enum (metadata-only) --------
ALTER TABLE `users`
  MODIFY COLUMN `studentType` ENUM('UNDERGRADUATE', 'POSTGRADUATE', 'PART_TIME', 'JUPEB', 'OTHER', 'TOP_UP') NULL;

-- Index + FK (delete guard: a category with students cannot be removed) ------
CREATE INDEX `users_studentCategoryId_idx` ON `users`(`studentCategoryId`);

ALTER TABLE `users`
  ADD CONSTRAINT `users_studentCategoryId_fkey`
  FOREIGN KEY (`studentCategoryId`) REFERENCES `student_categories`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;
