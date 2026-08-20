-- Public read-only share links. The token is stored in clear text on purpose:
-- it is a capability URL for the very document that lives in the same row, so
-- hashing it would protect nothing against a database dump while breaking the
-- owner's expectation of copying the same link again later.
CREATE TABLE trip_shares (
    trip_id uuid PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
    token text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);
