//! Per-address allowances: the sync ticket endpoint's (sync.rs) and an app's
//! routes' (`config.server.requestsPerMinute`, app.rs and tenant.rs). An
//! address is a visitor, and an IPv6 /64 is one visitor.

/// Addresses a limiter remembers. A full bucket is the same as no entry,
/// so those are dropped first; past this, a new address waits.
const MAX_LIMITER_KEYS: usize = 10_000;

/// The key a client address is limited under. An IPv6 client usually holds a
/// whole /64 and can rotate through it freely, so one /64 is one client.
pub fn limiter_key(ip: std::net::IpAddr) -> std::net::IpAddr {
    match ip {
        std::net::IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => std::net::IpAddr::V4(v4),
            None => std::net::IpAddr::V6(std::net::Ipv6Addr::from(u128::from(v6) & !((1u128 << 64) - 1))),
        },
        v4 => v4,
    }
}

struct Bucket {
    tokens: f64,
    updated: std::time::Instant,
}

/// A token bucket per client address (an IPv6 /64 counting as one), per app:
/// one tenant's visitors do not spend another's allowance.
pub struct AddressLimiter {
    burst: f64,
    refill_per_sec: f64,
    buckets: std::sync::Mutex<std::collections::HashMap<std::net::IpAddr, Bucket>>,
}

impl AddressLimiter {
    pub fn new(burst: f64, refill_per_sec: f64) -> Self {
        Self { burst, refill_per_sec, buckets: std::sync::Mutex::new(std::collections::HashMap::new()) }
    }

    /// `per_minute` requests a minute, all of which may come at once (the
    /// PHP host's per-minute count, without its cliff at the minute's edge).
    pub fn per_minute(per_minute: u32) -> Self {
        Self::new(f64::from(per_minute), f64::from(per_minute) / 60.0)
    }

    fn refill(&self, bucket: &mut Bucket, now: std::time::Instant) {
        let elapsed = now.duration_since(bucket.updated).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * self.refill_per_sec).min(self.burst);
        bucket.updated = now;
    }

    /// Spend one request of `ip`'s allowance, or say how long to wait.
    pub fn check(&self, ip: std::net::IpAddr) -> Result<(), std::time::Duration> {
        let now = std::time::Instant::now();
        let key = limiter_key(ip);
        let mut buckets = self.buckets.lock().unwrap_or_else(|p| p.into_inner());
        if !buckets.contains_key(&key) && buckets.len() >= MAX_LIMITER_KEYS {
            buckets.retain(|_, b| {
                self.refill(b, now);
                b.tokens < self.burst
            });
            if buckets.len() >= MAX_LIMITER_KEYS {
                return Err(std::time::Duration::from_secs(60));
            }
        }
        let bucket = buckets.entry(key).or_insert(Bucket { tokens: self.burst, updated: now });
        self.refill(bucket, now);
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            Ok(())
        } else {
            let wait = ((1.0 - bucket.tokens) / self.refill_per_sec).ceil().max(1.0);
            Err(std::time::Duration::from_secs(wait as u64))
        }
    }
}
