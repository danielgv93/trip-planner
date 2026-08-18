ALTER TABLE users DROP CONSTRAINT IF EXISTS users_avatar_data_url_length;
ALTER TABLE users ADD CONSTRAINT users_avatar_data_url_length
    CHECK (avatar_data_url IS NULL OR char_length(avatar_data_url) <= 666700);
