//! The runner's own lockdown, on Linux: what the process may still do if
//! anything ever got out of the guest, applied by the process to itself with
//! the kernel's own means, before it reads the request or starts a thread. No
//! root, no container, nothing to install: an unprivileged process may always
//! restrict itself, and every thread it starts afterwards inherits it.
//!
//! * **no_new_privs.** Nothing it runs can gain privileges (and the two below
//!   require it).
//! * **Landlock** (Linux 5.13 on). Files: the backend folder may be read, its
//!   database folder (`private/data`) and rate-limit notes (`private/limited`)
//!   written, and `/dev/urandom` read (SQLite seeds from it); nothing else, in
//!   any way. Where the kernel has them, TCP binds and connects are refused
//!   (6.7) and so are signals to processes outside the lockdown (6.12).
//! * **seccomp.** A filter refuses (EPERM) running programs, new processes
//!   (a thread is allowed), sockets, signals to any other process, other
//!   processes' memory, io_uring (whose operations seccomp cannot see), and
//!   the system calls that only enlarge the kernel's surface: mounts,
//!   namespaces, BPF, perf, userfaultfd, keys, modules, kexec.
//!
//! On a kernel without Landlock the seccomp filter still holds, and the other
//! way round; on one with neither, the runner runs as it always did. What was
//! enforced is what `--check-lockdown` reports (main.rs), with probes that
//! show each refusal on this system.

use std::path::Path;

/// What the lockdown could enforce here.
#[derive(Debug, Clone, Default)]
pub struct Status {
    /// The Landlock ABI the kernel offered (0: none), and whether the ruleset
    /// was enforced fully, partly or not at all.
    pub landlock_abi: i32,
    pub landlock: &'static str,
    pub seccomp: bool,
    pub no_new_privs: bool,
    /// Why a part could not be applied, for the operator.
    pub errors: Vec<String>,
}

impl Status {
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "landlock": { "abi": self.landlock_abi, "enforced": self.landlock },
            "seccomp": self.seccomp,
            "noNewPrivs": self.no_new_privs,
            "errors": self.errors,
        })
    }
}

/// Lock this process down to `root`, the backend folder. Call it before any
/// thread is started: Landlock restricts the calling thread and those it
/// starts later, not ones already running.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub fn apply(root: &Path) -> Status {
    let mut status = Status { landlock: "none", ..Status::default() };
    // SAFETY: a plain prctl; a failure leaves the process as it was.
    status.no_new_privs = unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } == 0;
    // No core file can carry the operator's key or an app's data anywhere.
    let none = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    // SAFETY: a plain setrlimit with a valid struct.
    unsafe { libc::setrlimit(libc::RLIMIT_CORE, &none) };
    match landlock_rules(root) {
        Ok((abi, enforced)) => {
            status.landlock_abi = abi;
            status.landlock = enforced;
        }
        Err(e) => status.errors.push(format!("landlock: {e}")),
    }
    match seccomp_filters() {
        Ok(()) => status.seccomp = true,
        Err(e) => status.errors.push(format!("seccomp: {e}")),
    }
    status
}

#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
pub fn apply(_root: &Path) -> Status {
    Status { landlock: "unsupported", ..Status::default() }
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn landlock_rules(root: &Path) -> Result<(i32, &'static str), String> {
    use landlock::{
        path_beneath_rules, Access, AccessFs, AccessNet, LandlockStatus, Ruleset, RulesetAttr, RulesetCreatedAttr, RulesetStatus, Scope, ABI,
    };
    // Every right this crate knows, so a newer kernel's are refused too.
    let abi = ABI::V6;
    let writes = [root.join("private/data"), root.join("private/limited")];
    // The rate-limit notes' folder is made on the first refusal; a rule needs
    // the folder to be there, so it is made now (as mark_limited makes it).
    let _ = std::fs::create_dir(&writes[1]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&writes[1], std::fs::Permissions::from_mode(0o700));
    }
    let status = Ruleset::default()
        .handle_access(AccessFs::from_all(abi))
        .and_then(|r| r.handle_access(AccessNet::from_all(abi)))
        .and_then(|r| r.scope(Scope::from_all(abi)))
        .and_then(|r| r.create())
        .and_then(|r| r.add_rules(path_beneath_rules([root], AccessFs::from_read(abi))))
        .and_then(|r| r.add_rules(path_beneath_rules(&writes, AccessFs::from_all(abi))))
        .and_then(|r| r.add_rules(path_beneath_rules(["/dev/urandom"], AccessFs::from_read(abi))))
        .and_then(|r| r.restrict_self())
        .map_err(|e| e.to_string())?;
    let offered = match status.landlock {
        LandlockStatus::Available { effective_abi, .. } => effective_abi as i32,
        _ => 0,
    };
    Ok((
        offered,
        match status.ruleset {
            RulesetStatus::FullyEnforced => "full",
            RulesetStatus::PartiallyEnforced => "partial",
            _ => "none",
        },
    ))
}

/// The system calls refused outright (EPERM), whatever their arguments.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const REFUSED: &[i64] = &[
    // Other programs and processes.
    libc::SYS_execve,
    libc::SYS_execveat,
    libc::SYS_fork,
    libc::SYS_vfork,
    libc::SYS_ptrace,
    libc::SYS_process_vm_readv,
    libc::SYS_process_vm_writev,
    libc::SYS_kcmp,
    libc::SYS_pidfd_open,
    libc::SYS_pidfd_getfd,
    libc::SYS_pidfd_send_signal,
    // The network, and sockets of any kind.
    libc::SYS_socket,
    libc::SYS_socketpair,
    libc::SYS_connect,
    libc::SYS_bind,
    libc::SYS_listen,
    libc::SYS_accept,
    libc::SYS_accept4,
    // What seccomp cannot look into, or only enlarges the kernel's surface.
    libc::SYS_io_uring_setup,
    libc::SYS_io_uring_enter,
    libc::SYS_io_uring_register,
    libc::SYS_mount,
    libc::SYS_umount2,
    libc::SYS_pivot_root,
    libc::SYS_chroot,
    libc::SYS_setns,
    libc::SYS_unshare,
    libc::SYS_bpf,
    libc::SYS_perf_event_open,
    libc::SYS_userfaultfd,
    libc::SYS_keyctl,
    libc::SYS_add_key,
    libc::SYS_request_key,
    libc::SYS_init_module,
    libc::SYS_finit_module,
    libc::SYS_delete_module,
    libc::SYS_kexec_load,
    libc::SYS_kexec_file_load,
    libc::SYS_reboot,
    libc::SYS_swapon,
    libc::SYS_swapoff,
    libc::SYS_acct,
    libc::SYS_quotactl,
    libc::SYS_name_to_handle_at,
    libc::SYS_open_by_handle_at,
    libc::SYS_personality,
    libc::SYS_modify_ldt,
    libc::SYS_iopl,
    libc::SYS_ioperm,
    libc::SYS_syslog,
    libc::SYS_fanotify_init,
    libc::SYS_lookup_dcookie,
    libc::SYS_vhangup,
];

/// Two filters, stacked: one answers `clone3` "not implemented", so a C
/// library falls back to `clone` (glibc's threads do, and only on ENOSYS),
/// whose flags a filter can read; the other refuses everything above, a
/// `clone` that would make a process rather than a thread, and a signal to
/// any process but this one. The stricter answer of the two wins.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn seccomp_filters() -> Result<(), String> {
    use seccompiler::{SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter, SeccompRule, TargetArch};
    use std::collections::BTreeMap;
    let error = |e: seccompiler::BackendError| e.to_string();
    let condition = |arg: u8, len: SeccompCmpArgLen, op: SeccompCmpOp, value: u64| SeccompCondition::new(arg, len, op, value).map_err(error);
    let compile = |rules: BTreeMap<i64, Vec<SeccompRule>>, action: SeccompAction| -> Result<seccompiler::BpfProgram, String> {
        let filter = SeccompFilter::new(rules, SeccompAction::Allow, action, TargetArch::x86_64).map_err(error)?;
        filter.try_into().map_err(|e: seccompiler::BackendError| e.to_string())
    };
    // SAFETY: getpid has no preconditions.
    let me = unsafe { libc::getpid() } as u32 as u64;
    let mut refused: BTreeMap<i64, Vec<SeccompRule>> = REFUSED.iter().map(|&n| (n, Vec::new())).collect();
    // clone without CLONE_THREAD is a new process.
    refused.insert(
        libc::SYS_clone,
        vec![SeccompRule::new(vec![condition(0, SeccompCmpArgLen::Qword, SeccompCmpOp::MaskedEq(libc::CLONE_THREAD as u64), 0)?]).map_err(error)?],
    );
    // A signal to anything but this process (kill's 0 and -1 are groups and everyone).
    for call in [libc::SYS_kill, libc::SYS_tgkill] {
        refused.insert(call, vec![SeccompRule::new(vec![condition(0, SeccompCmpArgLen::Dword, SeccompCmpOp::Ne, me)?]).map_err(error)?]);
    }
    let clone3: BTreeMap<i64, Vec<SeccompRule>> = [(libc::SYS_clone3, Vec::new())].into_iter().collect();
    let first = compile(clone3, SeccompAction::Errno(libc::ENOSYS as u32))?;
    let second = compile(refused, SeccompAction::Errno(libc::EPERM as u32))?;
    seccompiler::apply_filter_all_threads(&first).map_err(|e| e.to_string())?;
    seccompiler::apply_filter_all_threads(&second).map_err(|e| e.to_string())
}

/// What `--check-lockdown` tries once the lockdown is on, each answered
/// "denied" or "allowed": a file outside the backend, a socket, a new
/// process, running a program, and a signal to the process that started this.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub fn probes(root: &Path) -> serde_json::Value {
    let errno = || std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
    let said = |denied: bool| if denied { "denied" } else { "allowed" };
    // The backend's parent folder: there on every system, outside the backend.
    let outside = std::fs::read_dir(root.parent().unwrap_or(Path::new("/"))).is_err();
    // SAFETY: plain system calls; a socket or child that is made is closed or ended at once.
    let socket = unsafe {
        let fd = libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0);
        if fd >= 0 {
            libc::close(fd);
        }
        fd < 0 && errno() == libc::EPERM
    };
    let fork = unsafe {
        let pid = libc::fork();
        if pid == 0 {
            libc::_exit(0);
        }
        if pid > 0 {
            libc::waitpid(pid, std::ptr::null_mut(), 0);
        }
        pid < 0 && errno() == libc::EPERM
    };
    // A path that is not there: refused, EPERM; allowed, ENOENT, and nothing runs.
    let exec = unsafe {
        let path = c"/nonexistent/softn-runner-probe";
        let argv = [path.as_ptr(), std::ptr::null()];
        let envp = [std::ptr::null()];
        libc::execve(path.as_ptr(), argv.as_ptr(), envp.as_ptr());
        errno() == libc::EPERM
    };
    // Signal 0 asks only whether a signal could be sent.
    let signal = unsafe { libc::kill(libc::getppid(), 0) != 0 && errno() == libc::EPERM };
    serde_json::json!({
        "outside": said(outside),
        "socket": said(socket),
        "fork": said(fork),
        "exec": said(exec),
        "signal": said(signal),
    })
}

#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
pub fn probes(_root: &Path) -> serde_json::Value {
    serde_json::json!({})
}
