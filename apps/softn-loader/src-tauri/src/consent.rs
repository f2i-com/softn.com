//! Questions this side puts to the person itself, in a native dialog.
//!
//! The page that draws a bundle is the page that holds the IPC, so a call arriving here
//! cannot be told apart by who made it: the runtime's own code, or something a bundle got
//! to run in that page. What the page says the person allowed is therefore not evidence of
//! it. For the two things a call can do beyond the window and the data in front of the
//! person (reach the network through `net_fetch`, and turn on peer sync) the answer is
//! asked for here, where nothing in the page can give it.
//!
//! Each is one question per bundle the person opens, and one more for each name the
//! network rules list that turns out to lead to this computer or the local network (net.rs).
//! The answer stands until they choose another bundle, so a no is not asked about again and
//! again until it becomes a yes.

// Only the desktop runtime puts the network question (net.rs says why), so on other
// platforms part of this is unused.
#![cfg_attr(not(desktop), allow(dead_code))]

use std::collections::HashMap;
use std::net::IpAddr;
use std::path::Path;
use std::sync::Mutex;
#[cfg(desktop)]
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// How many host names a question spells out, and how much of each.
const HOSTS_SHOWN: usize = 12;
const HOST_CHARS_SHOWN: usize = 80;

/// The `net` rules a request says it runs under. The page sends them with every request;
/// two requests are the same question only when the rules are the same.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetPolicy {
    allow_http: bool,
    allowed_hosts: Vec<String>,
}

impl NetPolicy {
    pub fn new(allow_http: bool, allowed_hosts: &[String]) -> Self {
        let mut allowed_hosts = allowed_hosts.to_vec();
        allowed_hosts.sort();
        allowed_hosts.dedup();
        NetPolicy { allow_http, allowed_hosts }
    }

    /// What the rules permit, in the words the person reads. With no list, a request to this
    /// computer or the local network is refused (net.rs); a listed host that is there is
    /// labelled so.
    fn describe(&self) -> String {
        let reach = if self.allowed_hosts.is_empty() {
            "any server on the internet".to_string()
        } else {
            let shown: Vec<String> = self
                .allowed_hosts
                .iter()
                .take(HOSTS_SHOWN)
                .map(|host| {
                    if crate::net::is_local_host(host) {
                        format!("{} (on this computer or your local network)", printable(host))
                    } else {
                        printable(host)
                    }
                })
                .collect();
            let more = self.allowed_hosts.len() - shown.len();
            let rest = if more > 0 { format!(", and {} more", more) } else { String::new() };
            format!("only these servers: {}{}", shown.join(", "), rest)
        };
        let http = if self.allow_http { ", also over plain HTTP, which is not encrypted" } else { "" };
        format!("{}{}", reach, http)
    }
}

/// Characters that show nothing, or turn the text around them the other way: a bundle's file
/// name `invoice\u{202E}cod.softn` read as `invoicenffos.doc`, and a host named with them
/// can show as another one; and the line and paragraph separators break the question into new lines
/// as a newline would. Not control characters, so the filter below let them through.
fn is_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{061C}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{2028}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206F}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
    )
}

/// A name from the page or from a file, safe to put in a dialog: one line, not long, and
/// reading as what it is.
pub(crate) fn printable(text: &str) -> String {
    let cleaned: String = text.chars().filter(|c| !c.is_control() && !is_invisible(*c)).take(HOST_CHARS_SHOWN).collect();
    if text.chars().count() > HOST_CHARS_SHOWN {
        format!("{}...", cleaned)
    } else {
        cleaned
    }
}

#[derive(Default)]
struct Standing {
    /// Counts the bundles the person has chosen. An answer belongs to the bundle that was
    /// open when its question was put, and is dropped if another was chosen meanwhile.
    opened: u64,
    /// The file name of the bundle the person last chose, for the questions' wording.
    app: Option<String>,
    /// The one network question put since then, and its answer.
    net: Option<(NetPolicy, bool)>,
    /// The answer to the peer sync question, if it has been put since then.
    peer_sync: Option<bool>,
    /// Listed names that looked like servers on the internet and led to this computer or
    /// the local network, each with the answer to the question put about it.
    local_hosts: HashMap<String, bool>,
}

/// What the person has answered for the bundle now open.
///
/// For the network: the first rules a request arrives under are put to the person, and a
/// request under other rules is refused without a second question, so a bundle cannot ask
/// for one host and then, unasked, for all of them.
#[derive(Default)]
pub struct Consent {
    standing: Mutex<Standing>,
    /// Held while a question is on screen, so calls that arrive together wait for the one
    /// answer instead of each raising a dialog.
    asking: tauri::async_runtime::Mutex<()>,
}

const ANOTHER_APP_OPENED: &str = "another app was opened while the question was on screen";

impl Consent {
    /// The person chose a bundle (the picker, a drop, the command line, a file opened from
    /// outside): what was answered for the one before is forgotten.
    pub fn bundle_opened(&self, path: &Path) {
        if let Ok(mut standing) = self.standing.lock() {
            standing.opened += 1;
            standing.app = path.file_name().map(|name| printable(&name.to_string_lossy()));
            standing.net = None;
            standing.peer_sync = None;
            standing.local_hosts.clear();
        }
    }

    fn who(standing: &Standing) -> String {
        match &standing.app {
            Some(name) => format!("\"{}\"", name),
            None => "The app in this window".to_string(),
        }
    }

    /// The answer already given that covers `policy`, if the network question has been put.
    fn net_answer(&self, policy: &NetPolicy) -> Option<Result<(), String>> {
        let standing = self.standing.lock().ok()?;
        let (asked, allowed) = standing.net.as_ref()?;
        Some(if asked != policy {
            Err("Network access not permitted: this app already asked for it under other rules, and is not asked twice. Open the app again to be asked afresh.".to_string())
        } else if *allowed {
            Ok(())
        } else {
            Err("Network access not permitted: you chose not to allow it for this app. Open the app again to be asked afresh.".to_string())
        })
    }

    /// The dialog for `policy` (title, text), and which bundle it is being asked about.
    fn net_question(&self, policy: &NetPolicy) -> (u64, String, String) {
        let standing = self.standing.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        (
            standing.opened,
            "Allow network access?".to_string(),
            format!(
                "{} is asking to use the network.\n\nIt would be able to reach {}.\n\nAllow this only if you trust where this app came from. Your answer lasts until you open another app or close SoftN.",
                Self::who(&standing),
                policy.describe()
            ),
        )
    }

    fn record_net(&self, opened: u64, policy: &NetPolicy, allowed: bool) -> Result<(), String> {
        {
            let mut standing = self.standing.lock().map_err(|_| "Network access not permitted".to_string())?;
            if standing.opened != opened {
                return Err(format!("Network access not permitted: {}", ANOTHER_APP_OPENED));
            }
            standing.net = Some((policy.clone(), allowed));
        }
        self.net_answer(policy).unwrap_or_else(|| Err("Network access not permitted".to_string()))
    }

    /// The steps of `require_net` with the dialog replaced by `ask`: what the tests drive.
    #[cfg(test)]
    fn decide_net(&self, policy: &NetPolicy, ask: impl FnOnce(&str, &str) -> bool) -> Result<(), String> {
        if let Some(answer) = self.net_answer(policy) {
            return answer;
        }
        let (opened, title, text) = self.net_question(policy);
        let allowed = ask(&title, &text);
        self.record_net(opened, policy, allowed)
    }

    /// Whether a request under `policy` may be made, putting the question to the person in
    /// a native dialog if it has not been put yet.
    pub async fn require_net(&self, app: &tauri::AppHandle, policy: &NetPolicy) -> Result<(), String> {
        let _turn = self.asking.lock().await;
        if let Some(answer) = self.net_answer(policy) {
            return answer;
        }
        let (opened, title, text) = self.net_question(policy);
        let allowed = ask(app, title, text, "Allow", "Don't allow").await;
        self.record_net(opened, policy, allowed)
    }

    fn local_host_answer(&self, host: &str) -> Option<Result<(), String>> {
        let standing = self.standing.lock().ok()?;
        standing.local_hosts.get(host).map(|allowed| {
            if *allowed {
                Ok(())
            } else {
                Err(format!(
                    "Network access not permitted: {} leads to this computer or your local network, and you chose not to allow it. Open the app again to be asked afresh.",
                    printable(host)
                ))
            }
        })
    }

    /// The question about a listed name that leads to `address` on this computer or the
    /// local network, which the network question did not say.
    fn local_host_question(&self, host: &str, address: IpAddr) -> (u64, String, String) {
        let standing = self.standing.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let host = printable(host);
        (
            standing.opened,
            "Allow access to your local network?".to_string(),
            format!(
                "{} may reach {}, and that name now leads to {}, which is on this computer or your local network.\n\nWhoever runs a name on the internet can point it at a device of yours, such as a router, a printer or a program on this computer, to let an app read it.\n\nAllow this only if {} is your own, or your organisation's. Your answer lasts until you open another app or close SoftN.",
                Self::who(&standing),
                host,
                address,
                host
            ),
        )
    }

    fn record_local_host(&self, opened: u64, host: &str, allowed: bool) -> Result<(), String> {
        {
            let mut standing = self.standing.lock().map_err(|_| "Network access not permitted".to_string())?;
            if standing.opened != opened {
                return Err(format!("Network access not permitted: {}", ANOTHER_APP_OPENED));
            }
            standing.local_hosts.insert(host.to_string(), allowed);
        }
        self.local_host_answer(host).unwrap_or_else(|| Err("Network access not permitted".to_string()))
    }

    /// The steps of `require_local_host` with the dialog replaced by `ask`.
    #[cfg(test)]
    fn decide_local_host(&self, host: &str, address: IpAddr, ask: impl FnOnce(&str, &str) -> bool) -> Result<(), String> {
        if let Some(answer) = self.local_host_answer(host) {
            return answer;
        }
        let (opened, title, text) = self.local_host_question(host, address);
        let allowed = ask(&title, &text);
        self.record_local_host(opened, host, allowed)
    }

    /// Whether a request to `host`, a name the rules list that leads to `address` on this
    /// computer or the local network, may be made: asked once for each such name.
    pub async fn require_local_host(&self, app: &tauri::AppHandle, host: &str, address: IpAddr) -> Result<(), String> {
        let _turn = self.asking.lock().await;
        if let Some(answer) = self.local_host_answer(host) {
            return answer;
        }
        let (opened, title, text) = self.local_host_question(host, address);
        let allowed = ask(app, title, text, "Allow", "Don't allow").await;
        self.record_local_host(opened, host, allowed)
    }

    fn peer_sync_answer(&self) -> Option<Result<(), String>> {
        let standing = self.standing.lock().ok()?;
        standing.peer_sync.map(|allowed| {
            if allowed {
                Ok(())
            } else {
                Err("Peer sync was not turned on: you chose to keep it off. Open the app again to be asked afresh.".to_string())
            }
        })
    }

    fn peer_sync_question(&self) -> (u64, String, String) {
        let standing = self.standing.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        (
            standing.opened,
            "Turn on peer sync?".to_string(),
            format!(
                "{} is asking to turn on peer sync.\n\nSoftN would announce itself on your local network, accept connections from other devices there, and share app data with them. It stays on after SoftN is closed and opened again.\n\nTurn it on only if you asked for this and trust every device on this network.",
                Self::who(&standing)
            ),
        )
    }

    fn record_peer_sync(&self, opened: u64, allowed: bool) -> Result<(), String> {
        {
            let mut standing = self.standing.lock().map_err(|_| "Peer sync was not turned on".to_string())?;
            if standing.opened != opened {
                return Err(format!("Peer sync was not turned on: {}", ANOTHER_APP_OPENED));
            }
            standing.peer_sync = Some(allowed);
        }
        self.peer_sync_answer().unwrap_or_else(|| Err("Peer sync was not turned on".to_string()))
    }

    /// The steps of `require_peer_sync` with the dialog replaced by `ask`.
    #[cfg(test)]
    fn decide_peer_sync(&self, ask: impl FnOnce(&str, &str) -> bool) -> Result<(), String> {
        if let Some(answer) = self.peer_sync_answer() {
            return answer;
        }
        let (opened, title, text) = self.peer_sync_question();
        let allowed = ask(&title, &text);
        self.record_peer_sync(opened, allowed)
    }

    /// Whether peer sync may be turned on, putting the question to the person in a native
    /// dialog if it has not been put yet.
    pub async fn require_peer_sync(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let _turn = self.asking.lock().await;
        if let Some(answer) = self.peer_sync_answer() {
            return answer;
        }
        let (opened, title, text) = self.peer_sync_question();
        let allowed = ask(app, title, text, "Turn on", "Keep off").await;
        self.record_peer_sync(opened, allowed)
    }
}

/// Put a yes-or-no question in a native dialog over the main window. A dialog that cannot
/// be shown is a no.
async fn ask(app: &tauri::AppHandle, title: String, text: String, yes: &str, no: &str) -> bool {
    let app = app.clone();
    let buttons = MessageDialogButtons::OkCancelCustom(yes.to_string(), no.to_string());
    // Blocking, hence off the async runtime's own threads and never on the main one.
    tauri::async_runtime::spawn_blocking(move || {
        let dialog = app.dialog().message(text).title(title).kind(MessageDialogKind::Warning).buttons(buttons);
        #[cfg(desktop)]
        let dialog = match app.get_webview_window("main") {
            Some(window) => dialog.parent(&window),
            None => dialog,
        };
        dialog.blocking_show()
    })
    .await
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn policy(allow_http: bool, hosts: &[&str]) -> NetPolicy {
        let hosts: Vec<String> = hosts.iter().map(|host| host.to_string()).collect();
        NetPolicy::new(allow_http, &hosts)
    }

    #[test]
    fn the_network_question_is_put_once_and_its_answer_stands() {
        let consent = Consent::default();
        consent.bundle_opened(Path::new(r"C:\apps\todo.softn"));
        let any_host = policy(false, &[]);
        let asked = RefCell::new(Vec::new());
        let allowed = consent.decide_net(&any_host, |title, text| {
            asked.borrow_mut().push(format!("{}\n{}", title, text));
            true
        });
        assert_eq!(allowed, Ok(()));
        assert_eq!(asked.borrow().len(), 1);
        assert!(asked.borrow()[0].contains("todo.softn"), "{}", asked.borrow()[0]);
        assert!(asked.borrow()[0].contains("any server on the internet."), "{}", asked.borrow()[0]);
        // With no list, this computer and the local network are refused (net.rs), so the
        // question does not offer them.
        assert!(!asked.borrow()[0].contains("local network"), "{}", asked.borrow()[0]);
        // The same rules again are not a second question.
        assert_eq!(consent.decide_net(&any_host, |_, _| panic!("asked twice")), Ok(()));
    }

    #[test]
    fn a_no_is_not_asked_about_again() {
        let consent = Consent::default();
        let hosts = policy(false, &["api.example.com"]);
        assert!(consent.decide_net(&hosts, |_, _| false).is_err());
        let again = consent.decide_net(&hosts, |_, _| panic!("asked again after a no"));
        assert!(again.unwrap_err().contains("you chose not to allow it"));
    }

    #[test]
    fn other_rules_than_the_ones_answered_for_are_refused_unasked() {
        let consent = Consent::default();
        // Allowed for one named host...
        assert_eq!(consent.decide_net(&policy(false, &["api.example.com"]), |_, _| true), Ok(()));
        // ...which is not an answer about every host, about plain HTTP, or about another one.
        for other in [policy(false, &[]), policy(true, &["api.example.com"]), policy(false, &["api.example.com", "intranet"])] {
            let refused = consent.decide_net(&other, |_, _| panic!("a second question was put"));
            assert!(refused.unwrap_err().contains("other rules"), "{:?}", other);
        }
        // The order and repetition of the host list do not make new rules.
        assert_eq!(
            policy(false, &["b.example.com", "a.example.com", "b.example.com"]),
            policy(false, &["a.example.com", "b.example.com"])
        );
    }

    #[test]
    fn choosing_another_bundle_starts_over() {
        let consent = Consent::default();
        let any_host = policy(false, &[]);
        assert_eq!(consent.decide_net(&any_host, |_, _| true), Ok(()));
        assert_eq!(consent.decide_peer_sync(|_, _| true), Ok(()));
        consent.bundle_opened(Path::new("/home/someone/other.softn"));
        let mut asked = 0;
        assert!(consent
            .decide_net(&any_host, |_, text| {
                asked += 1;
                assert!(text.contains("other.softn"), "{}", text);
                false
            })
            .is_err());
        assert!(consent
            .decide_peer_sync(|_, text| {
                asked += 1;
                assert!(text.contains("other.softn"), "{}", text);
                false
            })
            .is_err());
        assert_eq!(asked, 2, "the bundle before it had been allowed; this one is asked for itself");
    }

    #[test]
    fn an_answer_given_while_another_bundle_was_opened_counts_for_neither() {
        let consent = Consent::default();
        consent.bundle_opened(Path::new("first.softn"));
        let any_host = policy(false, &[]);
        // The question is about first.softn; second.softn is opened before it is answered.
        let outcome = consent.decide_net(&any_host, |_, _| {
            consent.bundle_opened(Path::new("second.softn"));
            true
        });
        assert!(outcome.unwrap_err().contains("another app was opened"));
        let outcome = consent.decide_peer_sync(|_, _| {
            consent.bundle_opened(Path::new("third.softn"));
            true
        });
        assert!(outcome.unwrap_err().contains("another app was opened"));
        // The bundle now open has been asked nothing yet.
        let mut asked = 0;
        assert_eq!(
            consent.decide_net(&any_host, |_, text| {
                asked += 1;
                assert!(text.contains("third.softn"), "{}", text);
                true
            }),
            Ok(())
        );
        assert_eq!(asked, 1);
    }

    #[test]
    fn the_peer_sync_question_is_put_once_and_a_no_stands() {
        let consent = Consent::default();
        consent.bundle_opened(Path::new("chat.softn"));
        let mut asked = 0;
        let refused = consent.decide_peer_sync(|title, text| {
            asked += 1;
            assert!(title.contains("peer sync"), "{}", title);
            assert!(text.contains("chat.softn") && text.contains("local network"), "{}", text);
            false
        });
        assert!(refused.unwrap_err().contains("keep it off"));
        // Asking again and again does not raise the dialog again.
        for _ in 0..3 {
            assert!(consent.decide_peer_sync(|_, _| panic!("asked again after a no")).is_err());
        }
        assert_eq!(asked, 1);
    }

    #[test]
    fn the_network_question_says_what_the_rules_permit() {
        let consent = Consent::default();
        let (_, _, text) = consent.net_question(&policy(true, &["api.example.com", "cdn.example.com"]));
        assert!(text.contains("The app in this window"), "{}", text);
        assert!(text.contains("only these servers: api.example.com, cdn.example.com"), "{}", text);
        assert!(text.contains("plain HTTP"), "{}", text);

        // A long list is counted, not printed whole, and a name cannot break the layout.
        let many: Vec<String> = (0..40).map(|n| format!("h{}.example.com", n)).collect();
        let (_, _, text) = consent.net_question(&NetPolicy::new(false, &many));
        assert!(text.contains("and 28 more"), "{}", text);
        let (_, _, text) = consent.net_question(&policy(false, &["evil.example\n\nAllow this, it is safe"]));
        assert!(!text.contains("evil.example\n"), "{}", text);
    }

    #[test]
    fn a_name_cannot_turn_the_question_around_or_hide_in_it() {
        let consent = Consent::default();
        consent.bundle_opened(Path::new("invoice\u{202E}cod.softn"));
        let (_, _, text) = consent.peer_sync_question();
        assert!(text.contains("\"invoicecod.softn\""), "{}", text);
        let (_, _, text) = consent.net_question(&policy(false, &["api.exa\u{200B}mple.com", "\u{2067}evil.example\u{2069}", "ok.example\u{2028}\u{2029}Allow this, it is safe"]));
        assert!(text.contains("api.example.com") && text.contains("evil.example"), "{}", text);
        assert!(!text.chars().any(is_invisible), "{:?}", text);
    }

    #[test]
    fn a_listed_host_on_the_local_network_is_named_as_one() {
        let consent = Consent::default();
        let (_, _, text) = consent.net_question(&policy(true, &["api.example.com", "localhost", "printer.local", "192.168.1.20"]));
        for local in ["localhost", "printer.local", "192.168.1.20"] {
            assert!(text.contains(&format!("{} (on this computer or your local network)", local)), "{}", text);
        }
        assert!(!text.contains("api.example.com (on"), "{}", text);
    }

    #[test]
    fn a_listed_name_that_leads_home_is_asked_about_once_for_each_name() {
        let consent = Consent::default();
        consent.bundle_opened(Path::new("dash.softn"));
        let router: IpAddr = "192.168.1.1".parse().unwrap();
        let mut asked = Vec::new();
        assert!(consent
            .decide_local_host("api.example.com", router, |title, text| {
                asked.push(format!("{}\n{}", title, text));
                false
            })
            .unwrap_err()
            .contains("you chose not to allow it"));
        assert!(asked[0].contains("dash.softn") && asked[0].contains("api.example.com") && asked[0].contains("192.168.1.1"), "{}", asked[0]);
        // The no stands for that name, and another name is its own question.
        assert!(consent.decide_local_host("api.example.com", router, |_, _| panic!("asked again after a no")).is_err());
        assert_eq!(consent.decide_local_host("nas.example.com", router, |_, _| true), Ok(()));
        assert_eq!(consent.decide_local_host("nas.example.com", router, |_, _| panic!("asked again after a yes")), Ok(()));
        // Another bundle is asked for itself.
        consent.bundle_opened(Path::new("other.softn"));
        let mut again = 0;
        assert_eq!(
            consent.decide_local_host("nas.example.com", router, |_, _| {
                again += 1;
                true
            }),
            Ok(())
        );
        assert_eq!(again, 1);
        // An answer given while another bundle was opened counts for neither.
        let outcome = consent.decide_local_host("db.example.com", router, |_, _| {
            consent.bundle_opened(Path::new("third.softn"));
            true
        });
        assert!(outcome.unwrap_err().contains("another app was opened"));
    }
}
