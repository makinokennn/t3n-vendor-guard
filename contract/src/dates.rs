//! Calendar helpers for daily-budget bucketing.
//!
//! The enclave gives us a cluster timestamp in epoch seconds. Bucketing spend by
//! UTC day must be deterministic and dependency-free, so we implement the
//! civil-from-days conversion directly rather than pulling in a date crate. This
//! module is pure and unit-tested on the host target.

/// Convert a count of days since 1970-01-01 into `(year, month, day)`.
///
/// Howard Hinnant's `civil_from_days`, valid for the whole proleptic Gregorian
/// range we care about.
pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// UTC day key (`YYYY-MM-DD`) for an epoch-seconds timestamp. Used to namespace
/// the rolling daily spend counter so the window rolls over at UTC midnight.
pub fn day_key(epoch_secs: u64) -> String {
    let days = (epoch_secs / 86_400) as i64;
    let (y, m, d) = civil_from_days(days);
    std::format!("{y:04}-{m:02}-{d:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unix_epoch_is_1970_01_01() {
        assert_eq!(day_key(0), "1970-01-01");
    }

    #[test]
    fn known_dates_round_trip() {
        // 2024-02-29T00:00:00Z — leap day
        assert_eq!(day_key(1_709_164_800), "2024-02-29");
        // 2026-09-16T15:59:59Z — the challenge deadline, for good luck
        assert_eq!(day_key(1_789_574_399), "2026-09-16");
        // 2000-03-01 (century leap-year rule)
        assert_eq!(day_key(951_868_800), "2000-03-01");
    }

    #[test]
    fn day_rolls_at_utc_midnight() {
        let midnight = 1_709_164_800; // 2024-02-29T00:00:00Z
        assert_eq!(day_key(midnight - 1), "2024-02-28");
        assert_eq!(day_key(midnight), "2024-02-29");
        assert_eq!(day_key(midnight + 86_399), "2024-02-29");
        assert_eq!(day_key(midnight + 86_400), "2024-03-01");
    }
}
