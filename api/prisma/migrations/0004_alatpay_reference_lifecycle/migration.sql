-- Migration 0004: ALATPay reference lifecycle (forward-only, non-destructive)
-- Distinguishes Bells ref / WEMA order ref / init paymentReference / final transaction UUID / checkout URL.
-- Existing columns alatpayReference and alatpaySessionId are preserved for backwards compatibility.

ALTER TABLE `transactions`
  ADD COLUMN `alatpayOrderReference` VARCHAR(255) NULL;

ALTER TABLE `transactions`
  ADD COLUMN `alatpayInitPaymentReference` VARCHAR(255) NULL;

ALTER TABLE `transactions`
  ADD COLUMN `alatpayFinalTransactionId` VARCHAR(255) NULL,
  ADD UNIQUE INDEX `transactions_alatpayFinalTransactionId_key` (`alatpayFinalTransactionId`);

ALTER TABLE `transactions`
  ADD COLUMN `alatpayCheckoutUrl` VARCHAR(1000) NULL;

CREATE INDEX `transactions_alatpayOrderReference_idx`
  ON `transactions` (`alatpayOrderReference`);

CREATE INDEX `transactions_alatpayInitPaymentReference_idx`
  ON `transactions` (`alatpayInitPaymentReference`);
