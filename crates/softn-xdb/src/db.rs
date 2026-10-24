//! XDB Database Module
//! Handles SQLite persistence and Yrs (CRDT) synchronization logic

use rusqlite::{
    backup::{Backup, StepResult},
    params, Connection, DatabaseName, OpenFlags, OptionalExtension,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use thiserror::Error;
use uuid::Uuid;
use yrs::updates::decoder::Decode;
use yrs::updates::encoder::Encode;
use yrs::{Doc, Map, Observable, ReadTxn, Transact, Update, WriteTxn};

#[derive(Error, Debug)]
pub enum DbError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("CRDT error: {0}")]
    Crdt(String),
    #[error("Record not found: {0}")]
    NotFound(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Invalid database operation: {0}")]
    InvalidOperation(String),
}

pub type DbResult<T> = Result<T, DbError>;

/// The largest reset epoch kept: what a peer's reset may name, and what this node's own
/// resets of a collection may reach. Past it the next epoch would run past SQLite's integer
/// (stored as a negative number, read back as 0) and past what the page reads exactly as a
/// number. One reset at a time, no collection comes near it.
const MAX_EPOCH: u64 = 1 << 53;

/// How far past this node's epoch of a collection a peer's reset may name. Honest peers'
/// epochs differ by the resets one of them missed while away.
const MAX_EPOCH_STEP: u64 = 1 << 20;

/// An epoch about to be kept, refused past MAX_EPOCH rather than wrapped.
fn check_epoch(epoch: u64) -> DbResult<()> {
    if epoch > MAX_EPOCH {
        return Err(DbError::InvalidOperation(format!("A reset epoch of {epoch} is past the largest kept ({MAX_EPOCH})")));
    }
    Ok(())
}

/// How far ahead of this clock a record's stamp may be for an edit to follow it: as far
/// ahead as a peer-to-peer room takes a stamp (STAMP_AHEAD_LIMIT_MS in the page's
/// packages/@softn/core/src/runtime/xdb-service.ts).
const STAMP_AHEAD_LIMIT_MS: i64 = 24 * 60 * 60 * 1000;

/// The stamp of an edit made now to a record stamped `previous`, as the page stamps one
/// (xdb-service.ts `editStamp`): later than it, following a stamp up to a day ahead of this
/// clock by a millisecond, else this clock's time. `asked` is the stamp the page gave the
/// edit, which is after a sync room's copy of the record as well, a copy only the page
/// knows of; it is taken when it is later still and no further ahead than that.
///
/// An edit was stamped with this clock alone. The newer stamp wins where records meet, so
/// on a computer whose clock ran behind the device that last wrote a record, an edit lost
/// to the copy it edited, and the page's answer from here undid the stamp it had chosen.
fn edit_stamp(previous: &str, asked: Option<&str>) -> String {
    let now = chrono::Utc::now();
    let limit = now + chrono::Duration::milliseconds(STAMP_AHEAD_LIMIT_MS + 1);
    let time = |text: &str| chrono::DateTime::parse_from_rfc3339(text).ok().map(|at| at.with_timezone(&chrono::Utc));
    let mut at = now;
    if let Some(previous) = time(previous) {
        if previous >= at && previous < limit {
            at = previous + chrono::Duration::milliseconds(1);
        }
    }
    if let Some(asked) = asked.and_then(time) {
        if asked > at && asked <= limit {
            at = asked;
        }
    }
    at.to_rfc3339()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Record {
    pub id: String,
    pub collection: String,
    pub data: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
    pub deleted: bool,
}

/// One collection's contribution to a bulk import (audit SN-01).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionImport {
    pub collection: String,
    /// Replace: every existing record NOT in `records` is tombstoned (a
    /// replicated deletion), then the incoming records are upserted. Merge
    /// (false): incoming records are upserted over what exists.
    #[serde(default)]
    pub replace: bool,
    pub records: Vec<Record>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CollectionImportResult {
    pub collection: String,
    pub replaced: bool,
    pub imported: u64,
    pub tombstoned: u64,
    pub epoch: u64,
}

/// What a committed bulk import did. Only returned after the transaction
/// committed, so a caller holding it holds a durable-completion signal.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ImportSummary {
    pub collections: Vec<CollectionImportResult>,
    pub imported: u64,
    pub tombstoned: u64,
}

/// Deltas produced by a committed import: (collection, epoch, update bytes).
/// Publish them only after the commit that produced them.
pub type CommittedDeltas = Vec<(String, u64, Vec<u8>)>;

/// Outcome of applying a peer's update against the local reset epoch (audit XD-03).
#[derive(Debug)]
pub enum RemoteApplyOutcome {
    /// Applied; the records the update touched.
    Applied(Vec<Record>),
    /// The sender is behind an acknowledged reset. Nothing was applied.
    StaleEpoch { local: u64, remote: u64 },
    /// The sender knows a newer reset than this node. Nothing was applied;
    /// adopt it with `apply_remote_reset` and retry.
    MissingReset { local: u64, remote: u64 },
}

/// The XDB Database - wraps SQLite with CRDT sync capabilities
pub struct XdbDatabase {
    conn: Connection,
    docs: HashMap<String, Doc>,
    db_path: PathBuf,
    /// Set while `with_batch` runs.
    batch: Option<Batch>,
}

/// The documents a batch has written to and not yet saved (`with_batch`).
///
/// For each collection, the updates its document has taken since its
/// snapshot was last written. They are kept, not just the collection's name,
/// because a write that fails inside the batch rolls back to its savepoint
/// and drops every cached document: the next use of one reloads the
/// snapshot on disk, which is behind by exactly these.
#[derive(Default)]
struct Batch {
    pending: HashMap<String, Vec<Vec<u8>>>,
}

impl Batch {
    /// How much of `pending` there is now, to return to after a rollback.
    fn marks(&self) -> HashMap<String, usize> {
        self.pending
            .iter()
            .map(|(collection, updates)| (collection.clone(), updates.len()))
            .collect()
    }
}

fn record_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Record> {
    let raw_data: String = row.get(2)?;
    let data = serde_json::from_str(&raw_data).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(Record {
        id: row.get(0)?,
        collection: row.get(1)?,
        data,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        deleted: row.get::<_, i32>(5)? != 0,
    })
}

impl XdbDatabase {
    /// Create or open an XDB database at the given path
    pub fn open(path: PathBuf) -> DbResult<Self> {
        let conn = Connection::open(&path)?;

        // Enable WAL mode for better concurrent read performance.
        // WAL allows readers to proceed without blocking on writers,
        // when other connections read the same database.
        conn.pragma_update(None, "journal_mode", "WAL")?;

        Self::initialize_schema(&conn)?;

        Ok(Self {
            conn,
            docs: HashMap::new(),
            db_path: path,
            batch: None,
        })
    }

    /// Create or migrate the schema on a connection. Every statement is
    /// idempotent, so this doubles as the forward migration for a snapshot
    /// taken by an older revision (R2-XD-03: a restored legacy file must get
    /// the tables this revision relies on BEFORE it becomes the live database).
    fn initialize_schema(conn: &Connection) -> DbResult<()> {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS records (
                id TEXT PRIMARY KEY,
                collection TEXT NOT NULL,
                data TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted INTEGER DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_collection ON records(collection);
            CREATE INDEX IF NOT EXISTS idx_deleted ON records(deleted);

            CREATE TABLE IF NOT EXISTS crdt_state (
                collection TEXT PRIMARY KEY,
                state_vector BLOB NOT NULL,
                doc_state BLOB NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sync_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                peer_id TEXT NOT NULL,
                collection TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                update_data BLOB NOT NULL
            );

            -- Reset epochs (audit XD-03): an administrative reset of a shared
            -- collection bumps its epoch; updates from peers on an older epoch
            -- are rejected instead of resurrecting pre-reset records.
            CREATE TABLE IF NOT EXISTS collection_epochs (
                collection TEXT PRIMARY KEY,
                epoch INTEGER NOT NULL,
                origin TEXT,
                reset_at TEXT NOT NULL
            );
            "#,
        )?;
        Ok(())
    }

    /// Tables this revision requires; a snapshot lacking any of them is a
    /// legacy snapshot that `replace_from_file` migrates in staging first.
    const REQUIRED_TABLES: [&'static str; 4] =
        ["records", "crdt_state", "sync_log", "collection_epochs"];

    fn table_names(conn: &Connection) -> DbResult<Vec<String>> {
        let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?;
        let names = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(names)
    }

    /// Get the database file path
    pub fn path(&self) -> &PathBuf {
        &self.db_path
    }

    /// Reload the database from disk (e.g. after an import replaced the file).
    /// Reopens the SQLite connection and clears all cached CRDT docs.
    pub fn reload(&mut self) -> DbResult<()> {
        self.require_autocommit("reload")?;
        *self = Self::open(self.db_path.clone())?;
        Ok(())
    }

    /// Restore a validated XDB snapshot, including committed WAL contents.
    ///
    /// The source file is never modified. It is first copied into a private
    /// STAGING database next to the live file; the staging copy is migrated to
    /// this revision's schema (idempotent `initialize_schema`) and validated
    /// (core tables, every record row, every saved CRDT document); only then is
    /// it copied over the live connection with SQLite's backup API, which keeps
    /// the current database intact if any step fails (R2-XD-03). Cached CRDT
    /// documents are dropped so the next access reads the restored state.
    pub fn replace_from_file(&mut self, source_path: &PathBuf) -> DbResult<()> {
        self.replace_from_file_prepared(source_path, |_| Ok(()))
    }

    /// `replace_from_file` with one extra step: `prepare` runs against the
    /// validated STAGING copy before it is activated, so whatever it writes
    /// (reset epochs, R3-XD-02) becomes live in the same backup step as the
    /// restored data. An error from `prepare` leaves the live database untouched.
    pub(crate) fn replace_from_file_prepared(
        &mut self,
        source_path: &PathBuf,
        prepare: impl FnOnce(&Connection) -> DbResult<()>,
    ) -> DbResult<()> {
        self.require_autocommit("import")?;
        self.require_distinct_path(source_path)?;
        let staging_path = self
            .db_path
            .with_extension(format!("restore-staging-{}", Uuid::new_v4().simple()));
        let result = self.replace_from_file_staged(source_path, &staging_path, prepare);
        // The staging copy is a temporary; remove it (and its journals) whatever happened.
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let mut path = staging_path.clone().into_os_string();
            path.push(suffix);
            let _ = std::fs::remove_file(path);
        }
        result
    }

    fn replace_from_file_staged(
        &mut self,
        source_path: &PathBuf,
        staging_path: &PathBuf,
        prepare: impl FnOnce(&Connection) -> DbResult<()>,
    ) -> DbResult<()> {
        let source = Connection::open_with_flags(source_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        // Hold one read snapshot through validation and copy.
        source.execute_batch("BEGIN")?;
        let integrity: String = source.query_row("PRAGMA quick_check(1)", [], |row| row.get(0))?;
        if integrity != "ok" {
            return Err(DbError::InvalidOperation(format!(
                "Invalid SQLite snapshot: {integrity}"
            )));
        }
        // The core tables every supported snapshot revision has; newer tables
        // (collection_epochs) are added by the staging migration below.
        for table in ["records", "crdt_state", "sync_log"] {
            if !Self::table_names(&source)?.iter().any(|t| t == table) {
                return Err(DbError::InvalidOperation(format!(
                    "Unsupported snapshot: missing table '{table}'"
                )));
            }
        }

        // 1. Copy the immutable source into a private staging database.
        let mut staging = Connection::open(staging_path)?;
        {
            let backup = Backup::new(&source, &mut staging)?;
            if backup.step(-1)? != StepResult::Done {
                return Err(DbError::InvalidOperation(
                    "Snapshot is busy; try importing again".into(),
                ));
            }
        }
        drop(source);

        // 2. Migrate the staging copy forward and validate it completely.
        Self::initialize_schema(&staging)?;
        let tables = Self::table_names(&staging)?;
        for table in Self::REQUIRED_TABLES {
            if !tables.iter().any(|t| t == table) {
                return Err(DbError::InvalidOperation(format!(
                    "Snapshot migration did not produce table '{table}'"
                )));
            }
        }
        staging.prepare(
            "SELECT id, collection, data, created_at, updated_at, deleted FROM records LIMIT 0",
        )?;
        staging.prepare("SELECT collection, state_vector, doc_state FROM crdt_state LIMIT 0")?;
        staging.prepare(
            "SELECT id, peer_id, collection, timestamp, update_data FROM sync_log LIMIT 0",
        )?;
        staging.prepare("SELECT collection, epoch, origin, reset_at FROM collection_epochs LIMIT 0")?;
        {
            let mut records = staging
                .prepare("SELECT id, collection, data, created_at, updated_at, deleted FROM records")?;
            for record in records.query_map([], record_from_row)? {
                record?;
            }
            let mut states =
                staging.prepare("SELECT collection, state_vector, doc_state FROM crdt_state")?;
            let snapshots = states.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                ))
            })?;
            for snapshot in snapshots {
                let (collection, state_vector, doc_state) = snapshot?;
                yrs::StateVector::decode_v1(&state_vector)
                    .map_err(|e| DbError::Crdt(e.to_string()))?;
                let update =
                    Update::decode_v1(&doc_state).map_err(|e| DbError::Crdt(e.to_string()))?;
                let doc = Doc::new();
                doc.transact_mut()
                    .apply_update(update)
                    .map_err(|e| DbError::Crdt(e.to_string()))?;
                Self::records_from_doc(&collection, &doc)?;
            }
        }
        // A snapshot's epochs become this database's. One past MAX_EPOCH (from a build
        // before the cap, or a made file) is brought down to it rather than refused: a
        // refused snapshot left a journaled restore that could neither complete nor roll
        // back. (A negative one, which a wrap under that build stored, already reads as 0.)
        staging.execute("UPDATE collection_epochs SET epoch = ?1 WHERE epoch > ?1", params![MAX_EPOCH as i64])?;

        // 3. The caller's preparation (reset epochs for an authoritative
        //    restore) is written into the staging copy and re-validated, so
        //    data and metadata activate together (R3-XD-02).
        prepare(&staging)?;
        staging.prepare("SELECT collection, epoch, origin, reset_at FROM collection_epochs LIMIT 0")?;

        // 4. Only a migrated, validated copy replaces the live database.
        {
            let backup = Backup::new(&staging, &mut self.conn)?;
            if backup.step(-1)? != StepResult::Done {
                return Err(DbError::InvalidOperation(
                    "Database is busy; try importing again".into(),
                ));
            }
        }
        drop(staging);
        self.docs.clear();
        Ok(())
    }

    /// Every collection this database knows about: those with records AND
    /// those that only have an epoch row (reset to empty, or absent from a
    /// restored snapshot but still needing authority) — R2-XD-02.
    pub fn catalog(&self) -> DbResult<HashMap<String, u64>> {
        Self::catalog_of(&self.conn)
    }

    /// `catalog` for any connection, including a not-yet-migrated snapshot
    /// (whose missing epoch table means "every collection at epoch 0").
    fn catalog_of(conn: &Connection) -> DbResult<HashMap<String, u64>> {
        let mut catalog: HashMap<String, u64> = HashMap::new();
        let mut names = conn.prepare("SELECT DISTINCT collection FROM records")?;
        for name in names.query_map([], |row| row.get::<_, String>(0))? {
            catalog.insert(name?, 0);
        }
        if Self::table_names(conn)?.iter().any(|t| t == "collection_epochs") {
            let mut stmt = conn.prepare("SELECT collection, epoch FROM collection_epochs")?;
            for row in stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))? {
                let (collection, epoch) = row?;
                catalog.insert(collection, epoch.max(0) as u64);
            }
        }
        Ok(catalog)
    }

    /// The reset plan an authoritative restore of `source_path` WILL commit,
    /// computed without touching the live database (R3-XD-02): the host
    /// journals it (together with the pre-restore catalog and backup) before
    /// any byte is replaced. `plan` is the epoch per collection over the union
    /// of both catalogs; `prior` is the live catalog it was computed against.
    pub fn plan_authoritative_restore(
        &self,
        source_path: &PathBuf,
    ) -> DbResult<AuthoritativeRestorePlan> {
        self.require_distinct_path(source_path)?;
        let source = Connection::open_with_flags(source_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let snapshot = Self::catalog_of(&source)?;
        drop(source);
        let before = self.catalog()?;
        let plan = Self::reset_plan_over(&before, &snapshot);
        // Refused now, before the host journals the plan, rather than in the staging step,
        // which left synchronization paused until the person chose to roll back.
        for (_, epoch) in &plan {
            check_epoch(*epoch)?;
        }
        Ok(AuthoritativeRestorePlan {
            plan,
            prior: {
                let mut prior: Vec<(String, u64)> = before.into_iter().collect();
                prior.sort();
                prior
            },
        })
    }

    fn reset_plan_over(live: &HashMap<String, u64>, snapshot: &HashMap<String, u64>) -> Vec<(String, u64)> {
        let mut union: Vec<String> = live.keys().chain(snapshot.keys()).cloned().collect();
        union.sort();
        union.dedup();
        union
            .into_iter()
            .map(|collection| {
                let l = live.get(&collection).copied().unwrap_or(0);
                let s = snapshot.get(&collection).copied().unwrap_or(0);
                (collection, l.max(s) + 1)
            })
            .collect()
    }

    /// Restore a snapshot as the AUTHORITATIVE shared state (replace scope,
    /// R2-XD-02). The reset plan is computed over the union of the pre-restore
    /// catalog and the restored one: every collection's new epoch exceeds both
    /// its live pre-restore epoch and the snapshot's, so an older backup can
    /// never announce a generation below what peers already hold; collections
    /// intentionally absent from the snapshot get a reset epoch too, so peers
    /// clear them instead of rediscovering them. The restore and the epoch
    /// plan commit as one recoverable step: the caller persists the returned
    /// plan before publishing it, and re-applies it after an interruption.
    pub fn replace_from_file_authoritative(
        &mut self,
        source_path: &PathBuf,
        origin: &str,
    ) -> DbResult<Vec<(String, u64)>> {
        let planned = self.plan_authoritative_restore(source_path)?;
        self.apply_authoritative_restore(source_path, &planned.plan, origin)?;
        Ok(planned.plan)
    }

    /// Activate `source_path` together with a journaled reset `plan` in ONE
    /// step (R3-XD-02): the plan's epochs are written into the validated
    /// staging copy, which then replaces the live database with a single
    /// backup step. Data and reset metadata can never be observed apart. The
    /// plan is checked against the CURRENT live and snapshot catalogs first:
    /// an epoch that no longer exceeds both (the live database moved on after
    /// the plan was journaled) is refused, and the live database is untouched.
    pub fn apply_authoritative_restore(
        &mut self,
        source_path: &PathBuf,
        plan: &[(String, u64)],
        origin: &str,
    ) -> DbResult<()> {
        self.apply_authoritative_restore_with(source_path, plan, origin, |_| Ok(()))
    }

    pub(crate) fn apply_authoritative_restore_with(
        &mut self,
        source_path: &PathBuf,
        plan: &[(String, u64)],
        origin: &str,
        before_activate: impl FnOnce(&Connection) -> DbResult<()>,
    ) -> DbResult<()> {
        let planned = self.plan_authoritative_restore(source_path)?;
        let expected: HashMap<&str, u64> = plan.iter().map(|(c, e)| (c.as_str(), *e)).collect();
        // A retry after a crash between activation and the journal update
        // finds the live database already AT the plan (activation wrote data
        // and epochs together): every planned collection sits exactly at its
        // planned epoch and no other collection exists. That is idempotent.
        let live_now: HashMap<String, u64> = planned.prior.iter().cloned().collect();
        let already_applied = !plan.is_empty()
            && live_now.len() == plan.len()
            && plan.iter().all(|(c, e)| live_now.get(c) == Some(e));
        if already_applied {
            return Ok(());
        }
        for (collection, minimum) in &planned.plan {
            match expected.get(collection.as_str()) {
                Some(epoch) if *epoch >= *minimum => {}
                Some(epoch) => {
                    return Err(DbError::InvalidOperation(format!(
                        "Stale reset plan for '{collection}': planned epoch {epoch} no longer exceeds the live and snapshot generations (needs at least {minimum}); roll back or re-plan"
                    )))
                }
                None => {
                    return Err(DbError::InvalidOperation(format!(
                        "Incomplete reset plan: collection '{collection}' is missing; roll back or re-plan"
                    )))
                }
            }
        }
        let origin = origin.to_string();
        let now = chrono::Utc::now().to_rfc3339();
        self.replace_from_file_prepared(source_path, |staging| {
            staging.execute_batch("BEGIN")?;
            for (collection, epoch) in plan {
                check_epoch(*epoch)?;
                staging.execute(
                    "INSERT OR REPLACE INTO collection_epochs (collection, epoch, origin, reset_at) VALUES (?1, ?2, ?3, ?4)",
                    params![collection, *epoch as i64, origin, now],
                )?;
            }
            staging.execute_batch("COMMIT")?;
            // Verify the staging copy carries exactly the plan before activation.
            for (collection, epoch) in plan {
                let stored: i64 = staging.query_row(
                    "SELECT epoch FROM collection_epochs WHERE collection = ?1",
                    params![collection],
                    |row| row.get(0),
                )?;
                if stored != *epoch as i64 {
                    return Err(DbError::InvalidOperation(format!(
                        "Staged epoch for '{collection}' is {stored}, expected {epoch}"
                    )));
                }
            }
            before_activate(staging)
        })
    }

    /// Re-apply a persisted reset plan (after an interrupted authoritative
    /// restore): epochs only ever move forward, so this is idempotent.
    pub fn apply_reset_plan(&mut self, plan: &[(String, u64)], origin: &str) -> DbResult<()> {
        let origin = origin.to_string();
        self.with_transaction(|this| {
            for (collection, epoch) in plan {
                if this.get_epoch(collection)? < *epoch {
                    this.set_epoch(collection, *epoch, &origin)?;
                }
            }
            Ok(())
        })
    }

    /// Execute a closure atomically, rolling back both SQLite and cached CRDT state.
    /// Nested calls use savepoints: a caught inner error rolls back only that call,
    /// while successful batched operations still share one outer disk commit.
    pub fn with_transaction<F, T>(&mut self, f: F) -> DbResult<T>
    where
        F: FnOnce(&mut Self) -> DbResult<T>,
    {
        self.conn.execute_batch("SAVEPOINT xdb_transaction")?;
        // What a batch had written when this began: a rollback returns to it.
        let held = self.batch.as_ref().map(Batch::marks);
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(self))) {
            Ok(Ok(result)) => {
                if let Err(error) = self.conn.execute_batch("RELEASE SAVEPOINT xdb_transaction") {
                    self.rollback_savepoint();
                    self.forget_batched_since(held);
                    return Err(error.into());
                }
                Ok(result)
            }
            Ok(Err(error)) => {
                self.rollback_savepoint();
                self.forget_batched_since(held);
                Err(error)
            }
            Err(panic) => {
                self.rollback_savepoint();
                self.forget_batched_since(held);
                std::panic::resume_unwind(panic)
            }
        }
    }

    /// Execute a closure as one transaction in which each collection's CRDT
    /// document is saved once, at the end, however many records were written.
    ///
    /// A record write saves its collection's whole document: the snapshot is
    /// as large as the collection, so N writes into a collection of size C
    /// cost N encodings and N rows of size C. A host applying a pushed batch
    /// did that under its writer lock, a write at a time. Inside `with_batch`
    /// `create_record`, `update_record`, `delete_record` and `upsert_record`
    /// leave the snapshot alone, and each collection they touched is saved
    /// once before the transaction commits, in that transaction: the rows
    /// and the document they are replicated from still commit together or
    /// not at all.
    ///
    /// It is `with_transaction` otherwise. A write that fails inside it and
    /// is caught rolls back alone, and the writes before and after it are in
    /// the document that is saved; an error returned from `f` rolls back
    /// everything. A `with_batch` inside another is part of the outer one.
    pub fn with_batch<F, T>(&mut self, f: F) -> DbResult<T>
    where
        F: FnOnce(&mut Self) -> DbResult<T>,
    {
        if self.batch.is_some() {
            return self.with_transaction(f);
        }
        self.batch = Some(Batch::default());
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.with_transaction(|this| {
                let result = f(this)?;
                let touched: Vec<String> = this
                    .batch
                    .as_ref()
                    .map(|batch| batch.pending.keys().cloned().collect())
                    .unwrap_or_default();
                for collection in touched {
                    // Loaded again, with what the batch wrote, if a rollback dropped it.
                    this.get_or_create_doc(&collection)?;
                    if let Some(doc) = this.docs.get(&collection) {
                        Self::save_crdt_state_to_db(&this.conn, &collection, doc)?;
                    }
                }
                Ok(result)
            })
        }));
        self.batch = None;
        match outcome {
            Ok(result) => result,
            Err(panic) => std::panic::resume_unwind(panic),
        }
    }

    /// After a rollback inside a batch: the batch has written what it had
    /// written when the rolled-back transaction began, and no more.
    fn forget_batched_since(&mut self, marks: Option<HashMap<String, usize>>) {
        if let (Some(batch), Some(marks)) = (self.batch.as_mut(), marks) {
            batch.pending.retain(|collection, updates| match marks.get(collection) {
                Some(&kept) => {
                    updates.truncate(kept);
                    true
                }
                None => false,
            });
        }
    }

    /// Save a collection's document after a write to it, or, inside a
    /// batch, note the write for the one save at the batch's end.
    fn save_or_batch(&mut self, collection: &str, update: &[u8]) -> DbResult<()> {
        if let Some(batch) = self.batch.as_mut() {
            batch
                .pending
                .entry(collection.to_string())
                .or_default()
                .push(update.to_vec());
            return Ok(());
        }
        if let Some(doc) = self.docs.get(collection) {
            Self::save_crdt_state_to_db(&self.conn, collection, doc)?;
        }
        Ok(())
    }

    fn rollback_savepoint(&mut self) {
        let _ = self.conn.execute_batch(
            "ROLLBACK TO SAVEPOINT xdb_transaction; RELEASE SAVEPOINT xdb_transaction",
        );
        // Yrs transactions commit eagerly. Reload from the rolled-back SQLite
        // state on next access instead of retaining writes that never committed.
        self.docs.clear();
    }

    fn require_autocommit(&self, operation: &str) -> DbResult<()> {
        if !self.conn.is_autocommit() {
            return Err(DbError::InvalidOperation(format!(
                "Cannot {operation} inside a transaction"
            )));
        }
        Ok(())
    }

    fn require_distinct_path(&self, path: &PathBuf) -> DbResult<()> {
        if path.exists() && std::fs::canonicalize(path)? == std::fs::canonicalize(&self.db_path)? {
            return Err(DbError::InvalidOperation(
                "Source and destination must be different database files".into(),
            ));
        }
        Ok(())
    }

    /// Get or create a Yrs Doc for a collection
    fn get_or_create_doc(&mut self, collection: &str) -> DbResult<&mut Doc> {
        if !self.docs.contains_key(collection) {
            let doc = Doc::new();

            // Try to load existing CRDT state
            let state: Option<Vec<u8>> = self
                .conn
                .query_row(
                    "SELECT doc_state FROM crdt_state WHERE collection = ?1",
                    params![collection],
                    |row| row.get(0),
                )
                .optional()?;

            if let Some(state_bytes) = state {
                let update = Update::decode_v1(&state_bytes).map_err(|e| {
                    DbError::Crdt(format!("Invalid saved CRDT state for {collection}: {e}"))
                })?;
                let mut txn = doc.transact_mut();
                txn.apply_update(update)
                    .map_err(|e| DbError::Crdt(e.to_string()))?;
            }

            // Inside a batch the snapshot on disk is behind by what the
            // batch has written so far (with_batch). A document dropped by
            // a rollback gets those writes back here.
            if let Some(updates) = self.batch.as_ref().and_then(|batch| batch.pending.get(collection)) {
                let mut txn = doc.transact_mut();
                for bytes in updates {
                    let update = Update::decode_v1(bytes)
                        .map_err(|e| DbError::Crdt(format!("Invalid batched update for {collection}: {e}")))?;
                    txn.apply_update(update)
                        .map_err(|e| DbError::Crdt(e.to_string()))?;
                }
            }

            self.docs.insert(collection.to_string(), doc);
        }

        self.docs
            .get_mut(collection)
            .ok_or_else(|| DbError::NotFound(format!("Doc missing for collection: {}", collection)))
    }

    /// Save CRDT state for a collection (static helper to avoid borrow issues)
    fn save_crdt_state_to_db(conn: &Connection, collection: &str, doc: &Doc) -> DbResult<()> {
        let txn = doc.transact();
        let state_vector = txn.state_vector().encode_v1();
        let doc_state = txn.encode_state_as_update_v1(&yrs::StateVector::default());

        conn.execute(
            "INSERT OR REPLACE INTO crdt_state (collection, state_vector, doc_state) VALUES (?1, ?2, ?3)",
            params![collection, state_vector, doc_state],
        )?;

        Ok(())
    }

    /// Create a new record
    pub fn create_record(
        &mut self,
        collection: &str,
        data: serde_json::Value,
    ) -> DbResult<(Record, Vec<u8>)> {
        let collection = collection.to_string();
        let data = data.clone();
        self.with_transaction(|this| this.create_record_inner(&collection, data))
    }

    fn create_record_inner(
        &mut self,
        collection: &str,
        data: serde_json::Value,
    ) -> DbResult<(Record, Vec<u8>)> {
        let id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();

        let record = Record {
            id: id.clone(),
            collection: collection.to_string(),
            data: data.clone(),
            created_at: now.clone(),
            updated_at: now.clone(),
            deleted: false,
        };

        // Insert into SQLite
        self.conn.execute(
            "INSERT INTO records (id, collection, data, created_at, updated_at, deleted) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                &record.id,
                &record.collection,
                serde_json::to_string(&record.data)?,
                &record.created_at,
                &record.updated_at,
                record.deleted as i32
            ],
        )?;

        // Update CRDT doc and get update bytes
        let update = {
            let doc = self.get_or_create_doc(collection)?;
            let mut txn = doc.transact_mut();
            let map = txn.get_or_insert_map("records");
            map.insert(&mut txn, id.clone(), serde_json::to_string(&record)?);
            txn.encode_update_v1()
        };

        // Save CRDT state (separate borrow scope)
        self.save_or_batch(collection, &update)?;

        Ok((record, update))
    }

    /// Update an existing record
    pub fn update_record(
        &mut self,
        id: &str,
        data: serde_json::Value,
    ) -> DbResult<(Record, Vec<u8>)> {
        self.update_record_at(id, data, None)
    }

    /// `update_record`, stamped no earlier than `stamp`, the stamp the page gave the edit
    /// (see `edit_stamp`).
    pub fn update_record_at(
        &mut self,
        id: &str,
        data: serde_json::Value,
        stamp: Option<&str>,
    ) -> DbResult<(Record, Vec<u8>)> {
        let id = id.to_string();
        let stamp = stamp.map(str::to_string);
        self.with_transaction(|this| this.update_record_batched(&id, data, true, stamp.as_deref()))
    }

    /// `persist_doc = false` defers the CRDT snapshot write to the caller
    /// (one save per collection per batch instead of one per record).
    fn update_record_batched(
        &mut self,
        id: &str,
        data: serde_json::Value,
        persist_doc: bool,
        stamp: Option<&str>,
    ) -> DbResult<(Record, Vec<u8>)> {
        // Get existing record (need current data for merge)
        let existing = self.get_record(id)?;
        if existing.deleted {
            return Err(DbError::NotFound(id.to_string()));
        }
        let now = edit_stamp(&existing.updated_at, stamp);
        let collection = existing.collection.clone();

        // Merge incoming data with existing data (shallow merge, incoming wins)
        let merged_data = match (existing.data, data) {
            (
                serde_json::Value::Object(mut existing_map),
                serde_json::Value::Object(incoming_map),
            ) => {
                for (k, v) in incoming_map {
                    existing_map.insert(k, v);
                }
                serde_json::Value::Object(existing_map)
            }
            // If incoming is not an object, treat as full replacement
            (_, incoming) => incoming,
        };

        // Update SQLite with merged data
        self.conn.execute(
            "UPDATE records SET data = ?1, updated_at = ?2 WHERE id = ?3",
            params![serde_json::to_string(&merged_data)?, &now, id],
        )?;

        let record = self.get_record(id)?;
        let record_json = serde_json::to_string(&record)?;

        // Update CRDT and get update bytes
        let update = {
            let doc = self.get_or_create_doc(&collection)?;
            let mut txn = doc.transact_mut();
            let map = txn.get_or_insert_map("records");
            map.insert(&mut txn, id.to_string(), record_json);
            txn.encode_update_v1()
        };

        // Save CRDT state (separate borrow scope)
        if persist_doc {
            self.save_or_batch(&collection, &update)?;
        }

        Ok((record, update))
    }

    /// Update several records in ONE transaction with one CRDT snapshot per
    /// touched collection (the benchmark's "batch edit" lane wrote the whole
    /// document after every record). All updates commit or none does; the
    /// returned deltas must be published only after this returns.
    pub fn update_records(
        &mut self,
        updates: Vec<(String, serde_json::Value)>,
    ) -> DbResult<Vec<(Record, Vec<u8>)>> {
        self.with_transaction(|this| {
            let mut out = Vec::with_capacity(updates.len());
            let mut touched: Vec<String> = Vec::new();
            for (id, data) in updates {
                let (record, update) = this.update_record_batched(&id, data, false, None)?;
                if !touched.contains(&record.collection) {
                    touched.push(record.collection.clone());
                }
                out.push((record, update));
            }
            for collection in touched {
                if let Some(doc) = this.docs.get(&collection) {
                    Self::save_crdt_state_to_db(&this.conn, &collection, doc)?;
                }
            }
            Ok(out)
        })
    }

    /// Soft delete a record
    pub fn delete_record(&mut self, id: &str) -> DbResult<Vec<u8>> {
        self.delete_record_at(id, None)
    }

    /// `delete_record`, stamped no earlier than `stamp`, the stamp the page gave the
    /// deletion (see `edit_stamp`).
    pub fn delete_record_at(&mut self, id: &str, stamp: Option<&str>) -> DbResult<Vec<u8>> {
        let id = id.to_string();
        let stamp = stamp.map(str::to_string);
        self.with_transaction(|this| this.delete_record_batched(&id, true, stamp.as_deref()))
    }

    /// `persist_doc = false` defers the CRDT snapshot write to the caller (one
    /// save per collection per batch instead of one per record, audit XD-04).
    fn delete_record_batched(&mut self, id: &str, persist_doc: bool, stamp: Option<&str>) -> DbResult<Vec<u8>> {
        let mut record = self.get_record(id)?;
        let collection = record.collection.clone();
        let now = edit_stamp(&record.updated_at, stamp);

        self.conn.execute(
            "UPDATE records SET deleted = 1, updated_at = ?1 WHERE id = ?2",
            params![&now, id],
        )?;

        record.updated_at = now;
        record.deleted = true;
        let record_json = serde_json::to_string(&record)?;

        // Update CRDT and get update bytes
        let update = {
            let doc = self.get_or_create_doc(&collection)?;
            let mut txn = doc.transact_mut();
            let map = txn.get_or_insert_map("records");
            map.insert(&mut txn, id.to_string(), record_json);
            txn.encode_update_v1()
        };

        // Save CRDT state (separate borrow scope)
        if persist_doc {
            self.save_or_batch(&collection, &update)?;
        }

        Ok(update)
    }

    /// Upsert a record with a specific ID (used for external sync sources)
    pub fn upsert_record(&mut self, record: Record) -> DbResult<Vec<u8>> {
        self.with_transaction(|this| this.upsert_record_inner(record))
    }

    fn upsert_record_inner(&mut self, record: Record) -> DbResult<Vec<u8>> {
        // What sync hands over names its collection, and a record of another one here is
        // not that collection's to replace (the Rust host refuses such an op the same way).
        if self.held_by_another_collection(&record)? {
            return Err(DbError::InvalidOperation(format!(
                "record {} belongs to another collection than {}",
                record.id, record.collection
            )));
        }
        self.upsert_record_batched(record, true)
    }

    /// `upsert_record` for several records, in ONE transaction with one CRDT snapshot per
    /// collection touched: what a page's peer sync brings in at once. One call a record
    /// re-encoded and rewrote the collection's whole document every time, so a room of a
    /// few thousand records cost gigabytes of writes to join. A record another collection
    /// holds is passed over, as `upsert_record` refuses it, and its id is answered with the
    /// written records' deltas, to be published after this returns.
    pub fn upsert_records(&mut self, records: Vec<Record>) -> DbResult<(Vec<(Record, Vec<u8>)>, Vec<String>)> {
        self.with_transaction(|this| {
            let mut written = Vec::with_capacity(records.len());
            let mut refused = Vec::new();
            let mut touched: Vec<String> = Vec::new();
            for record in records {
                if this.held_by_another_collection(&record)? {
                    refused.push(record.id);
                    continue;
                }
                if !touched.contains(&record.collection) {
                    touched.push(record.collection.clone());
                }
                let update = this.upsert_record_batched(record.clone(), false)?;
                written.push((record, update));
            }
            for collection in touched {
                if let Some(doc) = this.docs.get(&collection) {
                    Self::save_crdt_state_to_db(&this.conn, &collection, doc)?;
                }
            }
            Ok((written, refused))
        })
    }

    /// Whether `record`'s id is a live record of another collection here: what an import
    /// refuses. A deleted one (a tombstone) is written over, moved into the import's
    /// collection: the page refuses such an import before it changes anything, by the records
    /// it holds, and after loading it holds live records alone, so a refusal here for a
    /// tombstone came after the page had changed its records and told sync of the import.
    fn live_in_another_collection(&self, record: &Record) -> DbResult<bool> {
        let held: Option<String> = self
            .conn
            .query_row("SELECT collection FROM records WHERE id = ?1 AND deleted = 0", params![&record.id], |row| row.get(0))
            .optional()?;
        Ok(held.is_some_and(|collection| collection != record.collection))
    }

    /// Whether `record`'s id is a record of another collection here. Records are kept by id
    /// alone, so writing it would replace that record and move it into `record`'s collection:
    /// a peer or a sync server writing in one collection reached a record of another, one
    /// never shared with it included.
    fn held_by_another_collection(&self, record: &Record) -> DbResult<bool> {
        let held: Option<String> = self
            .conn
            .query_row("SELECT collection FROM records WHERE id = ?1", params![&record.id], |row| row.get(0))
            .optional()?;
        Ok(held.is_some_and(|collection| collection != record.collection))
    }

    /// `persist_doc = false` defers the CRDT snapshot write to the caller (audit XD-04).
    fn upsert_record_batched(&mut self, record: Record, persist_doc: bool) -> DbResult<Vec<u8>> {
        let record_json = serde_json::to_string(&record)?;

        // Upsert into SQLite
        self.conn.execute(
            "INSERT OR REPLACE INTO records (id, collection, data, created_at, updated_at, deleted) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                &record.id,
                &record.collection,
                serde_json::to_string(&record.data)?,
                &record.created_at,
                &record.updated_at,
                record.deleted as i32
            ],
        )?;

        // Update CRDT doc and get update bytes
        let update = {
            let doc = self.get_or_create_doc(&record.collection)?;
            let mut txn = doc.transact_mut();
            let map = txn.get_or_insert_map("records");
            map.insert(&mut txn, record.id.clone(), record_json);
            txn.encode_update_v1()
        };

        // Save CRDT state (separate borrow scope)
        if persist_doc {
            self.save_or_batch(&record.collection, &update)?;
        }

        Ok(update)
    }

    /// Get a single record by ID
    pub fn get_record(&self, id: &str) -> DbResult<Record> {
        self.conn
            .query_row(
                "SELECT id, collection, data, created_at, updated_at, deleted FROM records WHERE id = ?1",
                params![id],
                record_from_row,
            )
            .optional()?
            .ok_or_else(|| DbError::NotFound(id.to_string()))
    }

    /// Get all records in a collection
    pub fn get_collection(&self, collection: &str) -> DbResult<Vec<Record>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, collection, data, created_at, updated_at, deleted FROM records WHERE collection = ?1 AND deleted = 0 ORDER BY created_at DESC",
        )?;

        let records = stmt
            .query_map(params![collection], record_from_row)?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(records)
    }

    /// Get all collections
    pub fn get_collections(&self) -> DbResult<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT DISTINCT collection FROM records")?;
        let collections = stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(collections)
    }

    // ── Reset epochs (audit XD-03) ────────────────────────────────────────────

    /// The collection's reset epoch (0 until it has ever been reset).
    pub fn get_epoch(&self, collection: &str) -> DbResult<u64> {
        let epoch: Option<i64> = self
            .conn
            .query_row(
                "SELECT epoch FROM collection_epochs WHERE collection = ?1",
                params![collection],
                |row| row.get(0),
            )
            .optional()?;
        Ok(epoch.unwrap_or(0).max(0) as u64)
    }

    fn set_epoch(&self, collection: &str, epoch: u64, origin: &str) -> DbResult<()> {
        check_epoch(epoch)?;
        self.conn.execute(
            "INSERT OR REPLACE INTO collection_epochs (collection, epoch, origin, reset_at) VALUES (?1, ?2, ?3, ?4)",
            params![collection, epoch as i64, origin, chrono::Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    /// Administrative reset of a SHARED collection: clears local records and
    /// CRDT state and advances the epoch. The caller broadcasts the returned
    /// epoch; peers on the old epoch adopt it and can no longer reintroduce
    /// pre-reset records. Compare `clear_collection`, which is local only.
    pub fn reset_collection(&mut self, collection: &str, origin: &str) -> DbResult<u64> {
        let collection = collection.to_string();
        let origin = origin.to_string();
        self.with_transaction(|this| {
            let epoch = this.get_epoch(&collection)? + 1;
            this.clear_collection_inner(&collection)?;
            this.set_epoch(&collection, epoch, &origin)?;
            Ok(epoch)
        })
    }

    /// Advance the epoch WITHOUT clearing: the current local contents become
    /// the authoritative post-reset state (a "replace synchronized state"
    /// restore). Peers adopt the reset and then fetch this node's state.
    pub fn bump_epoch(&mut self, collection: &str, origin: &str) -> DbResult<u64> {
        let collection = collection.to_string();
        let origin = origin.to_string();
        self.with_transaction(|this| {
            let epoch = this.get_epoch(&collection)? + 1;
            this.set_epoch(&collection, epoch, &origin)?;
            Ok(epoch)
        })
    }

    /// Adopt a reset announced by a peer. Returns true when the epoch was
    /// newer than ours and the collection was cleared; false (nothing done)
    /// for an equal or OLDER epoch — a stale peer cannot undo a newer reset.
    pub fn apply_remote_reset(
        &mut self,
        collection: &str,
        epoch: u64,
        origin: &str,
    ) -> DbResult<bool> {
        // Epochs are kept as SQLite integers. One past i64::MAX was kept as a negative number
        // and read back as 0: the collection was cleared, and then a peer's updates from
        // before the reset applied again, the very records a reset is there to keep out. And
        // one at i64::MAX itself left no room for this node's next reset of the collection.
        if epoch > MAX_EPOCH {
            return Ok(false);
        }
        let collection = collection.to_string();
        let origin = origin.to_string();
        self.with_transaction(|this| {
            let local = this.get_epoch(&collection)?;
            // Nor a leap: a reset is one more than the epoch it ends, a restore one more
            // than the larger of two, so peers' epochs of a collection stay close. One peer
            // that named MAX_EPOCH for any collection, one the app never used included, left
            // this node no reset of its own and no restore past it.
            if epoch <= local || epoch - local > MAX_EPOCH_STEP {
                return Ok(false);
            }
            this.clear_collection_inner(&collection)?;
            this.set_epoch(&collection, epoch, &origin)?;
            Ok(true)
        })
    }

    /// Apply a peer's update only when its epoch matches ours.
    pub fn apply_remote_update_at_epoch(
        &mut self,
        collection: &str,
        epoch: u64,
        update_bytes: &[u8],
    ) -> DbResult<RemoteApplyOutcome> {
        let local = self.get_epoch(collection)?;
        if epoch < local {
            return Ok(RemoteApplyOutcome::StaleEpoch {
                local,
                remote: epoch,
            });
        }
        if epoch > local {
            return Ok(RemoteApplyOutcome::MissingReset {
                local,
                remote: epoch,
            });
        }
        Ok(RemoteApplyOutcome::Applied(
            self.apply_remote_update(collection, update_bytes)?,
        ))
    }

    // ── Bulk import (audit SN-01) ─────────────────────────────────────────────

    fn validate_import_record(collection: &str, record: &Record) -> DbResult<()> {
        if record.id.trim().is_empty() {
            return Err(DbError::InvalidOperation(format!(
                "Import into '{collection}' contains a record without an id"
            )));
        }
        if record.collection != collection {
            return Err(DbError::InvalidOperation(format!(
                "Record '{}' belongs to '{}' but was imported into '{}'",
                record.id, record.collection, collection
            )));
        }
        Ok(())
    }

    /// Import several collections in ONE transaction. Either every batch
    /// commits or none does; the summary is returned only after the commit.
    ///
    /// - The whole batch is validated (non-empty collection names, non-empty
    ///   ids, records that belong to their batch) before any write.
    /// - `replace` tombstones records absent from the batch instead of hard
    ///   deleting them, so the removal REPLICATES to peers; a local hard
    ///   reset stays the separate, explicit `clear_collection`.
    /// - Returned deltas must be published only after this returns.
    pub fn import_records(
        &mut self,
        batches: Vec<CollectionImport>,
    ) -> DbResult<(ImportSummary, CommittedDeltas)> {
        for batch in &batches {
            if batch.collection.trim().is_empty() {
                return Err(DbError::InvalidOperation(
                    "Import contains a batch without a collection name".into(),
                ));
            }
            for record in &batch.records {
                Self::validate_import_record(&batch.collection, record)?;
            }
        }
        self.with_transaction(|this| {
            let mut summary = ImportSummary::default();
            let mut deltas: CommittedDeltas = Vec::new();
            for batch in batches {
                let epoch = this.get_epoch(&batch.collection)?;
                let mut tombstoned = 0u64;
                if batch.replace {
                    let incoming: HashMap<&str, ()> =
                        batch.records.iter().map(|r| (r.id.as_str(), ())).collect();
                    let existing = this.get_collection(&batch.collection)?;
                    for record in existing {
                        if !incoming.contains_key(record.id.as_str()) {
                            let update = this.delete_record_batched(&record.id, false, None)?;
                            deltas.push((batch.collection.clone(), epoch, update));
                            tombstoned += 1;
                        }
                    }
                }
                let mut imported = 0u64;
                for record in batch.records {
                    // Records are kept by id alone: one another collection holds would be
                    // moved into this one, out of the other with no tombstone, as
                    // upsert_record refuses to do. The whole import is refused instead.
                    if this.live_in_another_collection(&record)? {
                        return Err(DbError::InvalidOperation(format!(
                            "Record '{}' imported into '{}' is a record of another collection here",
                            record.id, record.collection
                        )));
                    }
                    let update = this.upsert_record_batched(record, false)?;
                    deltas.push((batch.collection.clone(), epoch, update));
                    imported += 1;
                }
                // One CRDT snapshot per collection per batch (audit XD-04): saving
                // the whole document after EVERY record made a bulk import O(N^2)
                // in encoded bytes. The transaction still commits all or nothing.
                if let Some(doc) = this.docs.get(&batch.collection) {
                    Self::save_crdt_state_to_db(&this.conn, &batch.collection, doc)?;
                }
                summary.imported += imported;
                summary.tombstoned += tombstoned;
                summary.collections.push(CollectionImportResult {
                    collection: batch.collection,
                    replaced: batch.replace,
                    imported,
                    tombstoned,
                    epoch,
                });
            }
            Ok((summary, deltas))
        })
    }

    // ── Reconciliation helpers (audit XD-02) ──────────────────────────────────

    /// (collection, epoch, state vector) for every local collection: what a
    /// join/repair pass sends so peers can return exactly what we lack.
    pub fn reconcile_plan(&mut self) -> DbResult<Vec<(String, u64, Vec<u8>)>> {
        let mut plan = Vec::new();
        for collection in self.get_collections()? {
            let epoch = self.get_epoch(&collection)?;
            let sv = self.get_state_vector(&collection)?;
            plan.push((collection, epoch, sv));
        }
        Ok(plan)
    }

    /// Collections a peer announced that this node has never stored.
    pub fn unknown_collections(&self, announced: &[String]) -> DbResult<Vec<String>> {
        let known: HashMap<String, ()> = self
            .get_collections()?
            .into_iter()
            .map(|c| (c, ()))
            .collect();
        Ok(announced
            .iter()
            .filter(|c| !known.contains_key(*c))
            .cloned()
            .collect())
    }

    /// Total rows changed on this connection since it was opened (SQLite's
    /// own counter). Benchmarks use it to measure write amplification.
    pub fn total_changes(&self) -> u64 {
        // SAFETY: the handle belongs to this live connection and is only read.
        unsafe { rusqlite::ffi::sqlite3_total_changes(self.conn.handle()) as u64 }
    }

    /// Apply a remote CRDT update
    pub fn apply_remote_update(
        &mut self,
        collection: &str,
        update_bytes: &[u8],
    ) -> DbResult<Vec<Record>> {
        let collection = collection.to_string();
        let update_bytes = update_bytes.to_vec();
        self.with_transaction(|this| this.apply_remote_update_inner(&collection, &update_bytes))
    }

    fn apply_remote_update_inner(
        &mut self,
        collection: &str,
        update_bytes: &[u8],
    ) -> DbResult<Vec<Record>> {
        // Parse the update first
        let update = Update::decode_v1(update_bytes).map_err(|e| DbError::Crdt(e.to_string()))?;

        // Apply the update and extract ONLY the records it changed (audit
        // XD-04): a map observer collects the touched keys while the
        // transaction commits, so a one-record delta writes one row instead
        // of re-upserting the whole collection. A duplicate delivery changes
        // no key and therefore writes nothing.
        let updated_records: Vec<Record> = {
            let doc = self.get_or_create_doc(collection)?;
            let changed: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
            let map = doc.get_or_insert_map("records");
            let sink = changed.clone();
            let subscription = map.observe(move |txn, event| {
                if let Ok(mut keys) = sink.lock() {
                    for key in event.keys(txn).keys() {
                        keys.insert(key.to_string());
                    }
                }
            });

            // Apply the update (observers fire when the transaction commits)
            {
                let mut txn = doc.transact_mut();
                txn.apply_update(update)
                    .map_err(|e| DbError::Crdt(e.to_string()))?;
            }
            drop(subscription);

            let keys = changed
                .lock()
                .map(|k| k.clone())
                .unwrap_or_default();
            Self::records_from_doc_keys(collection, doc, &keys)?
        };

        // Now update SQLite with the extracted records: those of this collection, and not
        // over a record another collection holds under the same id (`upsert_record`).
        let mut written = Vec::with_capacity(updated_records.len());
        for record in updated_records {
            if self.held_by_another_collection(&record)? {
                tracing::warn!("Remote update for {} skips record {}: it is a record of another collection here", collection, record.id);
                continue;
            }
            self.conn.execute(
                "INSERT OR REPLACE INTO records (id, collection, data, created_at, updated_at, deleted) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    &record.id,
                    &record.collection,
                    serde_json::to_string(&record.data)?,
                    &record.created_at,
                    &record.updated_at,
                    record.deleted as i32
                ],
            )?;
            written.push(record);
        }

        // Save CRDT state
        let doc = self
            .docs
            .get(collection)
            .ok_or_else(|| DbError::NotFound(collection.to_string()))?;
        Self::save_crdt_state_to_db(&self.conn, collection, doc)?;

        Ok(written)
    }

    /// Validated records for the given map keys only (keys no longer present
    /// are skipped: records are never removed from the map, only tombstoned).
    fn records_from_doc_keys(
        collection: &str,
        doc: &Doc,
        keys: &HashSet<String>,
    ) -> DbResult<Vec<Record>> {
        let txn = doc.transact();
        let mut records = Vec::with_capacity(keys.len());
        if let Some(map) = txn.get_map("records") {
            for key in keys {
                let Some(value) = map.get(&txn, key.as_str()) else {
                    continue;
                };
                let yrs::Out::Any(yrs::Any::String(json_str)) = value else {
                    return Err(DbError::Crdt(
                        "Invalid record payload type in CRDT map".to_string(),
                    ));
                };
                let record = serde_json::from_str::<Record>(json_str.as_ref()).map_err(|e| {
                    DbError::Crdt(format!("Invalid record JSON in CRDT map: {}", e))
                })?;
                if record.collection != collection {
                    return Err(DbError::Crdt(format!(
                        "CRDT record collection mismatch: expected '{}', got '{}'",
                        collection, record.collection
                    )));
                }
                if &record.id != key {
                    return Err(DbError::Crdt(format!(
                        "CRDT record id mismatch: key '{}' vs record.id '{}'",
                        key, record.id
                    )));
                }
                records.push(record);
            }
        }
        Ok(records)
    }

    fn records_from_doc(collection: &str, doc: &Doc) -> DbResult<Vec<Record>> {
        let txn = doc.transact();
        let mut records = Vec::new();
        if let Some(map) = txn.get_map("records") {
            for (key, value) in map.iter(&txn) {
                let yrs::Out::Any(yrs::Any::String(json_str)) = value else {
                    return Err(DbError::Crdt(
                        "Invalid record payload type in CRDT map".to_string(),
                    ));
                };

                let record = serde_json::from_str::<Record>(json_str.as_ref()).map_err(|e| {
                    DbError::Crdt(format!("Invalid record JSON in CRDT map: {}", e))
                })?;

                if record.collection != collection {
                    return Err(DbError::Crdt(format!(
                        "CRDT record collection mismatch: expected '{}', got '{}'",
                        collection, record.collection
                    )));
                }

                let map_key = key.to_string();
                if record.id != map_key {
                    return Err(DbError::Crdt(format!(
                        "CRDT record id mismatch: key '{}' vs record.id '{}'",
                        map_key, record.id
                    )));
                }

                records.push(record);
            }
        }
        Ok(records)
    }

    /// The collection's document when this database has one, in memory or saved; None for
    /// a collection it has never held. Asking about a collection makes none: a peer names
    /// any collection it likes (up to 200 an announcement), and each name it asked after was
    /// a document made and kept in memory for as long as the database was open.
    fn held_doc(&mut self, collection: &str) -> DbResult<Option<&mut Doc>> {
        let held = self.docs.contains_key(collection)
            || self
                .conn
                .query_row("SELECT 1 FROM crdt_state WHERE collection = ?1", params![collection], |_| Ok(()))
                .optional()?
                .is_some();
        if !held {
            return Ok(None);
        }
        self.get_or_create_doc(collection).map(Some)
    }

    /// Get current state vector for syncing
    pub fn get_state_vector(&mut self, collection: &str) -> DbResult<Vec<u8>> {
        match self.held_doc(collection)? {
            Some(doc) => Ok(doc.transact().state_vector().encode_v1()),
            None => Ok(yrs::StateVector::default().encode_v1()),
        }
    }

    /// Get updates since a given state vector
    pub fn get_updates_since(
        &mut self,
        collection: &str,
        state_vector: &[u8],
    ) -> DbResult<Vec<u8>> {
        let sv =
            yrs::StateVector::decode_v1(state_vector).map_err(|e| DbError::Crdt(e.to_string()))?;
        match self.held_doc(collection)? {
            Some(doc) => Ok(doc.transact().encode_state_as_update_v1(&sv)),
            None => Ok(Doc::new().transact().encode_state_as_update_v1(&sv)),
        }
    }

    /// Get full state for initial sync
    #[allow(dead_code)]
    pub fn get_full_state(&mut self, collection: &str) -> DbResult<Vec<u8>> {
        self.get_updates_since(collection, &yrs::StateVector::default().encode_v1())
    }

    /// LOCAL cache reset: hard-delete the collection's records and CRDT state on
    /// THIS node only. Nothing is replicated — peers keep their copy and will
    /// repopulate this node on the next reconciliation. For a replicated
    /// deletion use `delete_record` (a tombstone); for an authoritative reset
    /// of a shared collection use `reset_collection` (an epoch), audit XD-03.
    pub fn clear_collection(&mut self, collection: &str) -> DbResult<()> {
        self.with_transaction(|this| this.clear_collection_inner(collection))
    }

    fn clear_collection_inner(&mut self, collection: &str) -> DbResult<()> {
        self.conn.execute(
            "DELETE FROM records WHERE collection = ?1",
            params![collection],
        )?;
        self.conn.execute(
            "DELETE FROM crdt_state WHERE collection = ?1",
            params![collection],
        )?;
        // Reset the in-memory CRDT doc
        self.docs.remove(collection);
        Ok(())
    }

    /// Export a consistent SQLite snapshot, including recent writes in the WAL.
    pub fn export_to_file(&self, path: &PathBuf) -> DbResult<()> {
        self.require_autocommit("export")?;
        self.require_distinct_path(path)?;
        self.conn.backup(DatabaseName::Main, path, None)?;
        Ok(())
    }

    /// Get database statistics
    pub fn get_stats(&self) -> DbResult<DbStats> {
        let record_count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM records WHERE deleted = 0",
            [],
            |row| row.get(0),
        )?;

        let collection_count: i64 = self.conn.query_row(
            "SELECT COUNT(DISTINCT collection) FROM records",
            [],
            |row| row.get(0),
        )?;

        // Logical database size includes pages whose latest version is in WAL.
        let page_count: u64 = self
            .conn
            .pragma_query_value(None, "page_count", |row| row.get(0))?;
        let page_size: u64 = self
            .conn
            .pragma_query_value(None, "page_size", |row| row.get(0))?;

        Ok(DbStats {
            record_count: record_count as u64,
            collection_count: collection_count as u64,
            db_size_bytes: page_count * page_size,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DbStats {
    pub record_count: u64,
    pub collection_count: u64,
    pub db_size_bytes: u64,
}

/// Thread-safe wrapper for the database
pub type SharedDb = Arc<Mutex<XdbDatabase>>;

/// What an authoritative restore will commit (R3-XD-02), journaled by the
/// host before the live database is touched.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthoritativeRestorePlan {
    /// The live catalog (collection, epoch) the plan was computed against.
    pub prior: Vec<(String, u64)>,
    /// The epoch every collection in the union of both catalogs will carry.
    pub plan: Vec<(String, u64)>,
}

pub fn create_shared_db(path: PathBuf) -> DbResult<SharedDb> {
    Ok(Arc::new(Mutex::new(XdbDatabase::open(path)?)))
}

#[cfg(test)]
#[path = "db_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "bench_tests.rs"]
mod bench_tests;
