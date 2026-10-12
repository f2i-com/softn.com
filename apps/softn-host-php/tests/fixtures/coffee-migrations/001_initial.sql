CREATE TABLE users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 phone TEXT NOT NULL UNIQUE,
 first_name TEXT NOT NULL DEFAULT '',
 birth_date TEXT NOT NULL DEFAULT '',
 gender TEXT NOT NULL DEFAULT 'nonbinary' CHECK(gender IN ('woman','man','nonbinary')),
 seeking TEXT NOT NULL DEFAULT 'everyone' CHECK(seeking IN ('woman','man','nonbinary','everyone')),
 min_age INTEGER NOT NULL DEFAULT 18 CHECK(min_age BETWEEN 18 AND 100),
 max_age INTEGER NOT NULL DEFAULT 100 CHECK(max_age BETWEEN 18 AND 100 AND max_age >= min_age),
 region TEXT NOT NULL DEFAULT 'Melbourne',
 suburb TEXT NOT NULL DEFAULT '',
 bio TEXT NOT NULL DEFAULT '',
 profession TEXT NOT NULL DEFAULT '',
 interests TEXT NOT NULL DEFAULT '',
 coffee_order TEXT NOT NULL DEFAULT 'Flat white',
 availability TEXT NOT NULL DEFAULT 'Weekend mornings',
 intent TEXT NOT NULL DEFAULT 'Open to a relationship',
 share_contact INTEGER NOT NULL DEFAULT 0 CHECK(share_contact IN (0,1)),
 profile_complete INTEGER NOT NULL DEFAULT 0 CHECK(profile_complete IN (0,1)),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','suspended','banned')),
 is_admin INTEGER NOT NULL DEFAULT 0 CHECK(is_admin IN (0,1)),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX users_discover ON users(status,profile_complete,region,id);
CREATE TABLE sessions (
 token_hash TEXT PRIMARY KEY,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE otp_challenges (
 id TEXT PRIMARY KEY,
 phone TEXT NOT NULL,
 code_hash TEXT NOT NULL,
 ip_hash TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL CHECK(state IN ('queued','ready','failed','used')),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX otp_phone_time ON otp_challenges(phone,created_at);
CREATE INDEX otp_ip_time ON otp_challenges(ip_hash,created_at);
CREATE TABLE sms_outbox (
 id TEXT PRIMARY KEY REFERENCES otp_challenges(id) ON DELETE CASCADE,
 payload TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 available_at INTEGER NOT NULL,
 lease_until INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE cafes (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 address TEXT NOT NULL,
 region TEXT NOT NULL,
 vibe TEXT NOT NULL DEFAULT '',
 approved INTEGER NOT NULL DEFAULT 0 CHECK(approved IN (0,1)),
 created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
) STRICT;
CREATE TABLE passes (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 PRIMARY KEY(user_id,target_id), CHECK(user_id <> target_id)
) STRICT;
CREATE TABLE blocks (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,target_id), CHECK(user_id <> target_id)
) STRICT;
CREATE INDEX blocks_reverse ON blocks(target_id,user_id);
CREATE TABLE dates (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 proposer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 cafe_name TEXT NOT NULL,
 cafe_address TEXT NOT NULL,
 proposed_date TEXT NOT NULL,
 proposed_time TEXT NOT NULL,
 time_zone TEXT NOT NULL,
 meet_at INTEGER NOT NULL,
 note TEXT NOT NULL DEFAULT '',
 offering_coffee INTEGER NOT NULL DEFAULT 0 CHECK(offering_coffee IN (0,1)),
 status TEXT NOT NULL CHECK(status IN ('pending','countered','accepted','declined','cancelled','completed','expired')),
 version INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 CHECK(requester_id <> recipient_id),
 CHECK(proposer_id IN (requester_id,recipient_id))
) STRICT;
CREATE UNIQUE INDEX dates_one_active_pair ON dates(min(requester_id,recipient_id),max(requester_id,recipient_id))
 WHERE status IN ('pending','countered','accepted');
CREATE INDEX dates_requester ON dates(requester_id,updated_at DESC,id DESC);
CREATE INDEX dates_recipient ON dates(recipient_id,updated_at DESC,id DESC);
CREATE TABLE date_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 date_id INTEGER NOT NULL REFERENCES dates(id) ON DELETE CASCADE,
 actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 action TEXT NOT NULL,
 created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 date_id INTEGER NOT NULL REFERENCES dates(id) ON DELETE CASCADE,
 sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 200),
 created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX messages_date ON messages(date_id,id);
CREATE TABLE checkins (
 date_id INTEGER NOT NULL REFERENCES dates(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('still_going','im_here')),
 created_at INTEGER NOT NULL,
 PRIMARY KEY(date_id,user_id,kind)
) STRICT;
CREATE TABLE votes (
 date_id INTEGER NOT NULL REFERENCES dates(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 vote TEXT NOT NULL CHECK(vote IN ('yes','no')),
 created_at INTEGER NOT NULL,
 PRIMARY KEY(date_id,user_id)
) STRICT;
CREATE TABLE matches (
 date_id INTEGER PRIMARY KEY REFERENCES dates(id) ON DELETE CASCADE,
 created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE reports (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 reported_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 date_id INTEGER REFERENCES dates(id) ON DELETE SET NULL,
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 3 AND 1000),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved')),
 created_at INTEGER NOT NULL,
 resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
 resolved_at INTEGER
) STRICT;
CREATE INDEX reports_pending ON reports(status,id);
CREATE TABLE photos (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 thumbnail TEXT NOT NULL,
 image TEXT NOT NULL,
 created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX photos_user ON photos(user_id,id);
CREATE TABLE idempotency (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 key TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 response TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(user_id,key)
) STRICT;
CREATE INDEX idempotency_created ON idempotency(created_at);
CREATE TABLE moderation_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 target_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 action TEXT NOT NULL,
 created_at INTEGER NOT NULL
) STRICT;
