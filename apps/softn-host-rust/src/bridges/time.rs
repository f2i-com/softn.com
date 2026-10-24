//! `softn.time`: the clock, calendar age, and local times in a named zone.
//!
//! Both backend hosts answer the same calls with the same values; the list is
//! apps/softn-host-php/tests/time-parity.json, run here by the test below and
//! there by route-declarations.test.mjs. The PHP host's zones are whatever its
//! `Intl` takes, so this one takes the same spellings: an IANA name in any
//! case, or an offset from UTC.
use chrono::{DateTime, Datelike, FixedOffset, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, Offset, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use std::{collections::HashMap, sync::OnceLock};

/// The zone a script named: one of the IANA list's, or a fixed offset.
enum Zone {
    Named(Tz),
    Offset(FixedOffset),
}

impl Zone {
    /// The wall clock in this zone at an instant, or None past the last (or
    /// before the first) date chrono can write: an instant chrono can hold,
    /// near its year 262,142, moved east by the zone's offset. chrono's own
    /// `naive_local` panics there, and a script chose the instant.
    fn local(&self, at: DateTime<Utc>) -> Option<NaiveDateTime> {
        let offset = match self {
            Zone::Named(tz) => tz.offset_from_utc_datetime(&at.naive_utc()).fix(),
            Zone::Offset(offset) => *offset,
        };
        at.naive_utc().checked_add_offset(offset)
    }

    /// The instant a wall-clock time names in this zone: one, two (a time the
    /// clocks repeat) or none (a time they skip).
    fn instant(&self, local: &NaiveDateTime) -> LocalResult<i64> {
        match self {
            Zone::Named(tz) => tz.from_local_datetime(local).map(|at| at.timestamp()),
            Zone::Offset(offset) => offset.from_local_datetime(local).map(|at| at.timestamp()),
        }
    }
}

/// Every IANA name this host knows, in lower case. A zone used to be looked
/// up exactly as written, so `australia/melbourne`, which the PHP host takes,
/// was unknown here.
fn named_zones() -> &'static HashMap<String, Tz> {
    static ZONES: OnceLock<HashMap<String, Tz>> = OnceLock::new();
    ZONES.get_or_init(|| chrono_tz::TZ_VARIANTS.iter().map(|tz| (tz.name().to_ascii_lowercase(), *tz)).collect())
}

/// An offset from UTC as the PHP host's `Intl` reads one: a sign, two digits
/// of hours, and optionally two of minutes with or without a colon (`+10`,
/// `+1000`, `-03:30`).
fn offset(text: &str) -> Option<FixedOffset> {
    let (sign, digits) = match text.chars().next()? {
        '+' => (1, &text[1..]),
        '-' => (-1, &text[1..]),
        '\u{2212}' => (-1, &text['\u{2212}'.len_utf8()..]),
        _ => return None,
    };
    let (hours, minutes) = match digits.as_bytes() {
        [h1, h2] => ([*h1, *h2], [b'0', b'0']),
        [h1, h2, m1, m2] | [h1, h2, b':', m1, m2] => ([*h1, *h2], [*m1, *m2]),
        _ => return None,
    };
    let number = |pair: [u8; 2]| pair.iter().all(u8::is_ascii_digit).then(|| i32::from(pair[0] - b'0') * 10 + i32::from(pair[1] - b'0'));
    let (hours, minutes) = (number(hours)?, number(minutes)?);
    if hours > 23 || minutes > 59 {
        return None;
    }
    FixedOffset::east_opt(sign * (hours * 3600 + minutes * 60))
}

fn zone(text: &str) -> Result<Zone, String> {
    if let Some(offset) = offset(text) {
        return Ok(Zone::Offset(offset));
    }
    named_zones()
        .get(&text.to_ascii_lowercase())
        .map(|tz| Zone::Named(*tz))
        .ok_or_else(|| "Unknown IANA timezone".into())
}

fn date(text: &str) -> Option<NaiveDate> {
    if text.len() != 10 {
        return None;
    }
    let parsed = NaiveDate::parse_from_str(text, "%Y-%m-%d").ok()?;
    if parsed.format("%Y-%m-%d").to_string() != text {
        return None;
    }
    Some(parsed)
}

// The words `format` writes. They are the PHP host's (runtime/time.mjs keeps
// the same two lists): what its Node's en-AU locale gave when the two hosts
// were brought into line, June and July in full and "Sept" included, held
// here so that neither host's text moves when a locale library does.
const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "June", "July", "Aug", "Sept", "Oct", "Nov", "Dec"];

/// `softn.time.format(seconds, zone)`: "Thu, 1 Jan, 11:00 pm · Melbourne".
/// The place is the last part of the zone as the caller spelt it, its
/// underscores as spaces. This host used to write "Thu, 1 Jan 2026, 11:00 PM
/// AEDT" for the same call.
fn format(at: DateTime<Utc>, zone: &Zone, named: &str) -> Option<String> {
    let local = zone.local(at)?;
    let hour = match local.hour() % 12 {
        0 => 12,
        hour => hour,
    };
    Some(format!(
        "{}, {} {}, {}:{:02} {} \u{b7} {}",
        WEEKDAYS[local.weekday().num_days_from_sunday() as usize],
        local.day(),
        MONTHS[local.month0() as usize],
        hour,
        local.minute(),
        if local.hour() < 12 { "am" } else { "pm" },
        named.rsplit('/').next().unwrap_or(named).replace('_', " "),
    ))
}

pub fn dispatch(kind: &str, a: &str, b: &str, c: &str) -> Result<serde_json::Value, String> {
    Ok(match kind {
        "time.now" => Utc::now().timestamp().into(),
        "time.age" => {
            let Some(birth) = date(a) else {
                return Ok((-1).into());
            };
            calendar_age(
                birth,
                Utc::now(),
                &zone(if b.is_empty() { "UTC" } else { b })?,
            )
            .into()
        }
        "time.parseZoned" => {
            let d = date(a).ok_or("Invalid calendar date")?;
            if b.len() != 5 {
                return Err("Invalid local time".into());
            }
            let t = NaiveTime::parse_from_str(b, "%H:%M").map_err(|_| "Invalid local time")?;
            if t.format("%H:%M").to_string() != b {
                return Err("Invalid local time".into());
            }
            match zone(c)?.instant(&d.and_time(t)) {
                LocalResult::Single(at) => at.into(),
                LocalResult::Ambiguous(_, _) => {
                    return Err("Local time is ambiguous due to daylight saving".into())
                }
                LocalResult::None => {
                    return Err("Local time does not exist due to daylight saving".into())
                }
            }
        }
        "time.format" => {
            // A script's number, which may carry a fraction of a second: the
            // whole second it falls in, as the PHP host reads it. It used to
            // have to be a whole number.
            let seconds = a
                .parse::<f64>()
                .ok()
                .filter(|seconds| seconds.is_finite() && seconds.abs() < 1e14)
                .ok_or("Invalid timestamp")?
                .floor();
            let at = Utc
                .timestamp_opt(seconds as i64, 0)
                .single()
                .ok_or("Invalid timestamp")?;
            format(at, &zone(b)?, b).ok_or("Invalid timestamp")?.into()
        }
        _ => return Err("Unknown time operation".into()),
    })
}

fn calendar_age(birth: NaiveDate, now: DateTime<Utc>, zone: &Zone) -> i32 {
    // Today is never near chrono's ends.
    let today = zone.local(now).unwrap_or_else(|| now.naive_utc()).date();
    today.year()
        - birth.year()
        - i32::from((today.month(), today.day()) < (birth.month(), birth.day()))
}

#[cfg(test)]
mod tests {
    use super::*;
    /// The last second chrono holds, written east of UTC, and the first,
    /// written west of it: past the dates chrono can write, refused, where
    /// putting them in the zone panicked the worker. Just inside, answered.
    #[test]
    fn a_time_past_the_dates_chrono_writes_is_refused_not_a_panic() {
        for (seconds, zone) in [("8210266876799", "+10:00"), ("8210266876799", "Australia/Melbourne"), ("-8334601228800", "-10:00"), ("-8334601228800", "America/New_York")] {
            let answered = std::panic::catch_unwind(|| dispatch("time.format", seconds, zone, ""));
            assert!(matches!(&answered, Ok(Err(e)) if e == "Invalid timestamp"), "{seconds} {zone}: {answered:?}");
        }
        assert!(dispatch("time.format", "8210266876799", "-10:00", "").is_ok());
        assert!(dispatch("time.format", "8210266876799", "UTC", "").is_ok());
    }

    #[test]
    fn rejects_invalid_dates_and_dst_fold_and_gap() {
        assert_eq!(dispatch("time.age", "2025-02-29", "", "").unwrap(), -1);
        assert!(dispatch(
            "time.parseZoned",
            "2026-10-04",
            "02:30",
            "Australia/Melbourne"
        )
        .is_err());
        assert!(dispatch(
            "time.parseZoned",
            "2026-04-05",
            "02:30",
            "Australia/Melbourne"
        )
        .is_err());
        assert!(dispatch(
            "time.parseZoned",
            "2026-10-04",
            "03:30",
            "Australia/Melbourne"
        )
        .is_ok());
        assert_eq!(
            dispatch(
                "time.parseZoned",
                "2026-01-01",
                "12:00",
                "Australia/Brisbane"
            )
            .unwrap(),
            1767232800i64
        );
    }

    /// softn.time as both hosts answer it: the list in
    /// apps/softn-host-php/tests/time-parity.json, which that host's
    /// route-declarations.test.mjs runs too, each case called from a handler
    /// by the fixture's own script. This host wrote format() its own way
    /// ("Thu, 1 Jan 2026, 11:00 PM AEDT" for the PHP host's "Thu, 1 Jan,
    /// 11:00 pm · Melbourne"), took a zone only when it was spelt exactly as
    /// the IANA list spells it, refused an offset and a fractional timestamp,
    /// and failed age() with a null zone where that host answers for UTC.
    #[test]
    fn softn_time_answers_the_shared_list_as_the_php_host_does() {
        let parity: serde_json::Value = serde_json::from_str(include_str!("../../../softn-host-php/tests/time-parity.json")).unwrap();
        let runtime = crate::runtime::ServerRuntime::new(|| crate::host::BridgeSet {
            db: None, http: None, fs: None, env: None, sql: None, crypto: None,
            allow_time: true, development: false, allow_photos: false, app_config: serde_json::Value::Null,
        }, Some(1)).unwrap();
        runtime.init(parity["script"].as_str().unwrap().to_string()).unwrap();
        let cases = parity["cases"].as_array().unwrap();
        // A case that names `same` arguments is asked twice, the second time with those.
        let mut asked = cases.clone();
        asked.extend(cases.iter().filter(|c| c.get("same").is_some()).map(|c| serde_json::json!({"call": c["call"], "args": c["same"]})));
        let answer = runtime.call("timeCases", vec![serde_json::json!({"body": {"cases": asked}})]).unwrap();
        let answers = answer["body"].as_array().unwrap();
        let mut wrong = Vec::new();
        let mut twin = cases.len();
        for (case, got) in cases.iter().zip(answers) {
            let label = format!("{}({})", case["call"].as_str().unwrap(), case["args"]);
            let threw = got.get("threw").is_some();
            if case.get("throws").is_some() {
                if !threw {
                    wrong.push(format!("{label} answered {}", got["ok"]));
                }
            } else if threw {
                wrong.push(format!("{label} threw"));
            } else if case.get("same").is_some() {
                let other = &answers[twin];
                twin += 1;
                if other.get("threw").is_some() || other["ok"] != got["ok"] {
                    wrong.push(format!("{label} is {}, and with {} {}", got["ok"], case["same"], other["ok"]));
                }
            } else if got["ok"] != case["result"] {
                wrong.push(format!("{label} is {}, not {}", got["ok"], case["result"]));
            }
        }
        assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    }

    #[test]
    fn supports_iana_zones_and_age_at_local_calendar_boundaries() {
        let now = Utc.with_ymd_and_hms(2026, 9, 8, 2, 0, 0).unwrap();
        let birth = date("2000-09-08").unwrap();
        assert_eq!(calendar_age(birth, now, &zone("UTC").unwrap()), 26);
        assert_eq!(
            calendar_age(birth, now, &zone("America/Los_Angeles").unwrap()),
            25
        );
        assert_eq!(
            dispatch("time.parseZoned", "2026-01-01", "12:00", "UTC").unwrap(),
            1767268800i64
        );
        assert!(dispatch("time.parseZoned", "2026-03-08", "02:30", "America/New_York").is_err());
        assert!(dispatch("time.age", "2000-01-01", "invalid/zone", "").is_err());
    }
}
