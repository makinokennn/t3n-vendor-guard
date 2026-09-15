//! KV access for the contract.
//!
//! Two maps, both namespaced by the host under `z:<tenant-did>:<tail>`:
//!
//! * `state`   — the vendor registry (JSON per vendor) and the rolling daily
//!   spend counter. Read/write by this contract.
//! * `secrets` — the vendor API key, seeded once by the tenant owner via the
//!   control-plane (`map-entry-set`), which bypasses the map's `writers` ACL;
//!   read-only from here.
//!
//! `kv_store::get` takes the **full canonical map name**, not the bare tail, so
//! every helper here builds `z:<hex(tid)>:<tail>` first.

use crate::host::{interfaces::kv_store, tenant::tenant_context};
use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use crate::dates::day_key;
use crate::policy::{safe_identifier, Vendor};

/// Canonical map name for a per-tenant map tail.
pub fn map_name(tail: &str) -> String {
    let tid = tenant_context::tenant_did();
    format!("z:{}:{}", hex::encode(&tid), tail)
}

fn state_map() -> String {
    map_name("state")
}

fn secrets_map() -> String {
    map_name("secrets")
}

/// Vendor registry key. Namespaced under `vendor/` so the same map can later hold
/// other state (counters, cursors) without collisions.
fn vendor_key(id: &str) -> Vec<u8> {
    format!("vendor/{id}").into_bytes()
}

/// Rolling daily-spend key. One counter per UTC day; old days are simply never
/// read again (and can be pruned by the tenant out of band).
fn spend_key(epoch_secs: u64) -> Vec<u8> {
    format!("spend/{}", day_key(epoch_secs)).into_bytes()
}

/// Read and parse one vendor from the registry.
///
/// A malformed record is reported as an error rather than being treated as
/// "absent": a corrupt vendor entry must not silently become `vendor_unknown`
/// and mask a real data problem, nor silently pass a policy check.
pub fn read_vendor(id: &str) -> Result<Option<Vendor>, String> {
    if !safe_identifier(id) {
        return Err(format!("invalid vendor id '{id}'"));
    }
    let raw = kv_store::get(&state_map(), &vendor_key(id))
        .map_err(|e| format!("kv read vendor '{id}': {e}"))?;
    match raw {
        None => Ok(None),
        Some(bytes) => {
            let v: Vendor = serde_json::from_slice(&bytes)
                .map_err(|e| format!("vendor '{id}' record is not valid JSON: {e}"))?;
            if v.id != id {
                return Err(format!(
                    "vendor record mismatch: asked for '{id}', record says '{}'",
                    v.id
                ));
            }
            Ok(Some(v))
        }
    }
}

/// Read the tenant's full vendor registry.
///
/// `scan` returns keys in lexicographic order; we walk the `vendor/` prefix. A
/// single corrupt entry fails the whole listing, deliberately — a policy view
/// that silently omits a vendor is worse than an error.
pub fn read_all_vendors() -> Result<Vec<Vendor>, String> {
    let entries = kv_store::scan(&state_map(), b"vendor/", b"vendor0", 200)
        .map_err(|e| format!("kv scan vendors: {e}"))?;
    let mut out = Vec::with_capacity(entries.len());
    for (_k, v) in entries {
        let parsed: Vendor = serde_json::from_slice(&v)
            .map_err(|e| format!("vendor registry holds a malformed record: {e}"))?;
        out.push(parsed);
    }
    Ok(out)
}

/// Amount already paid out today (in minor units), for the rolling cap.
///
/// A missing counter is `0`. An unparseable counter is an error: silently
/// resetting to `0` would *raise* the tenant's effective daily limit, which is
/// exactly the failure mode a spending control must never have.
pub fn read_daily_spent(epoch_secs: u64) -> Result<u64, String> {
    let raw = kv_store::get(&state_map(), &spend_key(epoch_secs))
        .map_err(|e| format!("kv read daily spend: {e}"))?;
    match raw {
        None => Ok(0),
        Some(bytes) => {
            let s = String::from_utf8(bytes)
                .map_err(|_| "daily spend counter is not valid UTF-8".to_string())?;
            s.trim()
                .parse::<u64>()
                .map_err(|_| format!("daily spend counter '{s}' is not a number"))
        }
    }
}

/// Add `amount` to today's counter and persist it.
///
/// Read-modify-write. The host serialises invocations that touch the same key,
/// so two concurrent payouts cannot both read the same "before" value and each
/// conclude they fit under the cap.
pub fn add_daily_spent(epoch_secs: u64, amount: u64) -> Result<u64, String> {
    let current = read_daily_spent(epoch_secs)?;
    let next = current.saturating_add(amount);
    kv_store::put(
        &state_map(),
        &spend_key(epoch_secs),
        next.to_string().as_bytes(),
    )
    .map_err(|e| format!("kv write daily spend: {e}"))?;
    Ok(next)
}

/// Read the vendor API key. Absent is an error with a remediation hint, because
/// a missing key means the tenant skipped setup — not a normal runtime state.
pub fn read_vendor_api_key() -> Result<String, String> {
    let bytes = kv_store::get(&secrets_map(), b"vendor_api_key")
        .map_err(|e| format!("kv read vendor_api_key: {e}"))?
        .ok_or(
            "vendor_api_key not found in z:<tid>:secrets — seed it via the tenant SDK \
             (map-entry-set on tee:tenant/contracts) before use",
        )?;
    String::from_utf8(bytes).map_err(|_| "vendor_api_key is not valid UTF-8".to_string())
}

/// Cluster time, in epoch seconds. Comes from the enclave, not the caller, so a
/// caller cannot backdate a payout to dodge the daily cap.
pub fn now_secs() -> u64 {
    tenant_context::cluster_timestamp_secs()
}

/// Read the tenant's policy overrides, if any.
///
/// A malformed override blob is an error, not "no overrides": silently falling
/// back to defaults would *loosen* whatever the operator was trying to tighten,
/// and the operator would have no signal that their control was not in effect.
pub fn read_overrides() -> Result<Option<crate::policy::PolicyOverride>, String> {
    let raw = kv_store::get(&state_map(), b"policy/overrides")
        .map_err(|e| format!("kv read policy/overrides: {e}"))?;
    match raw {
        None => Ok(None),
        Some(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| format!("policy/overrides is not valid JSON: {e}")),
    }
}
