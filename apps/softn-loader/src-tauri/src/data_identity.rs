//! Which app's saved data the page may use, decided here.
//!
//! The page that draws a bundle is the page that holds the IPC, so a call arriving here cannot
//! be told apart by who made it: the runtime's own code, or something a bundle got to run in
//! that page. Every XDB command takes the app's data id from the page, and the page keeps the
//! map from a bundle to its data in its own storage, where anything running in it can read
//! every other app's id and rewrite the map. Neither can decide whose data a call reaches.
//!
//! This side decides instead, from what it witnessed itself:
//!  - the bundle the person chose (the picker this side opens, a drop on the window, the
//!    command line, a second launch, a file opened from the file manager), and the digest of
//!    the bytes this side read from that file and handed to the page;
//!  - its own record, kept in the app's data folder where the page cannot write, of which
//!    bundle digests the person let use which app's data.
//!
//! A bundle may always use the data kept under its own digest (a new installation's data id is
//! its digest). It may use an existing installation's data only when this side's record says
//! the person allowed that digest, or when the person says so now, in a native dialog the page
//! cannot answer. The data commands then reach only the data bound here for the bundle open
//! now, whatever id the page names.
//!
//! The page's own registry (src/installations.ts) still runs the upgrade steps: staging,
//! backup, rollback, recovery. It was the only record of who owns which data until this one
//! existed, so it is imported here once, at the first start that has this record, before any
//! bundle has been read in that process: until then nothing but the runtime's own code has run
//! in the page. After that, this side refuses another import.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};
#[cfg(desktop)]
use tauri::Manager;

use crate::consent::printable;

/// This side's record of installations, in the app's data folder.
pub const REGISTRY_FILE: &str = "installations.json";
const REGISTRY_VERSION: u32 = 1;

/// One installed app's data, as this side knows it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Installation {
    /// The name its package declared when it was first opened: the author's word, shown in
    /// the question only beside what this side saw itself.
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The name of the file it was first opened from, when this side saw that file chosen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    /// Every bundle digest the person let use this data, oldest first.
    #[serde(default)]
    pub bundles: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registry {
    version: u32,
    /// True once the page's registry was imported, or could no longer be trusted because a
    /// bundle had been read before it was: either way no import is taken after it.
    page_registry_imported: bool,
    #[serde(default)]
    installations: BTreeMap<String, Installation>,
}

impl Registry {
    fn new(imported: bool) -> Self {
        Registry { version: REGISTRY_VERSION, page_registry_imported: imported, installations: BTreeMap::new() }
    }
}

/// What the import of the page's registry took over.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    /// Installations imported.
    pub imported: usize,
    /// Records left out because their data id, digests or upgrade details could not be trusted.
    pub skipped: usize,
}

/// The person's answer to the data question.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    /// Use the installed app's data.
    UseData,
    /// Open the package as a new app, with no data.
    New,
    /// Neither: nothing is opened.
    Cancel,
}

/// What the page is told the person chose, in the words of its own flow (src/upgradeFlow.ts).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Choice {
    Upgrade {
        #[serde(rename = "dataId")]
        data_id: String,
    },
    New,
    Cancel,
}

/// A data question to put to the person: whether the bundle open now may use `target`'s data.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    opened: u64,
    digest: String,
    target: String,
    /// Whether a yes also starts the app on that data (see `Open::started`).
    start: bool,
    /// Whether "open as a new app" is one of the answers.
    pub offer_new: bool,
    pub title: String,
    pub text: String,
}

/// The first step of a decision: settled from what is known, or a question to put.
#[derive(Debug)]
pub enum Step<T> {
    Settled(T),
    Ask(Question),
}

/// The bundle the person chose most recently, and what has been decided for it.
#[derive(Default)]
struct Open {
    /// Counts the person's choices. An answer belongs to the choice it was asked under.
    opened: u64,
    /// The file, as chosen and in its one spelling on disk.
    chosen: Option<(PathBuf, PathBuf)>,
    /// The digest of the bytes this side read from that file and handed to the page.
    digest: Option<String>,
    /// The one data question put for this choice, and its answer.
    asked: Option<(String, Answer)>,
    /// The data the app was started on: bound by the runtime just before it hands the page
    /// to the bundle. From then on, for this choice, no other data is bound and no question
    /// is put, whatever the page asks: what runs in it now may be the bundle's.
    started: Option<String>,
}

struct State {
    registry: Registry,
    open: Open,
    /// The data id the data commands use now. It stays bound across a choice until the next
    /// bundle binds its own, so a write the previous app had in flight is not lost; from then
    /// on that app's calls are refused rather than landing in the new app's data.
    bound: Option<String>,
    /// A bundle's bytes have reached the page in this process (or a data identity was bound):
    /// from here on the page's registry is not taken as the runtime's word.
    page_ran_bundle: bool,
}

pub struct DataIdentity {
    file: PathBuf,
    state: Mutex<State>,
    /// Held while a question is on screen, so calls that arrive together wait for its answer.
    asking: tauri::async_runtime::Mutex<()>,
}

const ANOTHER_APP_OPENED: &str = "another app was opened while the question was on screen";

/// `bundle-` and the 64 lowercase hex digits of a SHA-256: what a digest and a data id look like.
pub fn is_bundle_id(text: &str) -> bool {
    text.strip_prefix("bundle-")
        .is_some_and(|hex| hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// The digest the page computes for the same bytes (src/bundleFile.ts, computeBundleAppId).
pub fn bundle_digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut text = String::with_capacity(7 + 64);
    text.push_str("bundle-");
    for byte in digest {
        text.push_str(&format!("{:02x}", byte));
    }
    text
}

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

impl DataIdentity {
    /// The record in `directory` (the app's data folder). A record that cannot be read is
    /// moved aside, not overwritten, and the runtime starts again from the data folders on
    /// disk (`recovered`), taking no import: the page's registry may have been changed by a
    /// bundle since the first start.
    pub fn open(directory: &Path) -> Self {
        let file = directory.join(REGISTRY_FILE);
        let registry = match std::fs::read(&file) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Registry::new(false),
            Ok(bytes) => match serde_json::from_slice::<Registry>(&bytes) {
                Ok(registry) if registry.version == REGISTRY_VERSION => registry,
                outcome => {
                    let reason = match outcome {
                        Err(error) => error.to_string(),
                        Ok(registry) => format!("unknown version {}", registry.version),
                    };
                    Self::set_aside(&file, &reason);
                    Self::recovered(directory)
                }
            },
            Err(error) => {
                tracing::error!("The installation record {} could not be read ({}); starting without it", file.display(), error);
                Self::recovered(directory)
            }
        };
        let identity = DataIdentity {
            file,
            state: Mutex::new(State { registry, open: Open::default(), bound: None, page_ran_bundle: false }),
            asking: tauri::async_runtime::Mutex::new(()),
        };
        if let Ok(state) = identity.state.lock() {
            if !identity.file.exists() && state.registry.page_registry_imported {
                let _ = identity.save(&state.registry);
            }
        }
        identity
    }

    /// A record rebuilt from the databases on disk: every app's data folder under `apps/`
    /// named by a digest is an installation that digest opens. Which other digests the person
    /// let use it is lost with the record; each is asked about again when it is opened.
    fn recovered(directory: &Path) -> Registry {
        let mut registry = Registry::new(true);
        if let Ok(entries) = std::fs::read_dir(directory.join("apps")) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if is_bundle_id(&name) && entry.path().is_dir() {
                    registry.installations.insert(name.clone(), Installation { bundles: vec![name], ..Installation::default() });
                }
            }
        }
        registry
    }

    fn set_aside(file: &Path, reason: &str) {
        let aside = file.with_extension(format!("json.damaged-{:x}", now_millis()));
        match std::fs::rename(file, &aside) {
            Ok(()) => tracing::error!("The installation record could not be read ({}); kept as {}", reason, aside.display()),
            Err(error) => tracing::error!("The installation record could not be read ({}) or moved aside ({})", reason, error),
        }
    }

    /// Write the record whole, through a temporary file, so a failed write leaves the old one.
    fn save(&self, registry: &Registry) -> Result<(), String> {
        let text = serde_json::to_vec_pretty(registry).map_err(|e| e.to_string())?;
        if let Some(parent) = self.file.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let temporary = self.file.with_extension("json.tmp");
        std::fs::write(&temporary, text).map_err(|e| e.to_string())?;
        std::fs::rename(&temporary, &self.file).map_err(|e| e.to_string())
    }

    fn save_logged(&self, registry: &Registry) {
        if let Err(error) = self.save(registry) {
            tracing::error!("The installation record could not be saved: {}", error);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// From now on nothing the page says about installations is taken as the runtime's word.
    fn page_ran_bundle(&self, state: &mut State) {
        state.page_ran_bundle = true;
        if !state.registry.page_registry_imported {
            state.registry.page_registry_imported = true;
            self.save_logged(&state.registry);
        }
    }

    /// The person chose a bundle (see consent.rs for where): what was decided for the one
    /// before is forgotten, except the data still bound until this one binds its own.
    pub fn bundle_chosen(&self, path: &Path) {
        let mut state = self.lock();
        state.open.opened += 1;
        state.open.chosen = Some((path.to_path_buf(), crate::canonical(path)));
        state.open.digest = None;
        state.open.asked = None;
        state.open.started = None;
    }

    /// The page was handed `bytes` read from `path`. When that is the file the person chose,
    /// their digest is the identity of the bundle open now.
    pub fn bundle_read(&self, path: &Path, bytes: &[u8]) {
        let mut state = self.lock();
        self.page_ran_bundle(&mut state);
        let chosen = state.open.chosen.as_ref().is_some_and(|(as_chosen, on_disk)| {
            path == as_chosen || (crate::is_on_this_machine(path) && crate::canonical(path) == *on_disk)
        });
        if !chosen {
            return;
        }
        let digest = bundle_digest(bytes);
        if state.open.digest.as_deref() != Some(digest.as_str()) && state.open.started.is_none() {
            // The file changed since it was read: what was asked about the old bytes does not
            // carry over. Once the app has started, the open stays the bundle it started as,
            // and other bytes from the same file are refused as "not the app that was opened".
            state.open.digest = Some(digest);
            state.open.asked = None;
        }
    }

    /// Bundle bytes reached the page by some other way than the chosen file (Android's cache).
    pub fn bundle_handed_over(&self) {
        let mut state = self.lock();
        self.page_ran_bundle(&mut state);
    }

    /// The data id a data command may use: the one bound for the bundle open now, and only when
    /// the page named that one.
    pub fn require(&self, app_id: Option<&str>) -> Result<String, String> {
        let state = self.lock();
        match (&state.bound, app_id) {
            (Some(bound), Some(named)) if bound == named => Ok(bound.clone()),
            (None, _) => Err("No app's data is open: open the app first".to_string()),
            _ => Err("Refused: this call names the data of an app that is not the one open now".to_string()),
        }
    }

    /// The data id bound now, if any.
    pub fn bound(&self) -> Option<String> {
        self.lock().bound.clone()
    }

    /// Take over the page's registry, once, before any bundle has run in the page.
    /// `raw` is the stored text of `softn-loader:installations` (src/installations.ts), or
    /// nothing when the page has none.
    pub fn import_page_registry(&self, raw: Option<&str>) -> Result<ImportSummary, String> {
        let mut state = self.lock();
        if state.page_ran_bundle {
            return Err("An app was opened before the installation records were imported, so they are not taken from the page now".to_string());
        }
        if state.registry.page_registry_imported {
            return Err("The installation records are no longer taken from the page: they were imported at an earlier start, or an app was opened before they could be".to_string());
        }
        let (installations, summary) = parse_page_registry(raw);
        for (data_id, installation) in installations {
            let entry = state.registry.installations.entry(data_id).or_default();
            if entry.name.is_empty() {
                entry.name = installation.name;
            }
            if entry.version.is_none() {
                entry.version = installation.version;
            }
            for digest in installation.bundles {
                if !entry.bundles.contains(&digest) {
                    entry.bundles.push(digest);
                }
            }
        }
        state.registry.page_registry_imported = true;
        // Kept in memory even when the write fails, so this run still opens its apps; the
        // next save that succeeds writes the import with it.
        self.save(&state.registry)?;
        Ok(summary)
    }

    fn installation_ids_for(state: &State, digest: &str) -> Vec<String> {
        state
            .registry
            .installations
            .iter()
            .filter(|(_, installation)| installation.bundles.iter().any(|d| d == digest))
            .map(|(id, _)| id.clone())
            .collect()
    }

    fn allowed(state: &State, digest: &str, data_id: &str) -> bool {
        data_id == digest
            || state.registry.installations.get(data_id).is_some_and(|installation| installation.bundles.iter().any(|d| d == digest))
    }

    /// The digest of the bundle open now, when it is `bundle_id`.
    fn open_digest(state: &State, bundle_id: &str) -> Result<String, String> {
        match &state.open.digest {
            Some(digest) if digest == bundle_id => Ok(digest.clone()),
            Some(_) => Err("This is not the app that was opened, or its file changed since: open it again".to_string()),
            None => Err("No app was opened through SoftN: use Open, drop the file onto the window, or open it from your file manager".to_string()),
        }
    }

    fn bind(state: &mut State, data_id: &str, start: bool) {
        state.page_ran_bundle = true;
        state.bound = Some(data_id.to_string());
        if start {
            state.open.started = Some(data_id.to_string());
        }
    }

    fn started_refusal(state: &State, data_id: Option<&str>) -> Option<String> {
        match (&state.open.started, data_id) {
            (Some(started), Some(data_id)) if started == data_id => None,
            (Some(_), _) => Some("Refused: this app is already running on its data, and that is not changed while it runs. Open the file again to choose afresh.".to_string()),
            (None, _) => None,
        }
    }

    fn question(state: &State, digest: &str, target: &str, offer_new: bool, start: bool) -> Question {
        let installation = state.registry.installations.get(target).cloned().unwrap_or_default();
        let name = if installation.name.trim().is_empty() {
            "an app you opened before".to_string()
        } else {
            format!("\"{}\"", printable(installation.name.trim()))
        };
        let opened = match state.open.chosen.as_ref().and_then(|(path, _)| path.file_name()) {
            Some(file) => format!("You opened \"{}\".", printable(&file.to_string_lossy())),
            None => "You opened a file.".to_string(),
        };
        let mut details = Vec::new();
        if let Some(version) = installation.version.as_deref().filter(|v| !v.trim().is_empty()) {
            details.push(format!("version {}", printable(version.trim())));
        }
        if let Some(file) = installation.file.as_deref() {
            details.push(format!("first opened from \"{}\"", printable(file)));
        }
        let details = if details.is_empty() { String::new() } else { format!(" ({})", details.join(", ")) };
        let other = if offer_new {
            "\"Open as a new app\" starts this file with no data and leaves the data you have as it is."
        } else {
            "\"Don't open\" leaves everything as it is."
        };
        Question {
            opened: state.open.opened,
            digest: digest.to_string(),
            target: target.to_string(),
            start,
            offer_new,
            title: "Use the data you already have?".to_string(),
            text: format!(
                "Open the new version of {name} with the data of the version you had?\n\n{opened} SoftN has data saved by {name}{details}.\n\nChoose \"Use my data\" only if this file is a newer version of that same app and you trust where it came from: it will be able to read and change everything {name} saved. {other}"
            ),
        }
    }

    /// The bundle open now (`bundle_id`, as the page computed it) asks to use `data_id`'s data.
    /// Its own data id needs nothing; an installation the person let it use needs nothing; any
    /// other installation is a question, put once for this choice. `start` is the runtime's
    /// last bind before it starts the app: after it, this open binds nothing else.
    pub fn prepare_bind(&self, bundle_id: &str, data_id: &str, name: Option<&str>, version: Option<&str>, start: bool) -> Result<Step<()>, String> {
        let mut state = self.lock();
        let digest = Self::open_digest(&state, bundle_id)?;
        if let Some(refusal) = Self::started_refusal(&state, Some(data_id)) {
            return Err(refusal);
        }
        if data_id == digest {
            let file = state.open.chosen.as_ref().and_then(|(path, _)| path.file_name()).map(|f| f.to_string_lossy().to_string());
            if !state.registry.installations.contains_key(&digest) && Self::installation_ids_for(&state, &digest).is_empty() {
                state.registry.installations.insert(
                    digest.clone(),
                    Installation {
                        name: name.unwrap_or("").to_string(),
                        version: version.map(str::to_string),
                        file,
                        bundles: vec![digest.clone()],
                    },
                );
                state.registry.page_registry_imported = true;
                self.save_logged(&state.registry);
            }
            Self::bind(&mut state, data_id, start);
            return Ok(Step::Settled(()));
        }
        if Self::allowed(&state, &digest, data_id) {
            Self::bind(&mut state, data_id, start);
            return Ok(Step::Settled(()));
        }
        if !state.registry.installations.contains_key(data_id) {
            return Err("No installed app has that data".to_string());
        }
        if state.open.asked.is_some() {
            return Err("You were already asked about this app's data; it is not asked twice. Open the app again to be asked afresh.".to_string());
        }
        Ok(Step::Ask(Self::question(&state, &digest, data_id, false, start)))
    }

    /// The bundle open now is not mapped to any data, and installations share its name. Which
    /// of them (the first of `candidates` this side knows) may it use, if any?
    pub fn prepare_choose(&self, bundle_id: &str, candidates: &[String]) -> Result<Step<Choice>, String> {
        let state = self.lock();
        let digest = Self::open_digest(&state, bundle_id)?;
        if let Some(refusal) = Self::started_refusal(&state, None) {
            return Err(refusal);
        }
        if let Some((target, answer)) = &state.open.asked {
            return Ok(Step::Settled(match answer {
                Answer::UseData => Choice::Upgrade { data_id: target.clone() },
                Answer::New => Choice::New,
                Answer::Cancel => Choice::Cancel,
            }));
        }
        let target = candidates.iter().find(|id| **id != digest && state.registry.installations.contains_key(id.as_str()));
        match target {
            None => Ok(Step::Settled(Choice::New)),
            Some(target) => Ok(Step::Ask(Self::question(&state, &digest, target, true, false))),
        }
    }

    /// Record the person's answer to `question`. "Use my data" lets this bundle use that data
    /// from now on, and binds it. "Open as a new app" takes back an earlier yes for this
    /// bundle and that data, so the latest answer is the one that stands.
    pub fn record(&self, question: &Question, answer: Answer) -> Result<Choice, String> {
        let mut state = self.lock();
        if state.open.opened != question.opened || state.open.digest.as_deref() != Some(question.digest.as_str()) {
            return Err(format!("Nothing was opened: {}", ANOTHER_APP_OPENED));
        }
        if let Some(refusal) = Self::started_refusal(&state, Some(&question.target)) {
            return Err(refusal);
        }
        state.open.asked = Some((question.target.clone(), answer));
        match answer {
            Answer::UseData => {
                let digest = question.digest.clone();
                let Some(installation) = state.registry.installations.get_mut(&question.target) else {
                    return Err("No installed app has that data".to_string());
                };
                if !installation.bundles.contains(&digest) {
                    installation.bundles.push(digest);
                }
                state.registry.page_registry_imported = true;
                self.save_logged(&state.registry);
                Self::bind(&mut state, &question.target, question.start);
                Ok(Choice::Upgrade { data_id: question.target.clone() })
            }
            Answer::New => {
                let digest = question.digest.clone();
                if let Some(installation) = state.registry.installations.get_mut(&question.target) {
                    if question.target != digest && installation.bundles.contains(&digest) {
                        installation.bundles.retain(|d| *d != digest);
                        self.save_logged(&state.registry);
                    }
                }
                Ok(Choice::New)
            }
            Answer::Cancel => Ok(Choice::Cancel),
        }
    }

    /// `prepare_bind`, the question and `record`, with the dialog replaced by `ask`.
    #[cfg(test)]
    pub fn decide_bind(&self, bundle_id: &str, data_id: &str, ask: impl FnOnce(&Question) -> Answer) -> Result<(), String> {
        self.decide_bind_for(bundle_id, data_id, false, ask)
    }

    /// `decide_bind`, as the bind that starts the app (`start`) or one before it.
    #[cfg(test)]
    pub fn decide_bind_for(&self, bundle_id: &str, data_id: &str, start: bool, ask: impl FnOnce(&Question) -> Answer) -> Result<(), String> {
        match self.prepare_bind(bundle_id, data_id, None, None, start)? {
            Step::Settled(()) => Ok(()),
            Step::Ask(question) => bind_outcome(self.record(&question, ask(&question))?),
        }
    }

    /// `prepare_choose`, the question and `record`, with the dialog replaced by `ask`.
    #[cfg(test)]
    pub fn decide_choose(&self, bundle_id: &str, candidates: &[String], ask: impl FnOnce(&Question) -> Answer) -> Result<Choice, String> {
        match self.prepare_choose(bundle_id, candidates)? {
            Step::Settled(choice) => Ok(choice),
            Step::Ask(question) => self.record(&question, ask(&question)),
        }
    }

    /// Bind `data_id` for the bundle open now, asking the person in a native dialog when it is
    /// another installation's data they have not let this bundle use.
    pub async fn require_bind(&self, app: &tauri::AppHandle, bundle_id: &str, data_id: &str, name: Option<&str>, version: Option<&str>, start: bool) -> Result<(), String> {
        let _turn = self.asking.lock().await;
        match self.prepare_bind(bundle_id, data_id, name, version, start)? {
            Step::Settled(()) => Ok(()),
            Step::Ask(question) => {
                let answer = ask(app, &question).await;
                bind_outcome(self.record(&question, answer)?)
            }
        }
    }

    /// Put the upgrade question for the bundle open now, in a native dialog.
    pub async fn require_choice(&self, app: &tauri::AppHandle, bundle_id: &str, candidates: &[String]) -> Result<Choice, String> {
        let _turn = self.asking.lock().await;
        match self.prepare_choose(bundle_id, candidates)? {
            Step::Settled(choice) => Ok(choice),
            Step::Ask(question) => {
                let answer = ask(app, &question).await;
                self.record(&question, answer)
            }
        }
    }
}

fn bind_outcome(choice: Choice) -> Result<(), String> {
    match choice {
        Choice::Upgrade { .. } => Ok(()),
        _ => Err("Not opened: you chose not to open this app with that data".to_string()),
    }
}

/// Put a data question in a native dialog over the main window. A dialog that cannot be shown
/// is a cancel.
async fn ask(app: &tauri::AppHandle, question: &Question) -> Answer {
    let app = app.clone();
    let question = question.clone();
    const USE: &str = "Use my data";
    const NEW: &str = "Open as a new app";
    const CANCEL: &str = "Cancel";
    const DONT: &str = "Don't open";
    // Blocking, hence off the async runtime's own threads and never on the main one.
    tauri::async_runtime::spawn_blocking(move || {
        let buttons = if question.offer_new {
            MessageDialogButtons::YesNoCancelCustom(USE.to_string(), NEW.to_string(), CANCEL.to_string())
        } else {
            MessageDialogButtons::OkCancelCustom(USE.to_string(), DONT.to_string())
        };
        let dialog = app
            .dialog()
            .message(question.text.clone())
            .title(question.title.clone())
            .kind(MessageDialogKind::Warning)
            .buttons(buttons);
        #[cfg(desktop)]
        let dialog = match app.get_webview_window("main") {
            Some(window) => dialog.parent(&window),
            None => dialog,
        };
        answer_from(dialog.blocking_show_with_result(), question.offer_new)
    })
    .await
    .unwrap_or(Answer::Cancel)
}

/// The platforms report a custom button by its label or by its place.
fn answer_from(result: MessageDialogResult, offer_new: bool) -> Answer {
    match result {
        MessageDialogResult::Yes | MessageDialogResult::Ok => Answer::UseData,
        MessageDialogResult::No if offer_new => Answer::New,
        MessageDialogResult::Custom(label) if label == "Use my data" => Answer::UseData,
        MessageDialogResult::Custom(label) if offer_new && label == "Open as a new app" => Answer::New,
        _ => Answer::Cancel,
    }
}

/// The installations in the page's registry (src/installations.ts, `softn-loader:installations`)
/// that can be trusted, held to the same rules the page holds them to (`validateRecord`): the
/// data id is the record's key, the bundle mapping is a list of digests, and upgrade or
/// recovery details, when present, are whole. A record failing any of these is damaged there
/// and left out here; the page keeps it quarantined and asks the person about it.
fn parse_page_registry(raw: Option<&str>) -> (Vec<(String, Installation)>, ImportSummary) {
    let mut summary = ImportSummary { imported: 0, skipped: 0 };
    let Some(raw) = raw.filter(|text| !text.trim().is_empty()) else {
        return (Vec::new(), summary);
    };
    let parsed: serde_json::Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(_) => return (Vec::new(), summary),
    };
    let records = match (parsed.get("version").and_then(|v| v.as_u64()), parsed.get("installations").and_then(|v| v.as_object())) {
        (Some(1), Some(records)) => records,
        _ => return (Vec::new(), summary),
    };
    let text = |value: Option<&serde_json::Value>| value.and_then(|v| v.as_str()).map(str::to_string);
    let mut installations = Vec::new();
    for (key, record) in records {
        let trusted = (|| {
            let record = record.as_object()?;
            if record.get("dataId").and_then(|v| v.as_str()) != Some(key.as_str()) || !is_bundle_id(key) {
                return None;
            }
            let mut bundles = Vec::new();
            for digest in record.get("bundleIds")?.as_array()? {
                let digest = digest.as_str().filter(|d| is_bundle_id(d))?;
                if !bundles.iter().any(|d: &String| d == digest) {
                    bundles.push(digest.to_string());
                }
            }
            match record.get("pendingUpgrade") {
                None | Some(serde_json::Value::Null) => {}
                Some(pending) => {
                    let pending = pending.as_object()?;
                    let to = pending.get("to")?.as_str().filter(|d| is_bundle_id(d))?;
                    pending.get("backup")?.as_str().filter(|b| !b.is_empty())?;
                    match pending.get("from") {
                        Some(serde_json::Value::Null) => {}
                        Some(from) => {
                            from.as_str()?;
                        }
                        None => return None,
                    }
                    // The person approved this upgrade in the page before this record existed;
                    // the page resumes it with the same backup when the new package is opened.
                    if !bundles.iter().any(|d| d == to) {
                        bundles.push(to.to_string());
                    }
                }
            }
            match record.get("recoveryRequired") {
                None | Some(serde_json::Value::Null) => {}
                Some(marker) => {
                    let marker = marker.as_object()?;
                    marker.get("backup")?.as_str()?;
                    marker.get("reason")?.as_str()?;
                }
            }
            Some(Installation {
                name: text(record.get("name")).unwrap_or_default(),
                version: text(record.get("version")),
                file: None,
                bundles,
            })
        })();
        match trusted {
            Some(installation) => {
                summary.imported += 1;
                installations.push((key.clone(), installation));
            }
            None => summary.skipped += 1,
        }
    }
    (installations, summary)
}

#[cfg(test)]
mod tests;
