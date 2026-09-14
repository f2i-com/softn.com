use chrono::{Datelike, LocalResult, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;

fn zone(text: &str) -> Result<Tz, String> {
    text.parse().map_err(|_| "Unknown IANA timezone".into())
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
                zone(if b.is_empty() { "UTC" } else { b })?,
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
            match zone(c)?.from_local_datetime(&d.and_time(t)) {
                LocalResult::Single(at) => at.timestamp().into(),
                LocalResult::Ambiguous(_, _) => {
                    return Err("Local time is ambiguous due to daylight saving".into())
                }
                LocalResult::None => {
                    return Err("Local time does not exist due to daylight saving".into())
                }
            }
        }
        "time.format" => {
            let timestamp = a.parse::<i64>().map_err(|_| "Invalid timestamp")?;
            let at = Utc
                .timestamp_opt(timestamp, 0)
                .single()
                .ok_or("Invalid timestamp")?;
            at.with_timezone(&zone(b)?)
                .format("%a, %-d %b %Y, %-I:%M %p %Z")
                .to_string()
                .into()
        }
        _ => return Err("Unknown time operation".into()),
    })
}

fn calendar_age(birth: NaiveDate, now: chrono::DateTime<Utc>, timezone: Tz) -> i32 {
    let today = now.with_timezone(&timezone).date_naive();
    today.year()
        - birth.year()
        - i32::from((today.month(), today.day()) < (birth.month(), birth.day()))
}

#[cfg(test)]
mod tests {
    use super::*;
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

    #[test]
    fn supports_iana_zones_and_age_at_local_calendar_boundaries() {
        let now = Utc.with_ymd_and_hms(2026, 9, 8, 2, 0, 0).unwrap();
        let birth = date("2000-09-08").unwrap();
        assert_eq!(calendar_age(birth, now, zone("UTC").unwrap()), 26);
        assert_eq!(
            calendar_age(birth, now, zone("America/Los_Angeles").unwrap()),
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
