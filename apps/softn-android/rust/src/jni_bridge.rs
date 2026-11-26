//! Android JNI bindings for `com.softn.android.SoftnNative`.
//!
//! All calls are wrapped in `std::panic::catch_unwind` so a Rust panic never
//! crashes the Android ART process without logging. Engine handles live in a
//! thread-local opaque handle table (`jlong -> SoftnMobileEngine`) pinned to
//! the dedicated `softn-engine` Looper thread: because `SoftnMobileEngine`
//! contains `!Send` VM/DOM state and thread-local Canvas 2D / WebGL state,
//! thread-pinning guarantees zero use-after-free, zero double-free, and zero
//! cross-thread UB without any raw pointers or `unsafe impl Send`.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};

use jni::objects::{JByteArray, JByteBuffer, JClass, JString};
use jni::sys::{jboolean, jfloat, jint, jlong, jstring, JNI_FALSE, JNI_TRUE};
use jni::JNIEnv;
use serde_json::json;

use crate::engine::{HostDeviceInfo, InteractionResult, SoftnMobileEngine};

static NEXT_HANDLE: AtomicI64 = AtomicI64::new(1);

thread_local! {
    static LOCAL_ENGINES: RefCell<HashMap<jlong, SoftnMobileEngine>> =
        RefCell::new(HashMap::new());
}

fn with_engine<R>(
    handle: jlong,
    default: R,
    f: impl FnOnce(&mut SoftnMobileEngine) -> R,
) -> R {
    if handle <= 0 {
        return default;
    }
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        LOCAL_ENGINES.with(|cell| {
            let Ok(mut map) = cell.try_borrow_mut() else {
                log::error!("SoftN JNI re-entrant engine borrow refused (handle={handle})");
                return None;
            };
            let eng = map.get_mut(&handle)?;
            Some(f(eng))
        })
    })) {
        Ok(Some(v)) => v,
        Ok(None) => default,
        Err(p) => {
            let msg = p
                .downcast_ref::<&str>()
                .copied()
                .or_else(|| p.downcast_ref::<String>().map(String::as_str))
                .unwrap_or("unknown panic");
            log::error!("SoftN JNI call panicked: {msg}");
            default
        }
    }
}

fn init_android_logging() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        android_logger::init_once(
            android_logger::Config::default()
                .with_max_level(log::LevelFilter::Info)
                .with_tag("SoftN"),
        );
    });
}

fn jstr(env: &mut JNIEnv, s: &str) -> jstring {
    env.new_string(s)
        .map(|js| js.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

/// A Java string's text. `JavaStr` holds Java's modified UTF-8 (a character past the BMP as
/// two encoded surrogates, U+0000 as `C0 80`); `String::from` decodes it. Its
/// `to_string_lossy()` is `CStr`'s, which reads those bytes as UTF-8 and made every emoji
/// typed or pasted, and in a file name or clipboard text, into replacement characters.
fn java_string(env: &mut JNIEnv, s: &JString) -> Option<String> {
    env.get_string(s).ok().map(String::from)
}

fn result_to_json(res: &InteractionResult) -> String {
    serde_json::to_string(res).unwrap_or_else(|_| "{}".to_string())
}

#[no_mangle]
pub extern "system" fn Java_com_softn_android_SoftnNative_nativeCreate(
    mut env: JNIEnv,
    _class: JClass,
    bundle_bytes: JByteArray,
    data_dir: JString,
    width: jint,
    height: jint,
    density: jfloat,
    device_info_json: JString,
) -> jlong {
    init_android_logging();

    let Ok(bytes) = env.convert_byte_array(&bundle_bytes) else {
        log::error!("nativeCreate: failed to read bundle bytes");
        return 0;
    };
    let Some(data_dir_str) = java_string(&mut env, &data_dir) else {
        log::error!("nativeCreate: failed to read dataDir");
        return 0;
    };
    let data_dir_path = PathBuf::from(data_dir_str);

    let host_info: HostDeviceInfo = java_string(&mut env, &device_info_json)
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        SoftnMobileEngine::load_bundle(
            &bytes,
            &data_dir_path,
            width.max(1) as u32,
            height.max(1) as u32,
            density.max(1.0),
            host_info,
        )
    }));

    match res {
        Ok(Ok(engine)) => {
            log::info!("SoftN Mobile Engine booted: {}", engine.bundle_info_json());
            let id = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
            if id <= 0 {
                return 0;
            }
            LOCAL_ENGINES.with(|cell| {
                cell.borrow_mut().insert(id, engine);
            });
            id
        }
        Ok(Err(err)) => {
            log::error!("SoftN Mobile Engine boot failed: {err}");
            0
        }
        Err(_) => {
            log::error!("SoftN Mobile Engine panicked during nativeCreate");
            0
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_com_softn_android_SoftnNative_nativeResize(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
    width: jint,
    height: jint,
    density: jfloat,
) {
    with_engine(handle, (), |eng| {
        eng.resize(width.max(1) as u32, height.max(1) as u32, density.max(1.0));
    });
}

#[no_mangle]
pub extern "system" fn Java_com_softn_android_SoftnNative_nativeRender(
    env: JNIEnv,
    _class: JClass,
    handle: jlong,
    rgba_buffer: JByteBuffer,
) -> jboolean {
    let Ok(ptr) = env.get_direct_buffer_address(&rgba_buffer) else {
        log::error!("nativeRender: buffer is not a direct ByteBuffer");
        return JNI_FALSE;
    };
    let Ok(cap) = env.get_direct_buffer_capacity(&rgba_buffer) else {
        return JNI_FALSE;
    };
    if ptr.is_null() || cap == 0 {
        return JNI_FALSE;
    }
    let slice = unsafe { std::slice::from_raw_parts_mut(ptr, cap) };

    let ok = with_engine(handle, false, |eng| eng.render_rgba(slice));
    if ok { JNI_TRUE } else { JNI_FALSE }
}

#[no_mangle]
pub extern "system" fn Java_com_softn_android_SoftnNative_nativeTap(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    x: jfloat,
    y: jfloat,
) -> jstring {
    let out = with_engine(handle, "{}".to_string(), |eng| result_to_json(&eng.on_tap(x, y)));
    jstr(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_softn_android_SoftnNative_nativeScroll(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
    delta_y: jfloat,
) -> jboolean {
    let moved = with_engine(handle, false, |eng| eng.on_scroll(delta_y));
    if moved { JNI_TRUE } else { JNI_FALSE }
}

#[no_mangle]
pub extern "system" fn Java_com_softn_android_SoftnNative_nativeScroll2D(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
    delta_x: jfloat,
    delta_y: jfloat,
) -> jboolean {
    let moved = with_engine(handle, false, |eng| eng.on_scroll_2d(delta_x, delta_y));
    if moved { JNI_TRUE } else { JNI_FALSE }
}

#[no_mangle]
pub extern "system" fn Java_com_softn_android_SoftnNative_nativePointerDown(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
    x: jfloat,
    y: jfloat,
) -> jboolean {
    let captured = with_engine(handle, false, |eng| eng.on_pointer_down(x, y));
    if captured { JNI_TRUE } else { JNI_FALSE }
}

#[no_mangle]
pub extern "system" fn Java_com_softn_android_SoftnNative_nativePointerMove(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    x: jfloat,
    y: jfloat,
) -> jstring {
    let out = with_engine(handle, "{}".to_string(), |eng| {
        result_to_json(&eng.on_pointer_move(x, y))
    });
    jstr(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_softn_android_SoftnNative_nativePointerUp(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    x: jfloat,
    y: jfloat,
) -> jstring {
    let out = with_engine(handle, "{}".to_string(), |eng| {
        result_to_json(&eng.on_pointer_up(x, y))
    });
    jstr(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_softn_android_SoftnNative_nativeSelectOption(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    flid: jint,
    index: jint,
) -> jstring {
    let out = with_engine(handle, "{}".to_string(), |eng| {
        result_to_json(&eng.on_select_option(flid as u32, index))
    });
    jstr(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_softn_android_SoftnNative_nativeTextInput(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    text: JString,
) -> jstring {
    let txt = java_string(&mut env, &text).unwrap_or_default();
    let out = with_engine(handle, "{}".to_string(), |eng| {
        result_to_json(&eng.on_text_input(&txt))
    });
    jstr(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_softn_android_SoftnNative_nativeSubmitIme(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jstring {
    let out = with_engine(handle, "{}".to_string(), |eng| {
        result_to_json(&eng.on_submit_ime())
    });
    jstr(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_softn_android_SoftnNative_nativeResolveDeviceCall(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
    request_id: jlong,
    ok: jboolean,
    payload_json: JString,
) -> jstring {
    let payload = java_string(&mut env, &payload_json).unwrap_or_default();
    let out = with_engine(handle, "{}".to_string(), |eng| {
        result_to_json(&eng.resolve_device_call(request_id as u64, ok == JNI_TRUE, &payload))
    });
    jstr(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_softn_android_SoftnNative_nativeDrainPendingCalls(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jstring {
    let out = with_engine(handle, "[]".to_string(), |eng| {
        serde_json::to_string(&eng.drain_pending_calls()).unwrap_or_else(|_| "[]".to_string())
    });
    jstr(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_softn_android_SoftnNative_nativeTick(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jstring {
    let out = with_engine(handle, "{}".to_string(), |eng| result_to_json(&eng.tick()));
    jstr(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_softn_android_SoftnNative_nativeGetBundleInfo(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jstring {
    let out = with_engine(handle, json!({}).to_string(), |eng| eng.bundle_info_json());
    jstr(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_softn_android_SoftnNative_nativeClearCache(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jstring {
    let out = with_engine(handle, r#"{"ok":false}"#.to_string(), |eng| eng.clear_cache());
    jstr(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_softn_android_SoftnNative_nativeClearSiteData(
    mut env: JNIEnv,
    _class: JClass,
    handle: jlong,
) -> jstring {
    let out = with_engine(handle, r#"{"ok":false}"#.to_string(), |eng| {
        eng.clear_site_data()
    });
    jstr(&mut env, &out)
}

#[no_mangle]
pub extern "system" fn Java_com_softn_android_SoftnNative_nativeDestroy(
    _env: JNIEnv,
    _class: JClass,
    handle: jlong,
) {
    if handle <= 0 {
        return;
    }
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        LOCAL_ENGINES.with(|cell| {
            if let Ok(mut map) = cell.try_borrow_mut() {
                drop(map.remove(&handle));
            }
        });
    }));
}
