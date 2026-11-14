// A brick-breaking game for <WasmApp>, in Rust without the standard library:
// a 240x180 frame of pixels handed to softn.present each frame, the paddle on
// the arrow keys (or A and D) or the pointer, Space or a press to launch, a
// beep on each hit, and the score posted to the app, which shows it.
//
// rustc --target wasm32-unknown-unknown --crate-type cdylib -C opt-level=z -C panic=abort game.rs

#![no_std]

use core::panic::PanicInfo;
use core::ptr::addr_of_mut;

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

#[link(wasm_import_module = "softn")]
extern "C" {
    fn present(ptr: *const u8, width: u32, height: u32);
    fn post(ptr: *const u8, len: usize);
    fn audio(ptr: *const f32, frames: u32);
    fn audio_rate() -> u32;
}

const W: usize = 240;
const H: usize = 180;
const COLS: usize = 10;
const ROWS: usize = 6;
const BRICK_W: f32 = 22.0;
const BRICK_H: f32 = 8.0;
const GAP: f32 = 2.0;
const LEFT: f32 = 1.0;
const TOP: f32 = 22.0;
const PADDLE_Y: f32 = 166.0;
const PADDLE_H: f32 = 4.0;
const BALL: f32 = 4.0;
const ROW_COLOURS: [[u8; 3]; ROWS] = [
    [244, 63, 94],
    [249, 115, 22],
    [234, 179, 8],
    [132, 204, 22],
    [34, 211, 238],
    [167, 139, 250],
];

#[derive(PartialEq, Clone, Copy)]
enum State {
    Playing,
    Over,
    Cleared,
}

struct Game {
    bricks: [bool; COLS * ROWS],
    paddle_x: f32,
    paddle_w: f32,
    ball_x: f32,
    ball_y: f32,
    vx: f32,
    vy: f32,
    attached: bool,
    left: bool,
    right: bool,
    score: u32,
    lives: u32,
    level: u32,
    speed: f32,
    last: f64,
    state: State,
    text: [u8; 32],
}

// The frame and the sound are statics of their own, all zeros: they take no
// room in the .wasm file, where a struct with any other value would.
static mut PIXELS: [u8; W * H * 4] = [0; W * H * 4];
static mut SOUND: [f32; 4800] = [0.0; 4800];

static mut GAME: Game = Game {
    bricks: [true; COLS * ROWS],
    paddle_x: 120.0,
    paddle_w: 38.0,
    ball_x: 118.0,
    ball_y: PADDLE_Y - BALL,
    vx: 0.0,
    vy: 0.0,
    attached: true,
    left: false,
    right: false,
    score: 0,
    lives: 3,
    level: 1,
    speed: 1.0,
    last: 0.0,
    state: State::Playing,
    text: [0; 32],
};

// One worker runs one copy of this program, one call at a time.
fn game() -> &'static mut Game {
    unsafe { &mut *addr_of_mut!(GAME) }
}

fn pixels() -> &'static mut [u8; W * H * 4] {
    unsafe { &mut *addr_of_mut!(PIXELS) }
}

fn sound() -> &'static mut [f32; 4800] {
    unsafe { &mut *addr_of_mut!(SOUND) }
}

/// Posts "name:number" to the app.
fn say_number(g: &mut Game, name: &[u8], value: u32) {
    let mut at = 0;
    for &b in name {
        g.text[at] = b;
        at += 1;
    }
    g.text[at] = b':';
    at += 1;
    let mut digits = [0u8; 10];
    let mut n = value;
    let mut count = 0;
    loop {
        digits[count] = b'0' + (n % 10) as u8;
        count += 1;
        n /= 10;
        if n == 0 {
            break;
        }
    }
    while count > 0 {
        count -= 1;
        g.text[at] = digits[count];
        at += 1;
    }
    unsafe { post(g.text.as_ptr(), at) }
}

/// A square root by Newton's method: without the standard library, f32 has none.
fn f32_sqrt(x: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }
    let mut r = if x > 1.0 { x / 2.0 } else { 1.0 };
    for _ in 0..20 {
        r = 0.5 * (r + x / r);
    }
    r
}

fn say(text: &[u8]) {
    unsafe { post(text.as_ptr(), text.len()) }
}

/// A short square-wave beep that dies away.
fn beep(pitch: f32, ms: u32) {
    let samples = sound();
    let rate = unsafe { audio_rate() } as f32;
    let frames = ((rate * ms as f32 / 1000.0) as usize).min(samples.len() / 2);
    let period = rate / pitch;
    for i in 0..frames {
        let phase = (i as f32 % period) / period;
        let fade = 1.0 - i as f32 / frames as f32;
        let v = if phase < 0.5 { 0.12 } else { -0.12 } * fade;
        samples[i * 2] = v;
        samples[i * 2 + 1] = v;
    }
    unsafe { audio(samples.as_ptr(), frames as u32) }
}

fn base_speed(g: &Game) -> f32 {
    (150.0 + 18.0 * (g.level as f32 - 1.0)) * g.speed
}

fn start_level(g: &mut Game) {
    for brick in g.bricks.iter_mut() {
        *brick = true;
    }
    g.attached = true;
    g.state = State::Playing;
}

fn new_game(g: &mut Game) {
    g.score = 0;
    g.lives = 3;
    g.level = 1;
    start_level(g);
    say_number(g, b"score", 0);
    say_number(g, b"lives", 3);
    say(b"ready");
}

fn launch(g: &mut Game) {
    match g.state {
        State::Over => new_game(g),
        State::Cleared => {
            g.level += 1;
            start_level(g);
            say_number(g, b"level", g.level);
        }
        State::Playing => {
            if g.attached {
                g.attached = false;
                let base = base_speed(g);
                g.vx = base * 0.45;
                g.vy = -base * 0.9;
                say(b"launch");
            }
        }
    }
}

fn fill(x: f32, y: f32, w: f32, h: f32, rgb: [u8; 3]) {
    let frame = pixels();
    let x0 = (x.max(0.0) as usize).min(W);
    let y0 = (y.max(0.0) as usize).min(H);
    let x1 = ((x + w).max(0.0) as usize).min(W);
    let y1 = ((y + h).max(0.0) as usize).min(H);
    for py in y0..y1 {
        for px in x0..x1 {
            let i = (py * W + px) * 4;
            frame[i] = rgb[0];
            frame[i + 1] = rgb[1];
            frame[i + 2] = rgb[2];
            frame[i + 3] = 255;
        }
    }
}

fn draw(g: &Game) {
    for py in 0..H {
        let t = py as f32 / H as f32;
        let rgb = [(15.0 + 20.0 * t) as u8, (23.0 + 6.0 * t) as u8, (42.0 + 40.0 * t) as u8];
        fill(0.0, py as f32, W as f32, 1.0, rgb);
    }
    for row in 0..ROWS {
        for col in 0..COLS {
            if g.bricks[row * COLS + col] {
                let x = LEFT + col as f32 * (BRICK_W + GAP);
                let y = TOP + row as f32 * (BRICK_H + GAP);
                let c = ROW_COLOURS[row];
                fill(x, y, BRICK_W, BRICK_H, c);
                fill(x, y, BRICK_W, 1.0, [c[0].saturating_add(40), c[1].saturating_add(40), c[2].saturating_add(40)]);
            }
        }
    }
    let paddle = if g.state == State::Over { [100, 116, 139] } else { [226, 232, 240] };
    fill(g.paddle_x - g.paddle_w / 2.0, PADDLE_Y, g.paddle_w, PADDLE_H, paddle);
    if g.state != State::Over {
        fill(g.ball_x, g.ball_y, BALL, BALL, [255, 255, 255]);
    }
    for life in 0..g.lives {
        fill(4.0 + life as f32 * 7.0, 6.0, 4.0, 4.0, [244, 114, 182]);
    }
    unsafe { present(pixels().as_ptr(), W as u32, H as u32) }
}

fn step(g: &mut Game, dt: f32) {
    let move_by = 240.0 * dt;
    if g.left {
        g.paddle_x -= move_by;
    }
    if g.right {
        g.paddle_x += move_by;
    }
    let half = g.paddle_w / 2.0;
    g.paddle_x = g.paddle_x.max(half).min(W as f32 - half);
    if g.state != State::Playing {
        return;
    }
    if g.attached {
        g.ball_x = g.paddle_x - BALL / 2.0;
        g.ball_y = PADDLE_Y - BALL - 1.0;
        return;
    }
    // Small steps, so a fast ball cannot pass through a brick.
    let distance = f32_sqrt(g.vx * g.vx + g.vy * g.vy) * dt;
    let steps = (distance / 2.0) as u32 + 1;
    let sdt = dt / steps as f32;
    for _ in 0..steps {
        g.ball_x += g.vx * sdt;
        g.ball_y += g.vy * sdt;
        if g.ball_x < 0.0 {
            g.ball_x = 0.0;
            g.vx = g.vx.abs();
        }
        if g.ball_x + BALL > W as f32 {
            g.ball_x = W as f32 - BALL;
            g.vx = -g.vx.abs();
        }
        if g.ball_y < 0.0 {
            g.ball_y = 0.0;
            g.vy = g.vy.abs();
        }
        // The paddle: where it is hit steers the ball.
        if g.vy > 0.0
            && g.ball_y + BALL >= PADDLE_Y
            && g.ball_y + BALL <= PADDLE_Y + PADDLE_H + 2.0
            && g.ball_x + BALL >= g.paddle_x - half
            && g.ball_x <= g.paddle_x + half
        {
            let offset = ((g.ball_x + BALL / 2.0 - g.paddle_x) / half).max(-1.0).min(1.0);
            let base = base_speed(g);
            g.vx = base * 0.85 * offset;
            g.vy = -f32_sqrt((base * base - g.vx * g.vx).max(base * base * 0.2));
            g.ball_y = PADDLE_Y - BALL;
            beep(330.0, 40);
        }
        // A brick under the ball's centre.
        let cx = g.ball_x + BALL / 2.0;
        let cy = g.ball_y + BALL / 2.0;
        if cy >= TOP && cy < TOP + ROWS as f32 * (BRICK_H + GAP) && cx >= LEFT {
            let col = ((cx - LEFT) / (BRICK_W + GAP)) as usize;
            let row = ((cy - TOP) / (BRICK_H + GAP)) as usize;
            if col < COLS && row < ROWS && g.bricks[row * COLS + col] {
                g.bricks[row * COLS + col] = false;
                g.vy = -g.vy;
                g.score += 10 * (ROWS - row) as u32;
                say_number(g, b"score", g.score);
                beep(520.0 + 60.0 * (ROWS - row) as f32, 50);
                if g.bricks.iter().all(|b| !b) {
                    g.state = State::Cleared;
                    g.attached = true;
                    say(b"cleared");
                    return;
                }
            }
        }
        if g.ball_y > H as f32 {
            g.lives = g.lives.saturating_sub(1);
            say_number(g, b"lives", g.lives);
            beep(140.0, 220);
            g.attached = true;
            if g.lives == 0 {
                g.state = State::Over;
                say(b"over");
            }
            return;
        }
    }
}

#[no_mangle]
pub extern "C" fn frame(time: f64) {
    let g = game();
    let dt = if g.last == 0.0 { 0.0 } else { ((time - g.last) / 1000.0).clamp(0.0, 1.0 / 30.0) as f32 };
    g.last = time;
    step(g, dt);
    draw(g);
}

/// USB HID codes: 80 Left, 79 Right, 4 A, 7 D, 44 Space.
#[no_mangle]
pub extern "C" fn key(code: i32, down: i32) {
    let g = game();
    let held = down != 0;
    match code {
        80 | 4 => g.left = held,
        79 | 7 => g.right = held,
        44 if held => launch(g),
        _ => {}
    }
}

#[no_mangle]
pub extern "C" fn pointer(_id: i32, phase: i32, x: f32, _y: f32, _buttons: i32) {
    let g = game();
    if phase == 0 || phase == 1 {
        g.paddle_x = x;
    }
    if phase == 1 {
        launch(g);
    }
}

/// Called by the app's logic: softn.wasm.call(handle, "reset").
#[no_mangle]
pub extern "C" fn reset() {
    new_game(game());
}

/// Called by the app's logic: softn.wasm.call(handle, "set_speed", [1.5]).
#[no_mangle]
pub extern "C" fn set_speed(speed: f32) {
    let g = game();
    let before = base_speed(g);
    g.speed = speed.max(0.5).min(2.5);
    if !g.attached && before > 0.0 {
        let scale = base_speed(g) / before;
        g.vx *= scale;
        g.vy *= scale;
    }
}

#[no_mangle]
pub extern "C" fn _initialize() {
    new_game(game());
}
