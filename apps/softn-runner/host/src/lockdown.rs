//! The runner's own lockdown, on Linux: what the process may still do if
//! anything ever got out of the guest, applied by the process to itself with
//! the kernel's own means, before it reads the request or starts a thread. No
//! root, no container, nothing to install: an unprivileged process may always
//! restrict itself, and every thread it starts afterwards inherits it.
//!
//! * **Its own session.** `setsid`: no controlling terminal (setup.php runs it
//!   from the operator's), so none to type into.
//! * **no_new_privs**, no core file, and a umask of 077 for what it makes.
//! * **Landlock** (Linux 5.13 on): the backend folder may be read; in its
//!   database folder (`private/data`) and rate-limit notes (`private/limited`)
//!   regular files and (in the notes) folders may be made, written, truncated
//!   and removed, and nothing else; `/dev/urandom` (SQLite seeds from it) and
//!   the time zone (`/etc/localtime`, `/usr/share/zoneinfo`, for SQLite's
//!   `localtime`) may be read. Every other open, and every device, link, socket or pipe made,
//!   is refused. Where the kernel has them, TCP (6.7), signals and abstract
//!   sockets outside the lockdown (6.12) and pathname sockets (7.1) too.
//!   Landlock does not govern a file's mode, owner, times or extended
//!   attributes, nor (before 6.2) truncate by path: seccomp refuses those.
//! * **seccomp**, three stacked filters, answering EPERM: any system call of
//!   another ABI (i386, or x32's numbers, which an x86-64 filter keyed on
//!   numbers would let through); then running a program, making a process (a
//!   thread is allowed), sockets, signals and scheduling or limits aimed at
//!   any other process, other processes' memory, io_uring (whose operations
//!   seccomp cannot see), changing a file's mode, owner, times or attributes
//!   by path, making links and device nodes, a terminal's input, and the calls
//!   that only enlarge the kernel's surface: mounts, namespaces, BPF, perf,
//!   userfaultfd, keys, modules, kexec. (`clone3` answers ENOSYS instead, so a
//!   C library falls back to `clone`, whose flags a filter can read.)
//!
//! On a kernel without Landlock the seccomp filters still hold, and the other
//! way round; on one with neither, the runner runs as it always did, and
//! other processes of its account stay reachable through `/proc`, which only
//! Landlock closes. What was enforced is what `--check-lockdown` reports
//! (main.rs), with probes that show each refusal on this system.

use std::path::{Path, PathBuf};

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
    // SAFETY: plain system calls on this process; a failure leaves it as it was.
    unsafe {
        libc::setsid();
        libc::umask(0o077);
        status.no_new_privs = libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0;
        // No core file can carry the operator's key or an app's data anywhere.
        let none = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
        libc::setrlimit(libc::RLIMIT_CORE, &none);
    }
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
        make_bitflags, path_beneath_rules, Access, AccessFs, AccessNet, LandlockStatus, Ruleset, RulesetAttr, RulesetCreatedAttr, RulesetStatus,
        Scope, ABI,
    };
    // Every right this crate knows is handled, so each is refused unless a
    // rule grants it (best effort: a kernel's own subset). A right a later
    // kernel adds is not handled, and so not refused, until the crate knows it.
    let abi = ABI::V9;
    let read = make_bitflags!(AccessFs::{ReadFile | ReadDir});
    // What SQLite does in its folder (the database, its WAL and shm, made,
    // truncated and removed; the folder opened to sync it) and the stopped
    // migration's note; and in the notes', folders made and removed.
    let data = make_bitflags!(AccessFs::{ReadFile | ReadDir | WriteFile | MakeReg | RemoveFile | Truncate});
    let notes = data | make_bitflags!(AccessFs::{MakeDir | RemoveDir});
    // The notes' folder is made on the first refusal; a rule needs the folder
    // to be there, so it is made now, private, as mark_limited makes it.
    let limited = root.join("private/limited");
    if std::fs::create_dir(&limited).is_ok() {
        let _ = crate::private_mode(&limited, 0o700);
    }
    let status = Ruleset::default()
        .handle_access(AccessFs::from_all(abi))
        .and_then(|r| r.handle_access(AccessNet::from_all(abi)))
        .and_then(|r| r.scope(Scope::from_all(abi)))
        .and_then(|r| r.create())
        .and_then(|r| r.add_rules(path_beneath_rules([root], read)))
        .and_then(|r| r.add_rules(path_beneath_rules([root.join("private/data")], data)))
        .and_then(|r| r.add_rules(path_beneath_rules([limited], notes)))
        .and_then(|r| r.add_rules(path_beneath_rules(["/dev/urandom"], AccessFs::ReadFile)))
        // The system's time zone, which SQLite's `localtime` reads through the
        // C library where the host sets no TZ (FormLogic does not): refused,
        // a migration's local time was UTC on a server that is not.
        .and_then(|r| r.add_rules(path_beneath_rules(["/etc/localtime", "/usr/share/zoneinfo"], read)))
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
    libc::SYS_process_madvise,
    libc::SYS_process_mrelease,
    libc::SYS_kcmp,
    libc::SYS_pidfd_open,
    libc::SYS_pidfd_getfd,
    libc::SYS_pidfd_send_signal,
    libc::SYS_tkill,
    libc::SYS_setpriority,
    libc::SYS_sched_setaffinity,
    libc::SYS_sched_setscheduler,
    libc::SYS_sched_setparam,
    libc::SYS_sched_setattr,
    libc::SYS_ioprio_set,
    libc::SYS_migrate_pages,
    libc::SYS_move_pages,
    // The network, and sockets of any kind.
    libc::SYS_socket,
    libc::SYS_socketpair,
    libc::SYS_connect,
    libc::SYS_bind,
    libc::SYS_listen,
    libc::SYS_accept,
    libc::SYS_accept4,
    // What Landlock does not govern: a file's mode, owner, times and
    // attributes by path, truncate by path (before 6.2), and links and device
    // nodes on a kernel without it. The runner sets its own files' modes
    // through their handles (fchmod), and SQLite truncates by handle.
    libc::SYS_chmod,
    libc::SYS_fchmodat,
    libc::SYS_fchmodat2,
    libc::SYS_chown,
    libc::SYS_lchown,
    libc::SYS_fchownat,
    libc::SYS_truncate,
    libc::SYS_utime,
    libc::SYS_utimes,
    libc::SYS_futimesat,
    libc::SYS_utimensat,
    libc::SYS_setxattr,
    libc::SYS_lsetxattr,
    libc::SYS_fsetxattr,
    libc::SYS_removexattr,
    libc::SYS_lremovexattr,
    libc::SYS_fremovexattr,
    libc::SYS_mknod,
    libc::SYS_mknodat,
    libc::SYS_symlink,
    libc::SYS_symlinkat,
    libc::SYS_link,
    libc::SYS_linkat,
    // What seccomp cannot look into, or only enlarges the kernel's surface.
    libc::SYS_io_uring_setup,
    libc::SYS_io_uring_enter,
    libc::SYS_io_uring_register,
    libc::SYS_mount,
    libc::SYS_umount2,
    libc::SYS_pivot_root,
    libc::SYS_chroot,
    libc::SYS_open_tree,
    libc::SYS_move_mount,
    libc::SYS_fsopen,
    libc::SYS_fsconfig,
    libc::SYS_fsmount,
    libc::SYS_fspick,
    libc::SYS_mount_setattr,
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

/// Three filters, stacked; of their answers to a call the strictest wins.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn seccomp_filters() -> Result<(), String> {
    use seccompiler::{SeccompAction, SeccompCmpArgLen as Len, SeccompCmpOp as Op, SeccompCondition, SeccompFilter, SeccompRule, TargetArch};
    use std::collections::BTreeMap;
    let error = |e: seccompiler::BackendError| e.to_string();
    let when = |conditions: Vec<(u8, Len, Op, u64)>| -> Result<SeccompRule, String> {
        let conditions = conditions.into_iter().map(|(arg, len, op, value)| SeccompCondition::new(arg, len, op, value).map_err(error)).collect::<Result<Vec<_>, _>>()?;
        SeccompRule::new(conditions).map_err(error)
    };
    let compile = |rules: BTreeMap<i64, Vec<SeccompRule>>, action: SeccompAction| -> Result<seccompiler::BpfProgram, String> {
        let filter = SeccompFilter::new(rules, SeccompAction::Allow, action, TargetArch::x86_64).map_err(error)?;
        filter.try_into().map_err(|e: seccompiler::BackendError| e.to_string())
    };
    // SAFETY: getpid has no preconditions.
    let me = unsafe { libc::getpid() } as u32 as u64;
    let mut refused: BTreeMap<i64, Vec<SeccompRule>> = REFUSED.iter().map(|&n| (n, Vec::new())).collect();
    // clone without CLONE_THREAD is a new process.
    refused.insert(libc::SYS_clone, vec![when(vec![(0, Len::Qword, Op::MaskedEq(libc::CLONE_THREAD as u64), 0)])?]);
    // A signal to anything but this process (kill's 0 and -1 are groups and everyone).
    for call in [libc::SYS_kill, libc::SYS_tgkill, libc::SYS_rt_sigqueueinfo, libc::SYS_rt_tgsigqueueinfo] {
        refused.insert(call, vec![when(vec![(0, Len::Dword, Op::Ne, me)])?]);
    }
    // Limits read or set for any process but this one (0 is this one).
    refused.insert(libc::SYS_prlimit64, vec![when(vec![(0, Len::Dword, Op::Ne, 0), (0, Len::Dword, Op::Ne, me)])?]);
    // A file's signals sent to a chosen process: F_SETOWN, F_SETSIG and
    // F_SETOWN_EX (Linux's numbers; musl's libc names only the first).
    refused.insert(libc::SYS_fcntl, [8u64, 10, 15].into_iter().map(|cmd| when(vec![(1, Len::Dword, Op::Eq, cmd)])).collect::<Result<_, _>>()?);
    // Typing into a terminal.
    refused.insert(
        libc::SYS_ioctl,
        [libc::TIOCSTI as u64, libc::TIOCLINUX as u64].into_iter().map(|cmd| when(vec![(1, Len::Dword, Op::Eq, cmd)])).collect::<Result<_, _>>()?,
    );
    let clone3: BTreeMap<i64, Vec<SeccompRule>> = [(libc::SYS_clone3, Vec::new())].into_iter().collect();
    let second = compile(clone3, SeccompAction::Errno(libc::ENOSYS as u32))?;
    let third = compile(refused, SeccompAction::Errno(libc::EPERM as u32))?;
    seccompiler::apply_filter_all_threads(&other_abis()).map_err(|e| e.to_string())?;
    seccompiler::apply_filter_all_threads(&second).map_err(|e| e.to_string())?;
    seccompiler::apply_filter_all_threads(&third).map_err(|e| e.to_string())
}

/// EPERM for every system call that is not x86-64's own: another
/// architecture's (i386, through `int 0x80`), or x86-64's with the x32 bit,
/// whose numbers (`execve` is 0x40000208) no rule keyed on x86-64's matches.
/// seccompiler's filters check the architecture alone, so this one is built
/// here: load the architecture, then the number.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn other_abis() -> Vec<seccompiler::sock_filter> {
    const LD_W_ABS: u16 = 0x20; // BPF_LD | BPF_W | BPF_ABS
    const JEQ_K: u16 = 0x15; // BPF_JMP | BPF_JEQ | BPF_K
    const JGE_K: u16 = 0x35; // BPF_JMP | BPF_JGE | BPF_K
    const RET_K: u16 = 0x06; // BPF_RET | BPF_K
    const AUDIT_ARCH_X86_64: u32 = 0xC000_003E;
    const X32_SYSCALL_BIT: u32 = 0x4000_0000;
    const RET_ALLOW: u32 = 0x7fff_0000;
    let ret_eperm = 0x0005_0000 | libc::EPERM as u32; // SECCOMP_RET_ERRNO
    let op = |code, jt, jf, k| seccompiler::sock_filter { code, jt, jf, k };
    vec![
        op(LD_W_ABS, 0, 0, 4), // seccomp_data.arch
        op(JEQ_K, 1, 0, AUDIT_ARCH_X86_64),
        op(RET_K, 0, 0, ret_eperm),
        op(LD_W_ABS, 0, 0, 0), // seccomp_data.nr
        op(JGE_K, 0, 1, X32_SYSCALL_BIT),
        op(RET_K, 0, 0, ret_eperm),
        op(RET_K, 0, 0, RET_ALLOW),
    ]
}

/// A folder outside the backend that this process can list before the
/// lockdown, for `--check-lockdown` to try again after it.
pub fn outside(root: &Path) -> Option<PathBuf> {
    [root.parent().map(Path::to_path_buf), Some(PathBuf::from("/etc")), Some(PathBuf::from("/"))]
        .into_iter()
        .flatten()
        .find(|dir| std::fs::read_dir(dir).is_ok())
}

/// What `--check-lockdown` tries once the lockdown is on, each answered
/// "denied" (refused with the error the lockdown gives), "allowed", or, for a
/// probe that could not be made, "untried": `outside`, a folder listed before
/// the lockdown; a socket; a new process; running a program; a signal to the
/// process that started this one; changing a mode by path; a symbolic link;
/// and an x32 system call.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub fn probes(root: &Path, outside: Option<&Path>) -> serde_json::Value {
    let errno = || std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
    let said = |denied: bool| if denied { "denied" } else { "allowed" };
    let outside = match outside {
        // Landlock refuses with EACCES; this folder was listed before it.
        Some(dir) => match std::fs::read_dir(dir) {
            Ok(_) => "allowed",
            Err(e) if e.raw_os_error() == Some(libc::EACCES) => "denied",
            Err(_) => "untried",
        },
        None => "untried",
    };
    // SAFETY: plain system calls; a socket, child or link that is made is closed, ended or removed at once.
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
    // Signal 0 asks only whether a signal could be sent; both ways of sending one.
    let signal = unsafe {
        let parent = libc::getppid();
        let kill = libc::kill(parent, 0) != 0 && errno() == libc::EPERM;
        let tkill = libc::syscall(libc::SYS_tkill, parent, 0) != 0 && errno() == libc::EPERM;
        kill && tkill
    };
    // The backend folder's own mode, set to what it is: refused, or no change.
    let chmod = {
        use std::os::unix::{ffi::OsStrExt, fs::PermissionsExt};
        match (std::fs::metadata(root), std::ffi::CString::new(root.as_os_str().as_bytes())) {
            (Ok(meta), Ok(path)) => unsafe { libc::chmod(path.as_ptr(), meta.permissions().mode() & 0o7777) != 0 && errno() == libc::EPERM },
            _ => false,
        }
    };
    // seccomp answers EPERM, Landlock (without it) EACCES; one that is made goes again.
    let symlink = {
        let link = root.join("private/data/.softn-runner-probe");
        match std::os::unix::fs::symlink("/", &link) {
            Ok(()) => {
                let _ = std::fs::remove_file(&link);
                false
            }
            Err(e) => matches!(e.raw_os_error(), Some(libc::EPERM) | Some(libc::EACCES)),
        }
    };
    // getpid's number with the x32 bit: EPERM from the filter, whether or not this kernel has x32.
    let x32 = unsafe { libc::syscall(0x4000_0000 | libc::SYS_getpid) < 0 && errno() == libc::EPERM };
    serde_json::json!({
        "outside": outside,
        "socket": said(socket),
        "fork": said(fork),
        "exec": said(exec),
        "signal": said(signal),
        "chmod": said(chmod),
        "symlink": said(symlink),
        "x32": said(x32),
    })
}

#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
pub fn probes(_root: &Path, _outside: Option<&Path>) -> serde_json::Value {
    serde_json::json!({})
}
