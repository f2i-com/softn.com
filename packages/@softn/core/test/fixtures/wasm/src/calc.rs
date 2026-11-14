// A library for softn.wasm.load and softn.wasm.call's tests: plain exported
// functions, numbers in and out, text and JSON through memory.
// Built by ../build.mjs: rustc --target wasm32-unknown-unknown --crate-type cdylib.

use std::cell::RefCell;

thread_local! {
    static COUNT: RefCell<i32> = const { RefCell::new(0) };
    // The last answer, kept until the next call: SoftN copies it out first.
    static ANSWER: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[no_mangle]
pub extern "C" fn add(a: i32, b: i32) -> i32 {
    a.wrapping_add(b)
}

#[no_mangle]
pub extern "C" fn add64(a: i64, b: i64) -> i64 {
    a.wrapping_add(b)
}

#[no_mangle]
pub extern "C" fn scale(x: f64, by: f64) -> f64 {
    x * by
}

#[no_mangle]
pub extern "C" fn count() -> i32 {
    COUNT.with(|c| {
        *c.borrow_mut() += 1;
        *c.borrow()
    })
}

#[no_mangle]
pub extern "C" fn divide(a: i32, b: i32) -> i32 {
    if b == 0 {
        panic!("divide by zero");
    }
    a / b
}

/// Memory for an argument SoftN copies in: the module owns it after the call.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buffer: Vec<u8> = Vec::with_capacity(len.max(1));
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    ptr
}

/// Gives back memory alloc gave; capacity is what alloc made it.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
}

fn take(ptr: *mut u8, len: usize) -> String {
    let bytes = unsafe { Vec::from_raw_parts(ptr, len, len.max(1)) };
    String::from_utf8(bytes).unwrap()
}

fn answer(bytes: Vec<u8>) -> u64 {
    ANSWER.with(|a| {
        *a.borrow_mut() = bytes;
        let a = a.borrow();
        ((a.as_ptr() as u64) << 32) | a.len() as u64
    })
}

/// A text in, the same text shouted out: where << 32 | length.
#[no_mangle]
pub extern "C" fn shout(ptr: *mut u8, len: usize) -> u64 {
    answer(take(ptr, len).to_uppercase().into_bytes())
}

/// Numbers written "1,2,3" in, {"count":3,"sum":6} out.
#[no_mangle]
pub extern "C" fn stats(ptr: *mut u8, len: usize) -> u64 {
    let text = take(ptr, len);
    let numbers: Vec<f64> = text.split(',').filter_map(|s| s.trim().parse().ok()).collect();
    let sum: f64 = numbers.iter().sum();
    answer(format!("{{\"count\":{},\"sum\":{}}}", numbers.len(), sum).into_bytes())
}

/// An answer the caller frees: a fresh allocation each call.
#[no_mangle]
pub extern "C" fn repeat(ptr: *mut u8, len: usize, times: i32) -> u64 {
    let text = take(ptr, len).repeat(times.max(0) as usize);
    let mut bytes = text.into_bytes();
    bytes.shrink_to_fit();
    let packed = ((bytes.as_ptr() as u64) << 32) | bytes.len() as u64;
    std::mem::forget(bytes);
    packed
}

static GREETING: &[u8] = b"hello from calc\0";

/// A C string: where it starts, ended by a 0 byte.
#[no_mangle]
pub extern "C" fn greeting() -> *const u8 {
    GREETING.as_ptr()
}

/// Bytes in, their sum out.
#[no_mangle]
pub extern "C" fn checksum(ptr: *mut u8, len: usize) -> u32 {
    let bytes = unsafe { Vec::from_raw_parts(ptr, len, len.max(1)) };
    bytes.iter().map(|&b| b as u32).sum()
}
