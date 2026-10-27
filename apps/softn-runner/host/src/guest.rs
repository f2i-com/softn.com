//! The guest (../guest, ZIPP for WASI), run under wasmtime: one instance per
//! job, dropped with it.
//!
//! * **Linear memory.** A `StoreLimits` ceiling on the instance's memory,
//!   enforced by wasmtime: what the host gave a request (limits.rs, 1 GiB
//!   unless it says less). The engine's own accounting stops a script 64 MiB
//!   below it (512 MiB at most), and says why ("script exceeded its memory
//!   budget"); this is the wall behind it, for an allocation larger than the
//!   room left, where the engine stops and says less.
//! * **No capabilities.** The WASI context has the clock and randomness and
//!   nothing else: no directory, no environment, no stdio. The guest reaches
//!   the runner through the two `softn` imports alone, and the runner answers
//!   them.
//! * **The deadline.** The process's (main.rs), as the Node runner's is, and
//!   before it an epoch that traps a guest still running near it.
//!
//! The guest is precompiled at build time (build.rs) and embedded, so an
//! instance is a deserialise and an instantiate, not a compile. On Linux its
//! code runs where it lies in this program's read-only data (`InPlace`):
//! deserialising copied all 20 MB of it into fresh memory in every process,
//! and read the 20 MB it came from as well: about 32 of a plain request's
//! 47 MB at its peak, and 9 of its 40 ms (Linux, musl build).

use serde_json::Value;
use wasmtime::{Caller, Engine, Linker, Module, Store, StoreLimits, StoreLimitsBuilder};
use wasmtime_wasi::p1::WasiP1Ctx;
use wasmtime_wasi::WasiCtxBuilder;

use crate::HostError;

include!("engine_config.rs");

/// The precompiled guest. On Unix it is aligned, so that its code can be made
/// executable where it lies (wasmtime places the code at a page boundary of
/// the image). Not on Windows, which copies it (below): rustc 1.99 aborted
/// building the aligned form there (STATUS_ILLEGAL_INSTRUCTION, fat LTO).
#[cfg(unix)]
#[repr(C, align(65536))]
struct Aligned<T: ?Sized>(T);
#[cfg(unix)]
static GUEST_ALIGNED: &Aligned<[u8]> = &Aligned(*include_bytes!(concat!(env!("OUT_DIR"), "/guest.cwasm")));
#[cfg(unix)]
static GUEST: &[u8] = &GUEST_ALIGNED.0;
#[cfg(not(unix))]
static GUEST: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/guest.cwasm"));

/// The guest's code made executable in place, in this program's own pages:
/// they stay the file's, shared by every runner the system has running, and
/// only the code a request runs is read from disk. wasmtime asks for no
/// write to them (nothing is relocated in a precompiled module).
#[cfg(unix)]
struct InPlace;

#[cfg(unix)]
impl wasmtime::CustomCodeMemory for InPlace {
    fn required_alignment(&self) -> usize {
        IN_PLACE_PAGE
    }

    fn publish_executable(&self, ptr: *const u8, len: usize) -> wasmtime::Result<()> {
        // SAFETY: wasmtime hands over a page-aligned range of the guest's code,
        // inside GUEST, which lives as long as the process.
        if unsafe { libc::mprotect(ptr as *mut libc::c_void, len, libc::PROT_READ | libc::PROT_EXEC) } != 0 {
            wasmtime::bail!("mprotect: {}", std::io::Error::last_os_error());
        }
        Ok(())
    }

    fn unpublish_executable(&self, ptr: *const u8, len: usize) -> wasmtime::Result<()> {
        // SAFETY: as above.
        if unsafe { libc::mprotect(ptr as *mut libc::c_void, len, libc::PROT_READ) } != 0 {
            wasmtime::bail!("mprotect: {}", std::io::Error::last_os_error());
        }
        Ok(())
    }
}

/// The page size the guest's code is aligned to in the image, and so the only
/// one it can be used in place with.
#[cfg(unix)]
const IN_PLACE_PAGE: usize = 4096;

/// What one message from the guest may be: a host call's 32 MiB of
/// arguments, as the engine bounds them, and its operation's name.
const MAX_MESSAGE_BYTES: usize = 32 * 1024 * 1024 + 4096;

/// A `db.query` call: the operation and its arguments as JSON, answered with JSON.
pub type CallHandler = Box<dyn FnMut(&str, &str) -> String>;

thread_local! {
    /// The job's call handler. It holds the request's database connection,
    /// which is not `Send`, so it lives here for the job rather than in the
    /// store (whose data wasmtime-wasi wants `Send`); the store never leaves
    /// this thread either.
    static CALL: std::cell::RefCell<Option<CallHandler>> = const { std::cell::RefCell::new(None) };
}

struct State {
    wasi: WasiP1Ctx,
    limits: StoreLimits,
    job: Vec<u8>,
    answer: Vec<u8>,
    outcome: Option<Vec<u8>>,
}

pub struct Guest {
    engine: Engine,
    module: Module,
}

impl Guest {
    /// The guest, in place where this system allows it, else copied; and the
    /// epoch ticker that stops it near the deadline.
    pub fn load() -> Result<Self, HostError> {
        #[cfg(unix)]
        let guest = match Self::load_in_place() {
            Some(guest) => guest,
            None => Self::load_copied()?,
        };
        #[cfg(not(unix))]
        let guest = Self::load_copied()?;
        guest.start_ticker();
        Ok(guest)
    }

    /// The guest's code used where it lies, or None where the system will
    /// not have it so: another page size, or a policy that refuses to make
    /// those pages executable (which the copy below needs of fresh ones too).
    ///
    /// Made once a process and kept for it: the pages are one, and two
    /// modules over them cannot be (a module's drop makes its pages
    /// unexecutable, and wasmtime registers each module's code by its
    /// address); a test process, which loads the guest more than once,
    /// aborted with two.
    #[cfg(unix)]
    fn load_in_place() -> Option<Self> {
        static IN_PLACE: std::sync::OnceLock<Option<(Engine, Module)>> = std::sync::OnceLock::new();
        let (engine, module) = IN_PLACE
            .get_or_init(|| {
                // SAFETY: sysconf has no preconditions.
                if usize::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).ok() != Some(IN_PLACE_PAGE) {
                    return None;
                }
                let mut config = base_engine_config();
                config.with_custom_code_memory(Some(std::sync::Arc::new(InPlace)));
                let engine = Engine::new(&config).ok()?;
                // SAFETY: GUEST was produced by build.rs from the guest module
                // with this configuration and embedded at build time, never
                // data that arrived at run time; it lives, unchanged, as long
                // as the process, and so does this module, kept here.
                let module = unsafe { Module::deserialize_raw(&engine, std::ptr::NonNull::from(GUEST)) }.ok()?;
                Some((engine, module))
            })
            .clone()?;
        Some(Self { engine, module })
    }

    /// The guest's code copied into memory of wasmtime's own.
    fn load_copied() -> Result<Self, HostError> {
        let engine = Engine::new(&base_engine_config()).map_err(|e| HostError::Library(format!("guest engine: {e}")))?;
        // SAFETY: as in load_in_place.
        let module = unsafe { Module::deserialize(&engine, GUEST) }.map_err(|e| HostError::Library(format!("guest did not load: {e}")))?;
        Ok(Self { engine, module })
    }

    fn start_ticker(&self) {
        // From the soft deadline (main.rs) on, a tick every few milliseconds:
        // an instance's deadline is one tick past the epoch it started at, so
        // one tick alone would never stop an instance started after it (a
        // request that waited for the database lock, or for migrations).
        let ticker = self.engine.clone();
        std::thread::spawn(move || {
            std::thread::sleep(crate::soft_deadline().saturating_duration_since(std::time::Instant::now()));
            loop {
                ticker.increment_epoch();
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        });
    }

    /// Run one job and return the guest's outcome. `call` answers its
    /// `db.query` calls; a job with no grant never makes one.
    pub fn run(&self, job: &Value, call: CallHandler) -> Result<Value, HostError> {
        // Past the soft deadline (a long lock wait, slow migrations) there is
        // no time left to run the logic and still answer.
        if std::time::Instant::now() >= crate::soft_deadline() {
            return Err(HostError::Library("the logic ran until the deadline".into()));
        }
        let limits = StoreLimitsBuilder::new()
            .memory_size(crate::limits::limits().memory)
            .instances(1)
            .tables(8)
            .memories(1)
            .trap_on_grow_failure(false)
            .build();
        let state = State {
            wasi: WasiCtxBuilder::new().build_p1(),
            limits,
            job: job.to_string().into_bytes(),
            answer: Vec::new(),
            outcome: None,
        };
        CALL.with(|slot| *slot.borrow_mut() = Some(call));
        let result = self.run_store(state);
        CALL.with(|slot| *slot.borrow_mut() = None);
        result
    }

    fn run_store(&self, state: State) -> Result<Value, HostError> {
        let mut store = Store::new(&self.engine, state);
        store.limiter(|s| &mut s.limits);
        store.set_epoch_deadline(1);

        let mut linker: Linker<State> = Linker::new(&self.engine);
        wasmtime_wasi::p1::add_to_linker_sync(&mut linker, |s: &mut State| &mut s.wasi)
            .map_err(|e| HostError::Library(format!("guest WASI: {e}")))?;
        linker
            .func_wrap("softn", "ask", |mut caller: Caller<'_, State>, kind: i32, ptr: i32, len: i32| -> i32 {
                ask(&mut caller, kind, ptr, len).unwrap_or(-1)
            })
            .map_err(|e| HostError::Library(format!("guest import: {e}")))?;
        linker
            .func_wrap("softn", "take", |mut caller: Caller<'_, State>, ptr: i32| {
                let answer = std::mem::take(&mut caller.data_mut().answer);
                if let Some(memory) = caller.get_export("memory").and_then(|e| e.into_memory()) {
                    let _ = memory.write(&mut caller, ptr as u32 as usize, &answer);
                }
            })
            .map_err(|e| HostError::Library(format!("guest import: {e}")))?;

        let instance = linker.instantiate(&mut store, &self.module).map_err(|e| HostError::Library(format!("guest instantiate: {e}")))?;
        let start = instance
            .get_typed_func::<(), ()>(&mut store, "_start")
            .map_err(|e| HostError::Library(format!("guest entry: {e}")))?;
        if let Err(e) = start.call(&mut store, ()) {
            let clean = e.downcast_ref::<wasmtime_wasi::I32Exit>().is_some_and(|exit| exit.0 == 0);
            if !clean {
                return Err(HostError::Library(match e.downcast_ref::<wasmtime::Trap>() {
                    Some(wasmtime::Trap::UnreachableCodeReached) => "the engine stopped (a guest panic or an allocation it could not make)".into(),
                    Some(wasmtime::Trap::Interrupt) => "the logic ran until the deadline".into(),
                    Some(trap) => format!("the engine trapped: {trap}"),
                    None => format!("the engine failed: {e:#}"),
                }));
            }
        }
        let outcome = store.into_data().outcome.ok_or_else(|| HostError::Library("the engine gave no outcome".into()))?;
        serde_json::from_slice(&outcome).map_err(|_| HostError::Library("the engine gave an unreadable outcome".into()))
    }
}

/// The guest's `ask`: read its message, answer it, and say how long the answer is.
fn ask(caller: &mut Caller<'_, State>, kind: i32, ptr: i32, len: i32) -> Option<i32> {
    let len = usize::try_from(len).ok().filter(|n| *n <= MAX_MESSAGE_BYTES)?;
    let memory = caller.get_export("memory").and_then(|e| e.into_memory())?;
    let mut message = vec![0u8; len];
    memory.read(&*caller, ptr as u32 as usize, &mut message).ok()?;
    let state = caller.data_mut();
    let answer = match kind {
        0 => state.job.clone(),
        1 => {
            let split = message.iter().position(|b| *b == 0)?;
            let op = std::str::from_utf8(&message[..split]).ok()?;
            let args = std::str::from_utf8(&message[split + 1..]).ok()?;
            CALL.with(|slot| slot.borrow_mut().as_mut().map(|call| call(op, args)))?.into_bytes()
        }
        2 => {
            state.outcome = Some(message);
            Vec::new()
        }
        _ => return None,
    };
    let length = i32::try_from(answer.len()).ok()?;
    state.answer = answer;
    Some(length)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A validate job: compile `source` (its top level runs) and look for `ping`.
    fn validate(guest: &Guest, source: &str, heap: u64) -> Value {
        let job = serde_json::json!({ "mode": "validate", "source": source, "config": "{}", "handlers": ["ping"], "steps": 1_000_000, "heap": heap, "grant": false });
        guest.run(&job, Box::new(|_, _| "null".into())).expect("the guest answers")
    }

    #[test]
    fn the_guest_runs_in_place_and_copied_alike() {
        let source = "function ping(req) { return { status: 200 }; }";
        // In place wherever the system has 4 KiB pages and lets them be made
        // executable (every Linux x86-64 this runner is built for).
        #[cfg(all(unix, target_arch = "x86_64"))]
        {
            let guest = Guest::load_in_place().expect("the guest's code used in place");
            assert_eq!(validate(&guest, source, 64 << 20), serde_json::json!({ "ok": true }));
        }
        let guest = Guest::load_copied().expect("the guest copied");
        assert_eq!(validate(&guest, source, 64 << 20), serde_json::json!({ "ok": true }));
    }

    #[test]
    fn a_script_is_held_to_the_heap_the_runner_gives_it() {
        let guest = Guest::load().expect("the guest");
        // 100 MB in one allocation at its top level (one, so that no
        // iteration limit stops it first): past a 64 MiB heap the engine stops
        // the script, and says why; within 512 MiB it is made.
        let source = "var big = new ArrayBuffer(100 * 1024 * 1024);\nfunction ping(req) { return { status: 200 }; }";
        let small = validate(&guest, source, 64 << 20);
        assert_eq!(small["ok"], false, "{small}");
        assert!(small["error"].as_str().unwrap_or("").contains("script exceeded its memory budget"), "{small}");
        assert_eq!(validate(&guest, source, 512 << 20), serde_json::json!({ "ok": true }));
    }
}