//! vendor-guard — policy-gated vendor payouts as a T3N tenant contract.
//!
//! # What problem this solves
//!
//! An autonomous finance agent that can move money is only as safe as the policy
//! layer it cannot bypass. Putting that policy in *prompt text* or in the agent's
//! TypeScript is not a control — the model can be argued out of it, and the code
//! can be swapped out. This contract makes the policy a **hard, auditable gate
//! that runs inside the TEE**, where the agent cannot reach it:
//!
//! ```text
//!   agent  ──►  check-payout   (pre-flight; never moves money)
//!                   │
//!                   ├── deny  ──► agent stops. Nothing is sent to the vendor.
//!                   └── allow ──► human approves ──► payout
//!                                                      │  policy re-evaluated
//!                                                      │  inside the enclave
//!                                                      └─► vendor transfer
//! ```
//!
//! Two properties matter here, and both come from the enclave rather than from
//! trusting the caller:
//!
//! 1. **The agent cannot widen its own authority.** The limits are compiled in,
//!    not passed as arguments. `check-payout` and `payout` both re-evaluate from
//!    the same compiled-in `Policy`, so a caller that skipped `check-payout`, or
//!    lied about its result, still gets stopped by `payout`.
//! 2. **The approver's identity never enters WASM.** The payout body carries
//!    `{{profile.<field>}}` markers that the *host* resolves from the paying
//!    user's profile at dispatch time (see [`api::payout`]). The contract is a
//!    template author, never a PII processor — there is no code path here that
//!    could log, cache, or leak a name or an email address, because those bytes
//!    are never in this process's memory.
//!
//! # Capabilities
//!
//! There is no capability manifest: a capability *is* the set of interfaces the
//! world imports. This world imports `tenant-context`, `logging`, `kv-store`
//! and `http-with-placeholders` (the payout itself). Dropping an import is the
//! only way to drop a capability.
//!
//! Note that `wit-bindgen` prunes an import no code path references, so the
//! effective capability set is what the *compiled* component imports — check it
//! with `wasm-tools component wit <built>.wasm` rather than reading this list.
//!
//! # Layout
//!
//! * [`policy`] — pure decision engine, no host interfaces, `cargo test`-able.
//! * [`dates`]  — pure UTC day bucketing for the rolling daily cap.
//! * [`store`]  — KV access (`z:<tid>:state`, `z:<tid>:secrets`).
//! * [`api`]    — the three exported entry points.

#![warn(clippy::style, missing_debug_implementations)]
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

extern crate alloc;

pub const CONTRACT_VERSION: &str = "0.1.0";

wit_bindgen::generate!({
    world: "vendor-guard",
    path: "wit",
    additional_derives: [
        serde::Deserialize,
        serde::Serialize,
    ],
    generate_all,
});

pub mod dates;
pub mod policy;

#[cfg(target_arch = "wasm32")]
pub mod api;
#[cfg(target_arch = "wasm32")]
pub mod store;

struct Component;

#[cfg(target_arch = "wasm32")]
impl exports::z::vendor_guard::contracts::Guest for Component {
    fn get_policy(
        req: exports::z::vendor_guard::contracts::GenericInput,
    ) -> Result<alloc::vec::Vec<u8>, alloc::string::String> {
        let input = req.input.ok_or("get-policy: missing input")?;
        api::get_policy(&input)
    }

    fn check_payout(
        req: exports::z::vendor_guard::contracts::GenericInput,
    ) -> Result<alloc::vec::Vec<u8>, alloc::string::String> {
        let input = req.input.ok_or("check-payout: missing input")?;
        api::check_payout(&input)
    }

    fn payout(
        req: exports::z::vendor_guard::contracts::GenericInput,
    ) -> Result<alloc::vec::Vec<u8>, alloc::string::String> {
        let input = req.input.ok_or("payout: missing input")?;
        api::payout(&input)
    }
}

#[cfg(target_arch = "wasm32")]
export!(Component);

#[cfg(test)]
mod tests {
    use super::CONTRACT_VERSION;

    #[test]
    fn contract_version_is_semver() {
        let parts: Vec<&str> = CONTRACT_VERSION.split('.').collect();
        assert_eq!(parts.len(), 3, "CONTRACT_VERSION must be MAJOR.MINOR.PATCH");
        for part in parts {
            assert!(part.parse::<u32>().is_ok(), "each part must be a number");
        }
    }
}
