-- Revision 2, additive only. 001-003 are immutable native baseline migrations.
CREATE TABLE intent_preferences (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 intent_feature_enabled INTEGER NOT NULL DEFAULT 0 CHECK(intent_feature_enabled IN (0,1)),
 intent_pair_matching_enabled INTEGER NOT NULL DEFAULT 0 CHECK(intent_pair_matching_enabled IN (0,1)),
 selected_intents TEXT NOT NULL DEFAULT '[]' CHECK(length(selected_intents)<=100),
 intent_preferences_revision INTEGER NOT NULL DEFAULT 0 CHECK(intent_preferences_revision>=0),
 intent_policy_version TEXT,
 intent_adult_confirmed_at INTEGER,
 updated_at INTEGER NOT NULL,
 CHECK(intent_pair_matching_enabled<=intent_feature_enabled),
 CHECK(intent_feature_enabled=1 OR selected_intents='[]')
) STRICT;
CREATE TABLE intent_scopes (
 id TEXT PRIMARY KEY,
 generation TEXT NOT NULL,
 user_a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 user_b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 initiator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 state TEXT NOT NULL CHECK(state IN ('pending','active','declined','expired','revoked','ended')),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
 shared_purpose TEXT CHECK(shared_purpose IN ('dating','casual_dating','friends_with_benefits','hookup')),
 -- A scope-salted digest validates an explicitly supplied, previously shared
 -- report label after the live projection is purged. It never contains a choice.
 shared_purpose_digest TEXT,
 preferences_revision_a INTEGER NOT NULL,
 preferences_revision_b INTEGER NOT NULL,
 policy_version TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 closed_at INTEGER,
 CHECK(user_a<user_b),
 CHECK(initiator_id IN (user_a,user_b)),
 CHECK((state='active' AND shared_purpose IS NOT NULL) OR (state<>'active' AND shared_purpose IS NULL))
) STRICT;
CREATE UNIQUE INDEX intent_scope_one_live_pair ON intent_scopes(user_a,user_b) WHERE state IN ('pending','active');
CREATE INDEX intent_scope_a ON intent_scopes(user_a,created_at,id);
CREATE INDEX intent_scope_b ON intent_scopes(user_b,created_at,id);
CREATE INDEX intent_scope_expiry ON intent_scopes(state,expires_at);
CREATE TABLE intent_scope_choices (
 scope_id TEXT NOT NULL REFERENCES intent_scopes(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 purpose TEXT NOT NULL CHECK(purpose IN ('dating','casual_dating','friends_with_benefits','hookup')),
 preferences_revision INTEGER NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(scope_id,user_id)
) STRICT;
CREATE TABLE intent_report_context (
 report_id INTEGER PRIMARY KEY REFERENCES reports(id) ON DELETE CASCADE,
 scope_id TEXT NOT NULL,
 generation TEXT NOT NULL,
 shared_purpose TEXT CHECK(shared_purpose IN ('dating','casual_dating','friends_with_benefits','hookup')),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX intent_report_expiry ON intent_report_context(expires_at);
ALTER TABLE cafe_invitations ADD COLUMN intent_scope_id TEXT REFERENCES intent_scopes(id);
ALTER TABLE cafe_invitations ADD COLUMN intent_scope_generation TEXT;
ALTER TABLE cafe_rooms ADD COLUMN intent_scope_id TEXT REFERENCES intent_scopes(id);
ALTER TABLE cafe_rooms ADD COLUMN intent_scope_generation TEXT;
ALTER TABLE dates ADD COLUMN intent_scope_id TEXT REFERENCES intent_scopes(id);
ALTER TABLE dates ADD COLUMN intent_scope_generation TEXT;
CREATE INDEX cafe_invitation_intent_scope ON cafe_invitations(intent_scope_id);
CREATE INDEX cafe_room_intent_scope ON cafe_rooms(intent_scope_id);
CREATE INDEX date_intent_scope ON dates(intent_scope_id);
