// A library for softn.wasm.load and softn.wasm.call: numbers summarised as
// JSON, and primes counted, in Rust.
//
// rustc --target wasm32-unknown-unknown --crate-type cdylib -C opt-level=z -C panic=abort stats.rs

use std::cell::RefCell;

thread_local! {
    // The last answer, kept until the next call: SoftN copies it out first.
    static ANSWER: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Memory SoftN copies a text argument into; the module owns it after the call.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buffer: Vec<u8> = Vec::with_capacity(len.max(1));
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    ptr
}

fn take(ptr: *mut u8, len: usize) -> String {
    let bytes = unsafe { Vec::from_raw_parts(ptr, len, len.max(1)) };
    String::from_utf8_lossy(&bytes).into_owned()
}

/// An answer, as where it is << 32 | how long it is.
fn answer(text: String) -> u64 {
    ANSWER.with(|a| {
        *a.borrow_mut() = text.into_bytes();
        let a = a.borrow();
        ((a.as_ptr() as u64) << 32) | a.len() as u64
    })
}

fn round(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

/// "12, 7, 3.5" in, {"count":3,"sum":22.5,"mean":7.5,…} out: call it with { returns: "json" }.
#[no_mangle]
pub extern "C" fn stats(ptr: *mut u8, len: usize) -> u64 {
    let text = take(ptr, len);
    let mut values: Vec<f64> = text
        .split(|c: char| c == ',' || c == ';' || c.is_whitespace())
        .filter_map(|s| s.trim().parse::<f64>().ok())
        .filter(|v| v.is_finite())
        .collect();
    if values.is_empty() {
        return answer("{\"count\":0}".to_string());
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = values.len() as f64;
    let sum: f64 = values.iter().sum();
    let mean = sum / n;
    let mid = values.len() / 2;
    let median = if values.len() % 2 == 1 { values[mid] } else { (values[mid - 1] + values[mid]) / 2.0 };
    let variance = values.iter().map(|v| (v - mean) * (v - mean)).sum::<f64>() / n;
    answer(format!(
        "{{\"count\":{},\"sum\":{},\"mean\":{},\"median\":{},\"min\":{},\"max\":{},\"stdev\":{}}}",
        values.len(),
        round(sum),
        round(mean),
        round(median),
        values[0],
        values[values.len() - 1],
        round(variance.sqrt())
    ))
}

/// How many primes are below `limit`, by the sieve of Eratosthenes.
#[no_mangle]
pub extern "C" fn count_primes(limit: i32) -> i32 {
    if limit < 3 {
        return 0;
    }
    let n = limit as usize;
    let mut composite = vec![false; n];
    let mut count = 0;
    for i in 2..n {
        if !composite[i] {
            count += 1;
            // i * i < n, asked without working out i * i: on wasm32 a usize is
            // 32 bits, and past 65,535 the square would wrap round and strike
            // out primes.
            if i <= (n - 1) / i {
                let mut j = i * i;
                while j < n {
                    composite[j] = true;
                    j += i;
                }
            }
        }
    }
    count
}
