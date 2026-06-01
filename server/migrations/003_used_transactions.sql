-- Migration: Store all successfully verified transaction hashes to prevent replay attacks
-- This table ensures that each transaction hash can only be used once for pixel redemption

CREATE TABLE IF NOT EXISTS used_transactions (
    tx_hash TEXT PRIMARY KEY,
    chain_id INTEGER NOT NULL,
    verified_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for efficient lookups by transaction hash
CREATE INDEX IF NOT EXISTS idx_used_transactions_tx_hash ON used_transactions (tx_hash);

-- Index for cleanup operations (delete old entries after a certain period if needed)
CREATE INDEX IF NOT EXISTS idx_used_transactions_verified_at ON used_transactions (verified_at);
