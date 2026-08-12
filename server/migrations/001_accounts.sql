CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL,
    email_normalized text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    deletion_requested_at timestamptz
);

CREATE TABLE login_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email_normalized text NOT NULL,
    token_hash text NOT NULL UNIQUE,
    requested_ip_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_tokens_expiry_idx ON login_tokens(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    csrf_hash text NOT NULL,
    device_label text,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
);
CREATE INDEX sessions_user_idx ON sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx ON sessions(expires_at) WHERE revoked_at IS NULL;
