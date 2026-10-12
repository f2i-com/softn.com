CREATE TABLE message_reads (
 date_id INTEGER NOT NULL REFERENCES dates(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 last_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(date_id,user_id)
) STRICT;
CREATE INDEX message_reads_user ON message_reads(user_id,date_id);

-- Keep the original photos table intact so existing images and IDs survive.
-- A separate ordering table also avoids relying on ALTER TABLE privileges.
CREATE TABLE photo_order (
 photo_id INTEGER PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
 position INTEGER NOT NULL CHECK(position>=0)
) STRICT;
INSERT INTO photo_order(photo_id,position) SELECT id,id FROM photos;
