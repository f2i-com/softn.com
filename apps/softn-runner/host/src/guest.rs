//! The guest (../guest, ZIPP for WASI), run under wasmtime: one instance per
//! job, dropped with it.
//!
//! * **Linear memory.** A `StoreLimits` ceiling on the instance's memory,
//!   enforced by wasmtime. The engine's own accounting stops a script at
//!   512 MiB with a catchable RangeError; this is the wall behind it.
//! * **No capabilities.** The WASI context has the clock and randomness and
//!   nothing else: no directory, no environment, no stdio. The guest reaches
//!   the runner through the two `softn` imports alone, and the runner answers
//!   them.
//! * **The deadline.** The process's (main.rs), as the Node runner's is, and
//!   before it an epoch that traps a guest still running near it.
//!
//! The guest is precompiled at build time (build.rs) and embedded, so an
//! instance is a deserialise and an instantiate, not a compile.

use serde_json::Value;
use wasmtime::{Caller, Engine, Linker, Module, Store, StoreLimits, StoreLimitsBuilder};
use wasmtime_wasi::p1::WasiP1Ctx;
use wasmtime_wasi::WasiCtxBuilder;

use crate::HostError;

include!("engine_config.rs");

static GUEST: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/guest.cwasm"));

/// The guest's linear-memory ceiling: the engine's 512 MiB heap accounting
/// and its 16 MiB stack, with room for what the accounting does not count.
const MEMORY_BYTES: usize = 1024 * 1024 * 1024;
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
    pub fn load() -> Result<Self, HostError> {
        let engine = Engine::new(&base_engine_config()).map_err(|e| HostError::Library(format!("guest engine: {e}")))?;
        // SAFETY: GUEST was produced by build.rs from the guest module with
        // this configuration and embedded at build time. It is never data
        // that arrived at run time.
        let module = unsafe { Module::deserialize(&engine, GUEST) }.map_err(|e| HostError::Library(format!("guest did not load: {e}")))?;
        // One tick at the soft deadline (main.rs) trips every instance's deadline of one.
        let ticker = engine.clone();
        std::thread::spawn(move || {
            std::thread::sleep(crate::soft_deadline().saturating_duration_since(std::time::Instant::now()));
            ticker.increment_epoch();
        });
        Ok(Self { engine, module })
    }

    /// Run one job and return the guest's outcome. `call` answers its
    /// `db.query` calls; a job with no grant never makes one.
    pub fn run(&self, job: &Value, call: CallHandler) -> Result<Value, HostError> {
        let limits = StoreLimitsBuilder::new()
            .memory_size(MEMORY_BYTES)
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
