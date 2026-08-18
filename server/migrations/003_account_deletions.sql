CREATE TABLE account_deletions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id_hash text NOT NULL,
    requested_at timestamptz NOT NULL,
    completed_at timestamptz NOT NULL,
    status text NOT NULL CHECK (status IN ('completed', 'failed'))
);
CREATE INDEX account_deletions_requested_idx ON account_deletions(requested_at DESC);
