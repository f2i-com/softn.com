//! What the Node runner's JavaScript does to values, where the answer has to
//! be the same: how a number is written, `String(value)` of a value that
//! crossed as JSON, `JSON.stringify` of a value the runner builds, and the
//! scrubbing of a reason before it reaches the operator's log.

use serde_json::Value;

/// `Number.MAX_SAFE_INTEGER`.
pub const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// A number as JavaScript writes it (Number::toString); `null` when it is not
/// finite, as `JSON.stringify` writes it.
pub fn write_number(n: f64, out: &mut String) {
    if !n.is_finite() {
        out.push_str("null");
        return;
    }
    out.push_str(&number_text(n));
}

/// `String(n)` for a finite number.
pub fn number_text(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if n == 0.0 {
        return "0".into();
    }
    let mut out = String::new();
    if n < 0.0 {
        out.push('-');
    }
    // The shortest digits that read back as `n` (ryu), then JavaScript's layout.
    let mut buffer = ryu::Buffer::new();
    let text = buffer.format_finite(n.abs());
    let (mantissa, exponent) = match text.find(['e', 'E']) {
        Some(i) => (&text[..i], text[i + 1..].parse::<i32>().unwrap_or(0)),
        None => (text, 0),
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let joined = format!("{whole}{fraction}");
    let leading = joined.len() - joined.trim_start_matches('0').len();
    let digits = joined[leading..].trim_end_matches('0');
    let k = digits.len() as i32;
    let point = whole.len() as i32 + exponent - leading as i32;
    if k <= point && point <= 21 {
        out.push_str(digits);
        out.extend(std::iter::repeat_n('0', (point - k) as usize));
    } else if 0 < point && point <= 21 {
        out.push_str(&digits[..point as usize]);
        out.push('.');
        out.push_str(&digits[point as usize..]);
    } else if -6 < point && point <= 0 {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', (-point) as usize));
        out.push_str(digits);
    } else {
        let e = point - 1;
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        out.push(if e < 0 { '-' } else { '+' });
        out.push_str(&e.unsigned_abs().to_string());
    }
    out
}

/// `String(value)` of a value that reached the runner as JSON: what a host
/// function in the Node runner sees after the bridge's `JSON.parse`. `None`
/// is `undefined`, an argument the script did not pass.
pub fn string_of(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => number_text(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(s)) => s.clone(),
        // Array.prototype.join: null and undefined elements are empty.
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { string_of(Some(item)) })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `Number(value)` of a value that reached the runner as JSON.
pub fn number_of(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let text = s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
            if text.is_empty() {
                0.0
            } else if let Some(hex) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
                u64::from_str_radix(hex, 16).map_or(f64::NAN, |n| n as f64)
            } else {
                match text {
                    "Infinity" | "+Infinity" => f64::INFINITY,
                    "-Infinity" => f64::NEG_INFINITY,
                    _ if text.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-')) => {
                        text.parse::<f64>().unwrap_or(f64::NAN)
                    }
                    _ => f64::NAN,
                }
            }
        }
        Some(Value::Array(items)) => match items.as_slice() {
            [] => 0.0,
            [one] => number_of(Some(&Value::String(string_of(Some(one))))),
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// `JSON.stringify` of a value the runner built from JSON it read: a number
/// written as JavaScript writes it, a string escaped as it escapes one.
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_value(value, &mut out);
    out
}

fn write_value(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => write_number(n.as_f64().unwrap_or(f64::NAN), out),
        Value::String(s) => write_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (i, (key, item)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(key, out);
                out.push(':');
                write_value(item, out);
            }
            out.push('}');
        }
    }
}

pub fn write_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                // \u00XX, written in place: one allocation per character made
                // a string of control characters many times slower than Node.
                const HEX: &[u8; 16] = b"0123456789abcdef";
                out.push_str("\\u00");
                out.push(HEX[(c as usize) >> 4] as char);
                out.push(HEX[(c as usize) & 0xf] as char);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn hex4(bytes: &[u8]) -> Option<u32> {
    std::str::from_utf8(bytes).ok().and_then(|h| u32::from_str_radix(h, 16).ok()).filter(|_| bytes.len() == 4)
}

/// JSON a script's `JSON.stringify` wrote, as the Node runner's host functions
/// read it: an escaped lone surrogate (half of an emoji a `slice` cut) is
/// U+FFFD by the time a host function has the string, where V8 converts it to
/// UTF-8; serde_json would refuse the whole text. Pairs are left as they are.
pub fn replace_lone_surrogates(text: &str) -> std::borrow::Cow<'_, str> {
    if !text.contains("\\u") {
        return std::borrow::Cow::Borrowed(text);
    }
    let b = text.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let (mut i, mut in_string, mut changed) = (0, false, false);
    while i < b.len() {
        let c = b[i];
        if in_string && c == b'\\' {
            if b.get(i + 1) == Some(&b'u') && i + 6 <= b.len() {
                if let Some(unit) = hex4(&b[i + 2..i + 6]) {
                    let low_follows = || i + 12 <= b.len() && b[i + 6] == b'\\' && b[i + 7] == b'u' && hex4(&b[i + 8..i + 12]).is_some_and(|l| (0xDC00..=0xDFFF).contains(&l));
                    if (0xD800..=0xDBFF).contains(&unit) && low_follows() {
                        out.extend_from_slice(&b[i..i + 12]);
                        i += 12;
                        continue;
                    }
                    if (0xD800..=0xDFFF).contains(&unit) {
                        out.extend_from_slice(b"\\ufffd");
                        changed = true;
                        i += 6;
                        continue;
                    }
                    out.extend_from_slice(&b[i..i + 6]);
                    i += 6;
                    continue;
                }
            }
            out.push(c);
            if let Some(next) = b.get(i + 1) {
                out.push(*next);
            }
            i += 2;
            continue;
        }
        if c == b'"' {
            in_string = !in_string;
        }
        out.push(c);
        i += 1;
    }
    if !changed {
        return std::borrow::Cow::Borrowed(text);
    }
    std::borrow::Cow::Owned(String::from_utf8(out).unwrap_or_else(|_| text.to_string()))
}

/// JavaScript's `===` between two values read from JSON files (each its own
/// `JSON.parse`): objects and arrays are never the same object.
pub fn strict_equal(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        _ => false,
    }
}

/// `text.replace(/[\x00-\x1f\x7f]+/g, ' ')`: each run of control characters
/// becomes one space.
pub fn collapse_controls(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        if (c as u32) < 0x20 || c == '\u{7f}' {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

/// `text.slice(0, n)`, counted in UTF-16 code units as JavaScript counts them.
pub fn slice_units(text: &str, n: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in text.chars() {
        units += c.len_utf16();
        if units > n {
            break;
        }
        out.push(c);
    }
    out
}

/// wasm-host.mjs `logFailure`'s scrubbing: control characters are spaces,
/// anything shaped like a path is `<path>`, and it stops at 300 characters.
pub fn log_reason(reason: &str) -> String {
    let text = collapse_controls(reason);
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        // (?:[A-Za-z]:)?[\\/][^\s'"`]+
        let drive = i + 2 < chars.len() && chars[i].is_ascii_alphabetic() && chars[i + 1] == ':' && matches!(chars[i + 2], '/' | '\\');
        let start = if drive { i + 2 } else { i };
        if matches!(chars[start], '/' | '\\') && start + 1 < chars.len() && !stops_path(chars[start + 1]) {
            let mut end = start + 1;
            while end < chars.len() && !stops_path(chars[end]) {
                end += 1;
            }
            out.push_str("<path>");
            i = end;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    slice_units(&out, 300)
}

fn stops_path(c: char) -> bool {
    c.is_whitespace() || matches!(c, '\'' | '"' | '`')
}

/// One line on stderr for the operator's log (wasm-host.mjs `logFailure`).
pub fn log_failure(what: &str, reason: &str) {
    use std::io::Write;
    let _ = writeln!(std::io::stderr(), "softn: {what}: {}", log_reason(reason));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_are_written_as_javascript_writes_them() {
        for (n, text) in [
            (1.0, "1"),
            (-0.0, "0"),
            (0.1 + 0.2, "0.30000000000000004"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (123456789012345680000.0, "123456789012345680000"),
            (5e-7, "5e-7"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (0.0001, "0.0001"),
            (-2.5, "-2.5"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (5e-324, "5e-324"),
            (9007199254740993.0, "9007199254740992"),
        ] {
            assert_eq!(number_text(n), text, "{n:e}");
        }
    }

    #[test]
    fn a_reason_is_scrubbed_for_the_log() {
        assert_eq!(log_reason("cannot open C:\\data\\app.sqlite now"), "cannot open <path> now");
        assert_eq!(log_reason("at /srv/app/private/x.json: bad"), "at <path> bad");
        assert_eq!(log_reason("a\n\n\tb"), "a b");
        assert_eq!(log_reason("1 / 2"), "1 / 2");
    }

    #[test]
    fn a_lone_surrogate_is_read_as_json_parse_and_v8_read_it() {
        let text = r#"["ab\ud83d","\ud83d\ude00","\\ud83d","x\udc00y",1]"#;
        let read: Value = serde_json::from_str(&replace_lone_surrogates(text)).unwrap();
        assert_eq!(read, serde_json::json!(["ab\u{fffd}", "😀", "\\ud83d", "x\u{fffd}y", 1]));
        assert!(matches!(replace_lone_surrogates(r#"["plain"]"#), std::borrow::Cow::Borrowed(_)));
    }

    #[test]
    fn string_of_reads_values_as_javascript_does() {
        assert_eq!(string_of(None), "undefined");
        assert_eq!(string_of(Some(&serde_json::json!([1, null, "a", [2, 3]]))), "1,,a,2,3");
        assert_eq!(string_of(Some(&serde_json::json!(1e21))), "1e+21");
        assert_eq!(number_of(Some(&serde_json::json!(" 12 "))), 12.0);
        assert!(number_of(Some(&serde_json::json!("12px"))).is_nan());
    }
}
