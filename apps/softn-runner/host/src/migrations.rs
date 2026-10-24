//! An app's migrations (the PHP host's runtime/migrations.mjs). A migration is
//! guest input too: the authorizer (sql.rs `migration_authorize`) keeps it to
//! the app's own tables, and a verified one-statement nullable TEXT ADD COLUMN
//! may run the target table's quick_check that SQLite makes for it.

use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use rusqlite::{
    hooks::{AuthAction, AuthContext, Authorization},
    limits::Limit,
    Connection,
};

use crate::{
    sql::{app_table, clear, migration_authorize, VDBE_OP_LIMIT},
    HostError,
};

/// The deadline setup.php's own run gives migrations
/// (`SOFTN_SETUP_DEADLINE_MS`, a whole number of milliseconds up to a day).
pub fn setup_deadline_ms() -> Option<u64> {
    let text = std::env::var("SOFTN_SETUP_DEADLINE_MS").ok()?;
    let valid = (1..=8).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_digit()) && !text.starts_with('0');
    valid.then(|| text.parse::<u64>().ok()).flatten().filter(|ms| *ms <= 86_400_000)
}

fn host_names(db: &Connection) -> Result<HashSet<String>, HostError> {
    let mut statement = db.prepare("SELECT name FROM sqlite_master WHERE substr(name,1,1)='_'").map_err(HostError::sqlite)?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0)).map_err(HostError::sqlite)?;
    rows.collect::<Result<_, _>>().map_err(HostError::sqlite)
}

fn fold(value: &str) -> String {
    value.chars().map(|c| if c.is_ascii_uppercase() { c.to_ascii_lowercase() } else { c }).collect()
}

fn same(a: &str, b: &str) -> bool {
    fold(a) == fold(b)
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Word,
    Identifier,
    Str,
    Variable,
    Punctuation,
}

#[derive(Clone)]
struct Token {
    kind: Kind,
    value: String,
}

struct Slice {
    start: usize,
    end: usize,
    /// The first 16 tokens, when the statement has no more than that.
    tokens: Option<Vec<Token>>,
}

fn word(token: Option<&Token>, value: &str) -> bool {
    token.is_some_and(|t| t.kind == Kind::Word && same(&t.value, value))
}

fn identifier(token: Option<&Token>) -> Option<String> {
    let t = token?;
    if !matches!(t.kind, Kind::Identifier | Kind::Word) || t.value.is_empty() || !t.value.chars().all(|c| (' '..='~').contains(&c)) {
        return None;
    }
    if t.kind == Kind::Word {
        let mut chars = t.value.chars();
        let first = chars.next()?;
        if !(first.is_ascii_alphabetic() || first == '_') || !chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$') {
            return None;
        }
    }
    Some(t.value.clone())
}

/// Lex the whole file into statements before any SQL runs (migrations.mjs
/// `statements`): a `;` in a quote or a comment is text; NUL, an unterminated
/// quote, comment or variable refuse the file.
fn statements(sql: &str, collect: bool) -> Result<Vec<Slice>, HostError> {
    if sql.contains('\0') {
        return Err(HostError::own("Migration contains NUL"));
    }
    // Byte offsets of each char, so slices are taken from the original text.
    let chars: Vec<(usize, char)> = sql.char_indices().collect();
    let n = chars.len();
    let at = |i: usize| chars.get(i).map(|(_, c)| *c);
    let offset = |i: usize| chars.get(i).map_or(sql.len(), |(o, _)| *o);
    let starts = |i: usize, s: &str| s.chars().enumerate().all(|(k, c)| at(i + k) == Some(c));
    let name_char = |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$' || (c as u32) >= 128);
    let mut out = Vec::new();
    let (mut i, mut start, mut tokens, mut count): (usize, usize, Vec<Token>, usize) = (0, 0, Vec::new(), 0);
    let add = |tokens: &mut Vec<Token>, count: &mut usize, kind: Kind, value: String| {
        *count += 1;
        if *count <= 16 && collect {
            tokens.push(Token { kind, value });
        }
    };
    let finish = |end: usize, start: &mut usize, tokens: &mut Vec<Token>, count: &mut usize, out: &mut Vec<Slice>| {
        if *count > 0 {
            out.push(Slice { start: *start, end, tokens: (collect && *count <= 16).then(|| std::mem::take(tokens)) });
        }
        *start = end;
        tokens.clear();
        *count = 0;
    };
    while i < n {
        let c = at(i).unwrap();
        if matches!(c, ' ' | '\t' | '\n' | '\r' | '\u{c}' | '\u{feff}') {
            i += 1;
            continue;
        }
        if starts(i, "--") {
            i = (i + 2..n).find(|&j| at(j) == Some('\n')).map_or(n, |j| j + 1);
            continue;
        }
        if starts(i, "/*") {
            let end = (i + 2..n.saturating_sub(1)).find(|&j| at(j) == Some('*') && at(j + 1) == Some('/'));
            match end {
                Some(end) => i = end + 2,
                None => return Err(HostError::own("Unterminated migration comment")),
            }
            continue;
        }
        if c == ';' {
            i += 1;
            finish(offset(i), &mut start, &mut tokens, &mut count, &mut out);
            continue;
        }
        if matches!(c, '$' | ':' | '@') {
            let (mut j, mut chars_seen) = (i + 1, 0);
            loop {
                if name_char(at(j)) {
                    j += 1;
                    chars_seen += 1;
                } else if starts(j, "::") {
                    j += 2;
                } else if at(j) == Some('(') && chars_seen > 0 {
                    while j < n && at(j) != Some(')') && !matches!(at(j), Some(' ' | '\t' | '\n' | '\r' | '\u{c}')) {
                        j += 1;
                    }
                    if at(j) != Some(')') {
                        return Err(HostError::own("Unterminated migration variable"));
                    }
                    j += 1;
                    break;
                } else {
                    break;
                }
            }
            add(&mut tokens, &mut count, Kind::Variable, String::new());
            i = j.max(i + 1);
            continue;
        }
        if matches!(c, '\'' | '"' | '`' | '[') {
            let begin = i;
            let close = if c == '[' { ']' } else { c };
            let mut closed = false;
            i += 1;
            while i < n {
                if at(i) == Some(close) {
                    i += 1;
                    if close != ']' && at(i) == Some(close) {
                        i += 1;
                        continue;
                    }
                    closed = true;
                    break;
                }
                i += 1;
            }
            if !closed {
                return Err(HostError::own("Unterminated migration quote"));
            }
            if c == '\'' {
                add(&mut tokens, &mut count, Kind::Str, String::new());
            } else {
                let mut value = String::new();
                if collect && count < 16 {
                    value = sql[offset(begin + 1)..offset(i - 1)].to_string();
                    if close != ']' {
                        value = value.replace(&format!("{close}{close}"), &close.to_string());
                    }
                }
                add(&mut tokens, &mut count, Kind::Identifier, value);
            }
            continue;
        }
        if name_char(Some(c)) {
            let begin = i;
            while name_char(at(i)) {
                i += 1;
            }
            let value = if collect && count < 16 { sql[offset(begin)..offset(i)].to_string() } else { String::new() };
            add(&mut tokens, &mut count, Kind::Word, value);
            continue;
        }
        add(&mut tokens, &mut count, Kind::Punctuation, c.to_string());
        i += 1;
    }
    finish(sql.len(), &mut start, &mut tokens, &mut count, &mut out);
    Ok(out)
}

struct AddColumn {
    table: String,
    qualified: bool,
    references: Option<String>,
}

/// Only a nullable TEXT, optionally REFERENCES one column of an app table.
fn nullable_text_add(tokens: Option<&Vec<Token>>) -> Option<AddColumn> {
    let tokens = tokens?;
    let t = |i: usize| tokens.get(i);
    if !word(t(0), "ALTER") || !word(t(1), "TABLE") {
        return None;
    }
    let mut i = 2;
    let mut table = identifier(t(i))?;
    i += 1;
    let mut qualified = false;
    if t(i).is_some_and(|t| t.kind == Kind::Punctuation && t.value == ".") {
        if !same(&table, "main") {
            return None;
        }
        qualified = true;
        i += 1;
        table = identifier(t(i))?;
        i += 1;
    }
    if !app_table(&table) || !word(t(i), "ADD") {
        return None;
    }
    i += 1;
    if word(t(i), "COLUMN") {
        i += 1;
    }
    identifier(t(i))?;
    i += 1;
    if !word(t(i), "TEXT") {
        return None;
    }
    i += 1;
    let mut references = None;
    if i < tokens.len() {
        if !word(t(i), "REFERENCES") {
            return None;
        }
        i += 1;
        let target = identifier(t(i))?;
        i += 1;
        let punct = |i: usize, p: &str| t(i).is_some_and(|t| t.kind == Kind::Punctuation && t.value == p);
        if !app_table(&target) || !punct(i, "(") {
            return None;
        }
        i += 1;
        identifier(t(i))?;
        i += 1;
        if !punct(i, ")") {
            return None;
        }
        i += 1;
        references = Some(target);
    }
    (i == tokens.len()).then_some(AddColumn { table, qualified, references })
}

/// An ordinary table of the main schema by that name, as SQLite spells it
/// (fixed native PRAGMAs, never a table-valued SELECT a guest could shadow).
fn ordinary_main_table(db: &Connection, name: &str, qualified: bool) -> Result<Option<String>, HostError> {
    let list = |schema: &str| -> Result<Vec<(String, String)>, HostError> {
        let mut statement = db.prepare(&format!("PRAGMA {schema}.table_list")).map_err(HostError::sqlite)?;
        let rows = statement
            .query_map([], |row| Ok((row.get::<_, String>("name")?, row.get::<_, String>("type")?)))
            .map_err(HostError::sqlite)?;
        rows.collect::<Result<_, _>>().map_err(HostError::sqlite)
    };
    if !qualified && list("temp")?.iter().any(|(n, _)| same(n, name)) {
        return Ok(None);
    }
    Ok(list("main")?
        .into_iter()
        .find(|(n, _)| same(n, name))
        .filter(|(n, kind)| kind == "table" && app_table(n) && n.chars().all(|c| (' '..='~').contains(&c)))
        .map(|(n, _)| n))
}

fn execute_statement(db: &Connection, slice: &Slice, sql: &str) -> Result<(), HostError> {
    let mut target = None;
    if let Some(add) = nullable_text_add(slice.tokens.as_ref()) {
        target = ordinary_main_table(db, &add.table, add.qualified)?;
        if target.is_some() {
            if let Some(references) = &add.references {
                if ordinary_main_table(db, references, true)?.is_none() {
                    target = None;
                }
            }
        }
    }
    let text = &sql[slice.start..slice.end];
    // The statement runs only once its authorizer is in place.
    let installed = match target {
        Some(target) => {
            let seen = Arc::new(AtomicBool::new(false));
            db.authorizer(Some(move |ctx: AuthContext<'_>| {
                let answer = migration_authorize(&ctx);
                if let AuthAction::AlterTable { database_name, table_name } = ctx.action {
                    if answer == Authorization::Allow && same(database_name, "main") && same(table_name, &target) {
                        seen.store(true, Ordering::Relaxed);
                    }
                }
                if let AuthAction::Pragma { pragma_name, pragma_value } = ctx.action {
                    if seen.load(Ordering::Relaxed)
                        && same(pragma_name, "quick_check")
                        && pragma_value.is_some_and(|v| same(v, &target))
                        && ctx.database_name.is_some_and(|d| same(d, "main"))
                        && ctx.accessor.is_none()
                    {
                        return Authorization::Allow;
                    }
                }
                answer
            }))
        }
        None => db.authorizer(Some(|ctx: AuthContext<'_>| migration_authorize(&ctx))),
    };
    installed.map_err(HostError::sqlite)?;
    let result = db.execute_batch(text);
    let cleared = clear(db);
    result.map_err(HostError::sqlite)?;
    cleared
}

/// Apply one migration file (migrations.mjs `applyMigration`).
pub fn apply(db: &Connection, sql: &str) -> Result<(), HostError> {
    if sql.len() > 1_000_000 {
        return Err(HostError::own("Migration size"));
    }
    // The first pass refuses a lexical fault anywhere before any SQL runs.
    statements(sql, false)?;
    let before = host_names(db)?;
    // A request's statement is held to 100,000 opcodes; a migration is not
    // (one INSERT of a long seed list compiles to more), and the request's
    // limit is put back.
    let _ = db.set_limit(Limit::SQLITE_LIMIT_VDBE_OP, 250_000_000);
    let result = (|| {
        for slice in statements(sql, true)? {
            execute_statement(db, &slice, sql)?;
        }
        // The authorizer sees the old name of `ALTER TABLE t RENAME TO x`,
        // never x: nothing may move into the host's `_` namespace that way.
        if host_names(db)?.iter().any(|name| !before.contains(name)) {
            return Err(HostError::own("Migration named a host-reserved table"));
        }
        Ok(())
    })();
    let cleared = clear(db);
    let _ = db.set_limit(Limit::SQLITE_LIMIT_VDBE_OP, VDBE_OP_LIMIT);
    result?;
    cleared
}
