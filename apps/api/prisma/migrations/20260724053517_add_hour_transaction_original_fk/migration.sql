-- Persist the link from a REVERSAL HourTransaction to the original transaction
-- it undoes. GRANT/DEBIT/MANUAL_* rows have no original, so the column is
-- nullable. A plain (non-FK) index makes "find all reversals of grant X"
-- efficient; the ledger is append-only, so there is intentionally NO
-- self-referential FK and NO cascade — a reversal row must never be deleted
-- when its original is (and originals are never deleted either).
ALTER TABLE `hour_transaction` ADD COLUMN `originalTransactionId` VARCHAR(191) NULL;

CREATE INDEX `hour_transaction_originalTransactionId_idx` ON `hour_transaction`(`originalTransactionId`);
