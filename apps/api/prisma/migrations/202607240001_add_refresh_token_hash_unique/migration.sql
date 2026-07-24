-- Add a unique index on RefreshSession.tokenHash so the `findUnique` lookup by
-- token hash is backed by a DB invariant. Refresh-token hashes are unique by
-- construction (256-bit random token + SHA-256), so this constraint codifies
-- the existing invariant rather than introducing a new one.
CREATE UNIQUE INDEX `refresh_session_tokenHash_key` ON `refresh_session`(`tokenHash`);
