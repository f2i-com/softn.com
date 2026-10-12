-- Additive migration. Do not edit the already-installed 001 / 002 migrations.
CREATE TABLE cafe_avatars (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 appearance TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE cafe_rooms (
 id TEXT PRIMARY KEY,
 user_a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 user_b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','ended','closed')),
 created_at INTEGER NOT NULL,
 started_at INTEGER,
 expires_at INTEGER,
 revision INTEGER NOT NULL DEFAULT 0,
 board TEXT NOT NULL DEFAULT '["","","","","","","","",""]',
 turn TEXT NOT NULL DEFAULT 'X' CHECK(turn IN ('X','O')),
 card_index INTEGER NOT NULL DEFAULT 0,
 extensions INTEGER NOT NULL DEFAULT 0 CHECK(extensions BETWEEN 0 AND 3),
 CHECK(user_a<>user_b)
) STRICT;
CREATE INDEX cafe_rooms_expiry ON cafe_rooms(status,expires_at);
CREATE INDEX cafe_rooms_a ON cafe_rooms(user_a,created_at);
CREATE INDEX cafe_rooms_b ON cafe_rooms(user_b,created_at);
CREATE TABLE cafe_invitations (
 id TEXT PRIMARY KEY,
 sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 note TEXT NOT NULL CHECK(length(note)<=160),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','cancelled','expired','ended')),
 created_at INTEGER NOT NULL,
 room_id TEXT REFERENCES cafe_rooms(id) ON DELETE SET NULL,
 CHECK(sender_id<>recipient_id)
) STRICT;
CREATE UNIQUE INDEX cafe_invitation_open_pair ON cafe_invitations(min(sender_id,recipient_id),max(sender_id,recipient_id)) WHERE status IN ('pending','accepted');
CREATE INDEX cafe_invites_sender ON cafe_invitations(sender_id,created_at);
CREATE INDEX cafe_invites_recipient ON cafe_invitations(recipient_id,created_at);
CREATE TABLE cafe_members (
 room_id TEXT NOT NULL REFERENCES cafe_rooms(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 mark TEXT NOT NULL CHECK(mark IN ('X','O')),
 appearance TEXT NOT NULL,
 location TEXT NOT NULL DEFAULT 'table',
 drink TEXT NOT NULL DEFAULT 'latte',
 joined INTEGER NOT NULL DEFAULT 0 CHECK(joined IN (0,1)),
 last_seen INTEGER NOT NULL DEFAULT 0,
 typing_until INTEGER NOT NULL DEFAULT 0,
 vote TEXT NOT NULL DEFAULT '' CHECK(vote IN ('','yes','later','no')),
 extension INTEGER NOT NULL DEFAULT 0 CHECK(extension IN (0,1)),
 PRIMARY KEY(room_id,user_id),
 UNIQUE(room_id,mark)
) STRICT;
CREATE INDEX cafe_members_presence ON cafe_members(user_id,joined,last_seen);
CREATE TABLE cafe_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 room_id TEXT NOT NULL REFERENCES cafe_rooms(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL,
 data TEXT NOT NULL,
 created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX cafe_events_room ON cafe_events(room_id,id);
CREATE INDEX cafe_events_time ON cafe_events(created_at);
CREATE TABLE cafe_requests (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_id TEXT NOT NULL,
 signature TEXT NOT NULL,
 result TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,request_id)
) STRICT;
CREATE INDEX cafe_requests_time ON cafe_requests(created_at);
CREATE TABLE cafe_limits (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 bucket TEXT NOT NULL,
 window_at INTEGER NOT NULL,
 count INTEGER NOT NULL,
 PRIMARY KEY(user_id,bucket)
) STRICT;
CREATE TABLE cafe_maintenance (id INTEGER PRIMARY KEY CHECK(id=1), ran_at INTEGER NOT NULL) STRICT;
INSERT INTO cafe_maintenance VALUES(1,0);
-- Only an explicitly reported, bounded transcript is held beyond live chat retention.
-- This table is never queried by normal participants. Moderator action is audited.
CREATE TABLE cafe_report_context (
 report_id INTEGER PRIMARY KEY REFERENCES reports(id) ON DELETE CASCADE,
 room_id TEXT NOT NULL,
 transcript TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX cafe_report_expiry ON cafe_report_context(expires_at);
