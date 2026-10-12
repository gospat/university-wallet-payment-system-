-- Add isActive column to invoices table.
-- Defaults to true so all existing invoices remain payable.
-- Disabling only prevents NEW payment attempts; it does NOT delete,
-- cancel, reverse, or alter any existing transactions/receipts/GL/settlement.
ALTER TABLE `invoices`
  ADD COLUMN `isActive` BOOLEAN NOT NULL DEFAULT TRUE;
