-- Migration 0004: ALATPay reference lifecycle (forward-only, non-destructive)
-- NOT YET DEPLOYED — corrected to include explicit index declarations matching schema.prisma.
-- Distinguishes Bells ref / WEMA order ref / init paymentReference / final transaction UUID / checkout URL.
-- Existing columns alatpayReference and alatpaySessionId are preserved for backwards compatibility.

ALTER TABLE `transactions`
  ADD COLUMN `alatpayOrderReference` VARCHAR(255) NULL,
  ADD KEY `transactions_alatpayOrderReference_idx` (`alatpayOrderReference`);

ALTER TABLE `transactions`
  ADD COLUMN `alatpayInitPaymentReference` VARCHAR(255) NULL,
  ADD KEY `transactions_alatpayInitPaymentReference_idx` (`alatpayInitPaymentReference`);

ALTER TABLE `transactions`
  ADD COLUMN `alatpayFinalTransactionId` VARCHAR(255) NULL,
  ADD UNIQUE KEY `transactions_alatpayFinalTransactionId_key` (`alatpayFinalTransactionId`);

ALTER TABLE `transactions`
  ADD COLUMN `alatpayCheckoutUrl` VARCHAR(1000) NULL;
