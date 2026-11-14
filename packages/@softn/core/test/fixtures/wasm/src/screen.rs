// A program for <WasmApp>'s tests: it draws a 64x48 frame, moves a square
// with the arrow keys, follows the pointer, beeps, and talks to the app.
// Built by ../build.mjs: rustc --target wasm32-unknown-unknown --crate-type cdylib.

use std::cell::RefCell;

#[link(wasm_import_module = "softn")]
extern "C" {
    fn present(ptr: *const u8, width: u32, height: u32);
    fn post(ptr: *const u8, len: usize);
    fn log(ptr: *const u8, len: usize);
    fn audio(ptr: *const f32, frames: u32);
    fn audio_rate() -> u32;
}

const W: usize = 64;
const H: usize = 48;

struct State {
    pixels: Vec<u8>,
    x: i32,
    y: i32,
    frames: u32,
    pointer: (f32, f32),
    sound: Vec<f32>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State {
        pixels: vec![0; W * H * 4],
        x: 10,
        y: 10,
        frames: 0,
        pointer: (0.0, 0.0),
        sound: Vec::new(),
    });
}

fn say(text: &str) {
    unsafe { post(text.as_ptr(), text.len()) }
}

#[no_mangle]
pub extern "C" fn frame(time: f64) {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.frames += 1;
        let (x, y) = (s.x, s.y);
        let shade = (time as u32 % 256) as u8;
        for py in 0..H {
            for px in 0..W {
                let i = (py * W + px) * 4;
                let inside = (px as i32) >= x && (px as i32) < x + 4 && (py as i32) >= y && (py as i32) < y + 4;
                let rgba = if inside { [255, 255, 255, 255] } else { [px as u8 * 4, py as u8 * 5, shade, 255] };
                s.pixels[i..i + 4].copy_from_slice(&rgba);
            }
        }
        unsafe { present(s.pixels.as_ptr(), W as u32, H as u32) }
        if s.frames == 3 {
            say("third frame");
        }
    });
}

/// USB HID codes, as SDL's scancodes: 79 right, 80 left, 81 down, 82 up, 44 space.
#[no_mangle]
pub extern "C" fn key(code: i32, down: i32) {
    if down == 0 {
        return;
    }
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        match code {
            79 => s.x += 1,
            80 => s.x -= 1,
            81 => s.y += 1,
            82 => s.y -= 1,
            44 => {
                let rate = unsafe { audio_rate() } as usize;
                let frames = rate / 20;
                s.sound = (0..frames)
                    .flat_map(|i| {
                        let v = ((i as f32) * 440.0 * std::f32::consts::TAU / rate as f32).sin() * 0.2;
                        [v, v]
                    })
                    .collect();
                unsafe { audio(s.sound.as_ptr(), frames as u32) }
            }
            _ => {}
        }
        let at = format!("at {},{}", s.x, s.y);
        say(&at);
    });
}

#[no_mangle]
pub extern "C" fn pointer(_id: i32, phase: i32, x: f32, y: f32, _buttons: i32) {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.pointer = (x, y);
        if phase == 1 {
            let text = format!("down {:.1},{:.1}", x, y);
            drop(s);
            say(&text);
        }
    });
}

/// Text from the app's logic.
#[no_mangle]
pub extern "C" fn message(ptr: *mut u8, len: usize) {
    let text = unsafe { String::from_utf8(Vec::from_raw_parts(ptr, len, len.max(1))).unwrap() };
    let line = format!("got {}", text);
    unsafe { log(line.as_ptr(), line.len()) }
    say(&format!("echo {}", text));
}

#[no_mangle]
pub extern "C" fn position() -> i64 {
    STATE.with(|s| {
        let s = s.borrow();
        ((s.x as i64) << 32) | (s.y as u32 as i64)
    })
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buffer: Vec<u8> = Vec::with_capacity(len.max(1));
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    ptr
}
