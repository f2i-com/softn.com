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

/// The digest the page computes for the same bytes (src/bundleRuntime.ts, computeBundleAppId).
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
mod tests {
    use super::*;
    use std::cell::RefCell;

    const A1: &str = "bundle-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    struct Folder(PathBuf);
    impl Folder {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("softn-loader-identity-{}-{}", name, std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Folder(dir)
        }
        fn stored(&self) -> serde_json::Value {
            serde_json::from_slice(&std::fs::read(self.0.join(REGISTRY_FILE)).unwrap()).unwrap()
        }
    }
    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// The person chooses `file` and the page reads `bytes` from it; the digest is returned.
    fn open(identity: &DataIdentity, file: &str, bytes: &[u8]) -> String {
        let path = PathBuf::from(file);
        identity.bundle_chosen(&path);
        identity.bundle_read(&path, bytes);
        bundle_digest(bytes)
    }

    /// As `open`, for a digest given outright (the imported registry's are made up).
    fn opened_with_digest(identity: &DataIdentity, file: &str, digest: &str) {
        identity.bundle_chosen(Path::new(file));
        let mut state = identity.lock();
        state.page_ran_bundle = true;
        state.open.digest = Some(digest.to_string());
    }

    fn never(_: &Question) -> Answer {
        panic!("a question was put")
    }

    #[test]
    fn the_digest_is_the_one_the_page_computes() {
        // SHA-256 of "abc", as `crypto.subtle.digest` gives it.
        assert_eq!(bundle_digest(b"abc"), "bundle-ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert!(is_bundle_id(&bundle_digest(b"")));
        for id in ["_default", "", "bundle-", "bundle-ABC", "../apps/bundle-x", &format!("{}0", A1), &A1.to_uppercase()] {
            assert!(!is_bundle_id(id), "{:?}", id);
        }
    }

    #[test]
    fn a_bundle_uses_its_own_data_unasked_and_nothing_else_without_a_yes() {
        let folder = Folder::new("own");
        let identity = DataIdentity::open(&folder.0);
        let a = open(&identity, "notes.softn", b"notes v1");
        assert_eq!(identity.decide_bind(&a, &a, never), Ok(()));
        assert_eq!(identity.require(Some(&a)), Ok(a.clone()));
        // Recorded as an installation this side knows, with the file it was opened from.
        assert_eq!(folder.stored()["installations"][&a]["file"], "notes.softn");

        let b = open(&identity, "funny-cats.softn", b"something else");
        // A had been bound and stays bound until B binds: A's last writes still land in A.
        assert_eq!(identity.require(Some(&a)), Ok(a.clone()));
        let asked = RefCell::new(0);
        let refused = identity.decide_bind(&b, &a, |question| {
            *asked.borrow_mut() += 1;
            assert!(question.text.contains("funny-cats.softn"), "{}", question.text);
            Answer::Cancel
        });
        assert!(refused.is_err());
        assert_eq!(*asked.borrow(), 1);
        // Asking again and again does not raise the dialog again.
        assert!(identity.decide_bind(&b, &a, never).is_err());
        assert_eq!(identity.decide_bind(&b, &b, never), Ok(()));
        assert!(identity.require(Some(&a)).is_err(), "B is open now; A's id is refused");
        assert_eq!(identity.require(Some(&b)), Ok(b.clone()));
    }

    #[test]
    fn a_data_call_must_name_the_data_bound_now() {
        let folder = Folder::new("require");
        let identity = DataIdentity::open(&folder.0);
        assert!(identity.require(Some(A1)).is_err(), "nothing bound yet");
        let a = open(&identity, "a.softn", b"a");
        identity.decide_bind(&a, &a, never).unwrap();
        assert!(identity.require(None).is_err(), "no id is the shared default database, not this app's");
        assert!(identity.require(Some("")).is_err());
        assert!(identity.require(Some(A1)).is_err());
        assert!(identity.require(Some(&format!(" {}", a))).is_err());
        assert_eq!(identity.require(Some(&a)), Ok(a));
    }

    #[test]
    fn only_the_bytes_of_the_chosen_file_are_the_open_bundle() {
        let folder = Folder::new("chosen");
        let identity = DataIdentity::open(&folder.0);
        let a = open(&identity, "a.softn", b"a");
        identity.decide_bind(&a, &a, never).unwrap();
        identity.bundle_chosen(Path::new("b.softn"));
        // The page reads A again (it was opened before, so it may) and asks to bind it.
        identity.bundle_read(Path::new("a.softn"), b"a");
        assert!(identity.decide_bind(&a, &a, never).unwrap_err().contains("No app was opened"));
        identity.bundle_read(Path::new("b.softn"), b"b");
        assert!(identity.decide_bind(&a, &a, never).unwrap_err().contains("not the app that was opened"));
        let b = bundle_digest(b"b");
        assert_eq!(identity.decide_bind(&b, &b, never), Ok(()));
        // The same file read again with other bytes is another bundle.
        identity.bundle_read(Path::new("b.softn"), b"b changed");
        assert!(identity.decide_bind(&b, &b, never).is_err());
    }

    #[test]
    fn an_upgrade_is_the_persons_yes_in_the_native_question_and_it_is_kept() {
        let folder = Folder::new("upgrade");
        let identity = DataIdentity::open(&folder.0);
        let v1 = open(&identity, r"C:\Apps\notes-1.softn", b"notes 1");
        identity.prepare_bind(&v1, &v1, Some("Notes"), Some("1.0"), false).unwrap();
        let v2 = open(&identity, r"C:\Apps\notes-2.softn", b"notes 2");
        let text = RefCell::new(String::new());
        let choice = identity.decide_choose(&v2, &[v1.clone()], |question| {
            *text.borrow_mut() = format!("{}\n{}", question.title, question.text);
            assert!(question.offer_new);
            Answer::UseData
        });
        assert_eq!(choice, Ok(Choice::Upgrade { data_id: v1.clone() }));
        let text = text.into_inner();
        assert!(text.contains("Open the new version of \"Notes\" with the data of the version you had?"), "{}", text);
        assert!(text.contains("notes-2.softn") && text.contains("version 1.0") && text.contains("notes-1.softn"), "{}", text);
        assert_eq!(identity.bound(), Some(v1.clone()));
        // The page's flow binds again before its backup and before it starts the app: no question.
        assert_eq!(identity.decide_bind(&v2, &v1, never), Ok(()));
        // The same question asked again in this open is answered as before, unasked.
        assert_eq!(identity.decide_choose(&v2, &[v1.clone()], never), Ok(Choice::Upgrade { data_id: v1.clone() }));

        // Kept: a later run opens the new version on that data without asking.
        drop(identity);
        let identity = DataIdentity::open(&folder.0);
        let again = open(&identity, r"C:\Apps\notes-2.softn", b"notes 2");
        assert_eq!(identity.decide_bind(&again, &v1, never), Ok(()));
        // And the old version still reaches it too.
        let old = open(&identity, r"C:\Apps\notes-1.softn", b"notes 1");
        assert_eq!(identity.decide_bind(&old, &v1, never), Ok(()));
    }

    #[test]
    fn open_as_new_and_cancel_bind_nothing_of_the_installed_app() {
        let folder = Folder::new("new");
        let identity = DataIdentity::open(&folder.0);
        let v1 = open(&identity, "notes.softn", b"1");
        identity.decide_bind(&v1, &v1, never).unwrap();
        let other = open(&identity, "notes-copy.softn", b"2");
        assert_eq!(identity.decide_choose(&other, &[v1.clone()], |_| Answer::New), Ok(Choice::New));
        assert!(identity.decide_bind(&other, &v1, never).is_err(), "a no stands for this open");
        assert_eq!(identity.decide_bind(&other, &other, never), Ok(()));
        let third = open(&identity, "notes-3.softn", b"3");
        assert_eq!(identity.decide_choose(&third, &[v1.clone()], |_| Answer::Cancel), Ok(Choice::Cancel));
        assert_eq!(identity.bound(), Some(other.clone()), "nothing new was bound");
        // Choosing the file again asks afresh.
        let third = open(&identity, "notes-3.softn", b"3");
        assert_eq!(identity.decide_choose(&third, &[v1.clone()], |_| Answer::UseData), Ok(Choice::Upgrade { data_id: v1 }));
    }

    #[test]
    fn a_candidate_this_side_does_not_know_is_not_offered() {
        let folder = Folder::new("unknown");
        let identity = DataIdentity::open(&folder.0);
        let b = open(&identity, "b.softn", b"b");
        // The page names data ids it read from its registry; only installations recorded here
        // are offered, and the bundle's own id is not an upgrade of itself.
        assert_eq!(identity.decide_choose(&b, &[A1.to_string(), b.clone()], never), Ok(Choice::New));
        assert!(identity.decide_bind(&b, A1, never).unwrap_err().contains("No installed app"));
        assert!(identity.decide_bind(&b, "_default", never).is_err());
    }

    #[test]
    fn an_answer_given_while_another_file_was_chosen_counts_for_neither() {
        let folder = Folder::new("race");
        let identity = DataIdentity::open(&folder.0);
        let v1 = open(&identity, "v1.softn", b"1");
        identity.decide_bind(&v1, &v1, never).unwrap();
        let v2 = open(&identity, "v2.softn", b"2");
        let outcome = identity.decide_choose(&v2, &[v1.clone()], |_| {
            open(&identity, "v3.softn", b"3");
            Answer::UseData
        });
        assert!(outcome.unwrap_err().contains("another app was opened"));
        assert_eq!(identity.bound(), Some(v1.clone()));
        assert!(!folder.stored()["installations"][&v1]["bundles"].as_array().unwrap().iter().any(|d| d == &serde_json::json!(v2)));
    }

    /// The page's registry as src/installations.ts writes it today: an installation, an
    /// upgrade completed in the page, an upgrade approved but not yet started, a record in
    /// recovery, and damaged records.
    fn todays_registry() -> (String, [String; 7]) {
        let d = |c: char| format!("bundle-{}", c.to_string().repeat(64));
        let (notes, notes2, todo, todo2, cards, bad, lone) = (d('1'), d('2'), d('3'), d('4'), d('5'), d('6'), d('7'));
        let registry = serde_json::json!({
            "version": 1,
            "revision": 7,
            "installations": {
                notes.clone(): {
                    "dataId": notes, "name": "Notes", "bundleIds": [notes, notes2], "version": "2.0",
                    "createdAt": "2026-09-01T00:00:00.000Z", "updatedAt": "2026-09-14T00:00:00.000Z",
                    "ledger": [{ "from": null, "to": notes, "at": "2026-09-01T00:00:00.000Z" }, { "from": notes, "to": notes2, "at": "2026-09-14T00:00:00.000Z", "backup": "C:/x/pre-upgrade-1.sqlite" }]
                },
                todo.clone(): {
                    "dataId": todo, "name": "Todo", "bundleIds": [todo],
                    "createdAt": "2026-09-01T00:00:00.000Z", "updatedAt": "2026-09-01T00:00:00.000Z", "ledger": [],
                    "pendingUpgrade": { "from": todo, "to": todo2, "backup": "C:/x/pre-upgrade-2.sqlite", "at": "2026-09-20T00:00:00.000Z" }
                },
                cards.clone(): {
                    "dataId": cards, "name": "Cards", "bundleIds": [cards],
                    "recoveryRequired": { "backup": "C:/x/pre-upgrade-3.sqlite", "reason": "disk full", "at": "2026-09-21T00:00:00.000Z" }
                },
                // Damaged: the data id does not match its key.
                bad.clone(): { "dataId": lone, "name": "Bad", "bundleIds": [bad] },
                // Damaged: the mapping is not a list of digests.
                lone.clone(): { "dataId": lone, "name": "Lone", "bundleIds": "everything" },
                // Damaged: a key that is not a digest, which would name the shared database.
                "_default": { "dataId": "_default", "name": "Default", "bundleIds": [lone] }
            }
        });
        (registry.to_string(), [notes, notes2, todo, todo2, cards, bad, lone])
    }

    #[test]
    fn the_page_registry_is_imported_once_in_todays_shape() {
        let folder = Folder::new("import");
        let identity = DataIdentity::open(&folder.0);
        let (raw, [notes, notes2, todo, todo2, cards, bad, lone]) = todays_registry();
        assert_eq!(identity.import_page_registry(Some(&raw)), Ok(ImportSummary { imported: 3, skipped: 3 }));
        let stored = folder.stored();
        assert_eq!(stored["pageRegistryImported"], true);
        assert_eq!(stored["installations"][&notes]["bundles"], serde_json::json!([notes, notes2]));
        assert_eq!(stored["installations"][&notes]["name"], "Notes");
        // An upgrade the person approved in the page and that has not started yet resumes.
        assert_eq!(stored["installations"][&todo]["bundles"], serde_json::json!([todo, todo2]));
        assert_eq!(stored["installations"][&cards]["bundles"], serde_json::json!([cards]));
        for left_out in [&bad, &lone, &"_default".to_string()] {
            assert!(stored["installations"].get(left_out.as_str()).is_none(), "{} was imported", left_out);
        }

        // What was imported opens as before, unasked: both versions of Notes reach Notes' data,
        // and the approved Todo upgrade reaches Todo's.
        opened_with_digest(&identity, "notes-2.softn", &notes2);
        assert_eq!(identity.decide_bind(&notes2, &notes, never), Ok(()));
        opened_with_digest(&identity, "notes-1.softn", &notes);
        assert_eq!(identity.decide_bind(&notes, &notes, never), Ok(()));
        opened_with_digest(&identity, "todo-2.softn", &todo2);
        assert_eq!(identity.decide_bind(&todo2, &todo, never), Ok(()));
        // The damaged records gave nothing: the bundle they named gets only its own data.
        opened_with_digest(&identity, "bad.softn", &bad);
        assert!(identity.decide_bind(&bad, &lone, never).is_err());
        assert_eq!(identity.decide_bind(&bad, &bad, never), Ok(()));

        // Never again, in this run or the next.
        assert!(identity.import_page_registry(Some(&raw)).is_err());
        drop(identity);
        let identity = DataIdentity::open(&folder.0);
        assert!(identity.import_page_registry(Some(&raw)).unwrap_err().contains("no longer taken from the page"));
    }

    #[test]
    fn no_import_after_a_bundle_reached_the_page() {
        let (raw, _) = todays_registry();
        // A bundle read in this run, then an import.
        let folder = Folder::new("late-import");
        let identity = DataIdentity::open(&folder.0);
        identity.bundle_chosen(Path::new("x.softn"));
        assert!(identity.import_page_registry(Some(&raw)).is_ok(), "chosen but not yet read: the page has run nothing");
        let folder = Folder::new("late-import-2");
        let identity = DataIdentity::open(&folder.0);
        open(&identity, "x.softn", b"x");
        assert!(identity.import_page_registry(Some(&raw)).unwrap_err().contains("before the installation records were imported"));
        // And not in the next run either: the record says so.
        drop(identity);
        let identity = DataIdentity::open(&folder.0);
        assert!(identity.import_page_registry(Some(&raw)).is_err());
        // Bytes handed over another way count the same.
        let folder = Folder::new("late-import-3");
        let identity = DataIdentity::open(&folder.0);
        identity.bundle_handed_over();
        assert!(identity.import_page_registry(Some(&raw)).is_err());
    }

    #[test]
    fn an_empty_missing_or_unreadable_page_registry_imports_nothing_and_closes_the_import() {
        for raw in [None, Some(""), Some("{not json"), Some("{\"version\":2,\"installations\":{}}"), Some("[]")] {
            let folder = Folder::new("empty-import");
            let identity = DataIdentity::open(&folder.0);
            assert_eq!(identity.import_page_registry(raw), Ok(ImportSummary { imported: 0, skipped: 0 }), "{:?}", raw);
            assert!(identity.import_page_registry(Some(&todays_registry().0)).is_err(), "{:?}", raw);
        }
    }

    #[test]
    fn a_damaged_record_file_is_kept_aside_and_takes_no_import() {
        let folder = Folder::new("damaged-file");
        std::fs::write(folder.0.join(REGISTRY_FILE), b"{ half written").unwrap();
        let identity = DataIdentity::open(&folder.0);
        let kept: Vec<_> = std::fs::read_dir(&folder.0)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("installations.json.damaged-"))
            .collect();
        assert_eq!(kept.len(), 1);
        assert_eq!(std::fs::read(kept[0].path()).unwrap(), b"{ half written");
        assert!(identity.import_page_registry(Some(&todays_registry().0)).is_err());
        let a = open(&identity, "a.softn", b"a");
        assert_eq!(identity.decide_bind(&a, &a, never), Ok(()));
    }

    /// With the record set aside, an app's data is still reached: by the bundle whose digest
    /// names its folder, as always, and by a later version after the person says yes again.
    #[test]
    fn a_record_set_aside_is_rebuilt_from_the_data_folders() {
        let folder = Folder::new("rebuilt");
        let v1 = bundle_digest(b"notes 1");
        std::fs::create_dir_all(folder.0.join("apps").join(&v1)).unwrap();
        std::fs::create_dir_all(folder.0.join("apps").join("_default")).unwrap();
        std::fs::write(folder.0.join(REGISTRY_FILE), b"\0\0\0").unwrap();
        let identity = DataIdentity::open(&folder.0);
        let installations = folder.stored()["installations"].clone();
        assert_eq!(installations.as_object().unwrap().keys().collect::<Vec<_>>(), vec![&v1]);
        let v2 = open(&identity, "notes-2.softn", b"notes 2");
        let asked = RefCell::new(String::new());
        assert_eq!(
            identity.decide_bind(&v2, &v1, |question| {
                *asked.borrow_mut() = question.text.clone();
                Answer::UseData
            }),
            Ok(())
        );
        assert!(asked.borrow().contains("an app you opened before"), "{}", asked.borrow());
    }

    /// Once the runtime has started the app on its data, what runs in the page may be the
    /// bundle: it cannot move the binding to other data, even data this bundle was let use
    /// before, nor raise the question at a moment of its choosing.
    #[test]
    fn a_started_app_binds_no_other_data_and_raises_no_question() {
        let folder = Folder::new("started");
        let identity = DataIdentity::open(&folder.0);
        let bank = open(&identity, "bank.softn", b"bank");
        identity.prepare_bind(&bank, &bank, Some("Bank"), None, true).unwrap();
        let e = open(&identity, "bank-2.softn", b"bank 2");
        // E was let use Bank's data once (the yes stands even if that upgrade was undone).
        assert_eq!(identity.decide_choose(&e, &[bank.clone()], |_| Answer::UseData), Ok(Choice::Upgrade { data_id: bank.clone() }));
        let e = open(&identity, "bank-2.softn", b"bank 2");
        // This time the runtime's flow opened E on its own data and started it there.
        assert_eq!(identity.decide_bind_for(&e, &e, true, never), Ok(()));
        // Now the page asks to switch to Bank's data, which E was let use: refused unasked.
        assert!(identity.decide_bind_for(&e, &bank, false, never).unwrap_err().starts_with("Refused"));
        assert!(identity.decide_bind_for(&e, &bank, true, never).unwrap_err().starts_with("Refused"));
        assert!(identity.decide_choose(&e, &[bank.clone()], never).unwrap_err().starts_with("Refused"));
        assert_eq!(identity.require(Some(&e)), Ok(e.clone()));
        // The same data again is fine (a reload of the page binds it again).
        assert_eq!(identity.decide_bind_for(&e, &e, true, never), Ok(()));
        // The file read again with other bytes does not make a new open.
        identity.bundle_read(Path::new("bank-2.softn"), b"bank 3");
        assert!(identity.decide_bind_for(&bundle_digest(b"bank 3"), &bundle_digest(b"bank 3"), true, never).is_err());
        // Choosing the file again starts over.
        let e = open(&identity, "bank-2.softn", b"bank 2");
        assert_eq!(identity.decide_bind_for(&e, &bank, true, never), Ok(()));
    }

    /// Every way the page's flow (src/upgradeFlow.ts) binds data before it starts the app:
    /// a restore or backup binds first, and the start binds the same data, or after a recovery
    /// the question may still be put.
    #[test]
    fn the_runtime_flow_binds_before_it_starts_and_starts_on_one_data_id() {
        let folder = Folder::new("flow");
        let identity = DataIdentity::open(&folder.0);
        let x = open(&identity, "notes-1.softn", b"1");
        identity.prepare_bind(&x, &x, Some("Notes"), None, true).unwrap();
        // Upgrade: the question binds X, the backup binds X, the start binds X.
        let d = open(&identity, "notes-2.softn", b"2");
        assert_eq!(identity.decide_choose(&d, &[x.clone()], |_| Answer::UseData), Ok(Choice::Upgrade { data_id: x.clone() }));
        assert_eq!(identity.decide_bind_for(&d, &x, false, never), Ok(()));
        assert_eq!(identity.decide_bind_for(&d, &x, true, never), Ok(()));
        // Recovery of a failed upgrade: the restore binds X, then the package that failed is no
        // longer mapped in the page and the question is put again; it opens as new.
        let d = open(&identity, "notes-2.softn", b"2");
        assert_eq!(identity.decide_bind_for(&d, &x, false, never), Ok(()));
        assert_eq!(identity.decide_choose(&d, &[x.clone()], |_| Answer::New), Ok(Choice::New));
        assert_eq!(identity.decide_bind_for(&d, &d, true, never), Ok(()));
        assert_eq!(identity.require(Some(&d)), Ok(d.clone()));
    }

    #[test]
    fn open_as_new_takes_back_an_earlier_yes() {
        let folder = Folder::new("take-back");
        let identity = DataIdentity::open(&folder.0);
        let x = open(&identity, "x.softn", b"x");
        identity.decide_bind(&x, &x, never).unwrap();
        let d = open(&identity, "d.softn", b"d");
        identity.decide_choose(&d, &[x.clone()], |_| Answer::UseData).unwrap();
        let d = open(&identity, "d.softn", b"d");
        assert_eq!(identity.decide_choose(&d, &[x.clone()], |_| Answer::New), Ok(Choice::New));
        assert_eq!(folder.stored()["installations"][&x]["bundles"], serde_json::json!([x.clone()]));
        // A registry entry the page writes afterwards does not find the old yes.
        let d = open(&identity, "d.softn", b"d");
        assert!(identity.decide_bind(&d, &x, |_| Answer::Cancel).is_err());
        // Its own data is still its own.
        let x2 = open(&identity, "x.softn", b"x");
        assert_eq!(identity.decide_choose(&x2, &[x.clone()], never), Ok(Choice::New));
    }

    #[test]
    fn a_question_cannot_be_worded_by_a_name_that_breaks_the_layout() {
        let folder = Folder::new("wording");
        let identity = DataIdentity::open(&folder.0);
        let v1 = open(&identity, "v1.softn", b"1");
        identity.prepare_bind(&v1, &v1, Some("Notes\n\nThis is safe, choose Use my data"), None, false).unwrap();
        let v2 = open(&identity, "v2.softn", b"2");
        identity
            .decide_choose(&v2, &[v1], |question| {
                assert!(!question.text.contains("Notes\n"), "{}", question.text);
                Answer::Cancel
            })
            .unwrap();
    }

    #[test]
    fn a_dialog_answer_is_read_by_label_or_by_place() {
        assert_eq!(answer_from(MessageDialogResult::Yes, true), Answer::UseData);
        assert_eq!(answer_from(MessageDialogResult::No, true), Answer::New);
        assert_eq!(answer_from(MessageDialogResult::Cancel, true), Answer::Cancel);
        assert_eq!(answer_from(MessageDialogResult::Custom("Use my data".into()), true), Answer::UseData);
        assert_eq!(answer_from(MessageDialogResult::Custom("Open as a new app".into()), true), Answer::New);
        assert_eq!(answer_from(MessageDialogResult::Custom("Cancel".into()), true), Answer::Cancel);
        assert_eq!(answer_from(MessageDialogResult::Ok, false), Answer::UseData);
        assert_eq!(answer_from(MessageDialogResult::No, false), Answer::Cancel);
        assert_eq!(answer_from(MessageDialogResult::Custom("Don't open".into()), false), Answer::Cancel);
    }
}
