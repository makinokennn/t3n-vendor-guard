//! The three exported entry points.
//!
//! Each is a thin adapter: parse JSON, pull what it needs from the enclave, hand
//! it to the pure engine in [`crate::policy`], and shape the answer. All the
//! decision-making lives in `policy`/`dates`, which is why the security-relevant
//! logic is covered by plain `cargo test` rather than only by an end-to-end run.

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use crate::host::interfaces::{http_with_placeholders as hwp, logging};
use crate::policy::{self, normalise_currency, PayoutIntent, Policy};
use crate::store;

/// Largest memo we will forward. Bounded so a runaway caller cannot push an
/// unbounded blob through the enclave and out to the vendor.
const MAX_MEMO_LEN: usize = 280;
/// Largest approval reference we will accept.
const MAX_APPROVAL_REF_LEN: usize = 128;

// ---------------------------------------------------------------------------
// request / response shapes
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
struct CheckReq {
    vendor_id: String,
    amount: u64,
    currency: String,
    #[serde(default)]
    memo: Option<String>,
}

#[derive(serde::Deserialize)]
struct PayoutReq {
    vendor_id: String,
    amount: u64,
    currency: String,
    #[serde(default)]
    memo: Option<String>,
    approval_ref: String,
}

#[derive(serde::Serialize)]
struct ReasonOut {
    code: String,
    detail: String,
}

#[derive(serde::Serialize)]
struct PolicyView {
    max_single_payout: u64,
    max_daily_total: u64,
    allowed_currencies: Vec<String>,
    require_memo_over: u64,
    blocked_countries: Vec<String>,
}

/// Deliberately omits `bank_holder` and `payout_url`: an agent needs to know a
/// vendor exists and what currency/country it is in, but has no reason to hold
/// the account holder's name or the transfer endpoint. Minimal disclosure.
#[derive(serde::Serialize)]
struct VendorView {
    id: String,
    name: String,
    currency: String,
    country: String,
    active: bool,
    bank_last4: String,
}

fn policy_view(p: &Policy) -> PolicyView {
    PolicyView {
        max_single_payout: p.max_single_payout,
        max_daily_total: p.max_daily_total,
        allowed_currencies: p.allowed_currencies.clone(),
        require_memo_over: p.require_memo_over,
        blocked_countries: p.blocked_countries.clone(),
    }
}

fn reasons_out(e: &policy::Evaluation) -> Vec<ReasonOut> {
    policy::dedupe_reasons(e.reasons.clone())
        .into_iter()
        .map(|r| ReasonOut {
            code: r.code.to_string(),
            detail: r.detail,
        })
        .collect()
}

/// Effective policy = compiled-in defaults, tightened by tenant overrides.
/// Never loosened: see [`policy::Policy::tightened_with`].
fn effective_policy() -> Result<(Policy, Vec<String>), String> {
    let overrides = store::read_overrides()?;
    Ok(policy::Policy::default().tightened_with(overrides.as_ref()))
}

// ---------------------------------------------------------------------------
// get-policy
// ---------------------------------------------------------------------------

/// `{}` -> the effective policy plus the registered vendors. Read-only, no egress.
pub fn get_policy(_input: &[u8]) -> Result<Vec<u8>, String> {
    let (pol, ignored) = effective_policy()?;
    for note in &ignored {
        // A loosening override is a red flag worth surfacing loudly, but it must
        // not fail the read: the contract already refused to honour it.
        let _ = logging::error(&format!(
            "vendor-guard: ignored non-tightening policy override: {note}"
        ));
    }
    let vendors = store::read_all_vendors()?;
    let out = serde_json::json!({
        "contract_version": crate::CONTRACT_VERSION,
        "policy": policy_view(&pol),
        "vendors": vendors.iter().map(|v| VendorView {
            id: v.id.clone(),
            name: v.name.clone(),
            currency: v.currency.clone(),
            country: v.country.clone(),
            active: v.active,
            bank_last4: v.bank_last4.clone(),
        }).collect::<Vec<_>>(),
        "ignored_overrides": ignored,
    });
    serde_json::to_vec(&out).map_err(|e| format!("encode: {e}"))
}

// ---------------------------------------------------------------------------
// check-payout
// ---------------------------------------------------------------------------

/// Pre-flight. Evaluates policy and reports the decision **without moving money**.
///
/// This is the function an agent should call first, so that a denied intent never
/// reaches the vendor and never shows up in the tenant's audit log as an attempt.
pub fn check_payout(input: &[u8]) -> Result<Vec<u8>, String> {
    let req: CheckReq =
        serde_json::from_slice(input).map_err(|e| format!("check-payout: bad input: {e}"))?;

    let currency = normalise_currency(&req.currency).ok_or_else(|| {
        format!(
            "check-payout: '{}' is not a 3-letter currency code",
            req.currency
        )
    })?;
    validate_memo(&req.memo)?;

    let (pol, _ignored) = effective_policy()?;
    let vendor = store::read_vendor(&req.vendor_id)?;
    let intent = PayoutIntent {
        vendor_id: req.vendor_id.clone(),
        amount: req.amount,
        currency: currency.clone(),
        memo: req.memo.clone(),
    };
    let daily_spent = store::read_daily_spent(store::now_secs())?;
    let eval = pol.evaluate(vendor.as_ref(), &intent, daily_spent);

    let _ = logging::info(&format!(
        "vendor-guard check-payout vendor={} amount={} {} -> {} ({})",
        req.vendor_id,
        req.amount,
        currency,
        eval.decision.as_str(),
        eval.reasons
            .iter()
            .map(|r| r.code)
            .collect::<Vec<_>>()
            .join(",")
    ));

    let out = serde_json::json!({
        "decision": eval.decision.as_str(),
        "reasons": reasons_out(&eval),
        "policy_snapshot": policy_view(&pol),
        "vendor_id": req.vendor_id,
        "amount": req.amount,
        "currency": currency,
        "daily_spent": daily_spent,
    });
    serde_json::to_vec(&out).map_err(|e| format!("encode: {e}"))
}

// ---------------------------------------------------------------------------
// payout
// ---------------------------------------------------------------------------

/// Execute an already-allowed payout.
///
/// Policy is re-evaluated here from scratch. The earlier `check-payout` result is
/// *not* accepted as evidence: between the two calls the daily counter may have
/// moved, the vendor may have been switched off, or the caller may simply have
/// skipped the pre-flight. Re-evaluating is what makes the gate real.
///
/// The approver's identity is templated as `{{profile.*}}` markers and resolved
/// host-side, so it never enters this process's memory.
pub fn payout(input: &[u8]) -> Result<Vec<u8>, String> {
    let req: PayoutReq =
        serde_json::from_slice(input).map_err(|e| format!("payout: bad input: {e}"))?;

    let currency = normalise_currency(&req.currency)
        .ok_or_else(|| format!("payout: '{}' is not a 3-letter currency code", req.currency))?;
    validate_memo(&req.memo)?;

    let approval_ref = req.approval_ref.trim().to_string();
    if approval_ref.is_empty() || approval_ref.len() > MAX_APPROVAL_REF_LEN {
        return Err(format!(
            "payout: approval_ref must be 1..={MAX_APPROVAL_REF_LEN} characters"
        ));
    }

    let (pol, _ignored) = effective_policy()?;
    let vendor = store::read_vendor(&req.vendor_id)?;
    let intent = PayoutIntent {
        vendor_id: req.vendor_id.clone(),
        amount: req.amount,
        currency: currency.clone(),
        memo: req.memo.clone(),
    };
    let now = store::now_secs();
    let daily_spent = store::read_daily_spent(now)?;
    let eval = pol.evaluate(vendor.as_ref(), &intent, daily_spent);

    if eval.denied() {
        // A refusal is a business outcome, not a transport failure: return it as
        // structured data so the agent can explain it, and so it is recorded.
        let _ = logging::error(&format!(
            "vendor-guard payout REFUSED vendor={} amount={} {} ref={} reasons={}",
            req.vendor_id,
            req.amount,
            currency,
            approval_ref,
            eval.reasons
                .iter()
                .map(|r| r.code)
                .collect::<Vec<_>>()
                .join(",")
        ));
        let out = serde_json::json!({
            "status": "refused",
            "reasons": reasons_out(&eval),
            "vendor_id": req.vendor_id,
            "amount": req.amount,
            "currency": currency,
            "approval_ref": approval_ref,
        });
        return serde_json::to_vec(&out).map_err(|e| format!("encode: {e}"));
    }

    // `eval.denied()` is false, so the vendor is present and active.
    let vendor = vendor.ok_or("payout: vendor vanished between read and use")?;
    let api_key = store::read_vendor_api_key()?;

    // Deterministic reference for reconciliation. Same inputs -> same ref, which
    // is what makes it usable as an idempotency key at the vendor.
    let ref_id = policy::intent_ref(&[
        &vendor.id,
        &req.amount.to_string(),
        &currency,
        &approval_ref,
        &crate::dates::day_key(now),
    ]);

    // The two `{{profile.*}}` markers below are resolved by the HOST from the
    // paying user's profile at dispatch time. This contract authors a template;
    // it never sees the approver's name or email.
    let body = serde_json::json!({
        "vendor_id": vendor.id,
        "amount": req.amount,
        "currency": currency,
        "memo": req.memo,
        "reference": approval_ref,
        "idempotency_key": ref_id,
        "bank_last4": vendor.bank_last4,
        "approver_given_name": "{{profile.first_name}}",
        "approver_family_name": "{{profile.last_name}}",
        "approver_email": "{{profile.verified_contacts.email.value}}",
    });

    let payload = serde_json::to_vec(&body).map_err(|e| format!("encode payout body: {e}"))?;

    let resp = hwp::call(&hwp::Request {
        method: hwp::Verb::Post,
        url: vendor.payout_url.clone(),
        headers: Some(alloc::vec![
            ("Authorization".to_string(), format!("Bearer {api_key}")),
            ("Accept".to_string(), "application/json".to_string()),
            ("Idempotency-Key".to_string(), ref_id.clone()),
        ]),
        payload: Some(payload),
    })
    .map_err(map_hwp_error)?;

    if !(200..300).contains(&resp.code) {
        let text = String::from_utf8_lossy(&resp.payload).to_string();
        let _ = logging::error(&format!(
            "vendor-guard payout upstream {} for ref={}: {}",
            resp.code,
            ref_id,
            truncate(&text, 400)
        ));
        let out = serde_json::json!({
            "status": "upstream_error",
            "upstream_code": resp.code,
            "reference": ref_id,
            "vendor_id": req.vendor_id,
            "amount": req.amount,
            "currency": currency,
        });
        return serde_json::to_vec(&out).map_err(|e| format!("encode: {e}"));
    }

    // Only now, after the vendor accepted, does the day's counter move. Counting
    // before the call would burn budget on failed attempts; counting never would
    // let the cap be bypassed entirely.
    let new_total = store::add_daily_spent(now, req.amount)?;

    let upstream: serde_json::Value =
        serde_json::from_slice(&resp.payload).unwrap_or(serde_json::Value::Null);

    let _ = logging::info(&format!(
        "vendor-guard payout OK vendor={} amount={} {} ref={} daily_total={}",
        req.vendor_id, req.amount, currency, ref_id, new_total
    ));

    let out = serde_json::json!({
        "status": "paid",
        "id": upstream
            .get("id")
            .or_else(|| upstream.get("transfer_id"))
            .and_then(|v| v.as_str())
            .unwrap_or(&ref_id),
        "reference": ref_id,
        "vendor_id": req.vendor_id,
        "amount": req.amount,
        "currency": currency,
        "approval_ref": approval_ref,
        "daily_total": new_total,
        "review_flagged": eval.decision == policy::Decision::Review,
        "reasons": reasons_out(&eval),
    });
    serde_json::to_vec(&out).map_err(|e| format!("encode: {e}"))
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn validate_memo(memo: &Option<String>) -> Result<(), String> {
    if let Some(m) = memo {
        if m.len() > MAX_MEMO_LEN {
            return Err(format!("memo must be <= {MAX_MEMO_LEN} characters"));
        }
    }
    Ok(())
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    let mut out: String = s.chars().take(n).collect();
    out.push('…');
    out
}

/// Turn a host placeholder error into a message an operator can act on. These
/// variants are the difference between "the payment was blocked by policy" and
/// "the payment was blocked by a missing grant", which are very different bugs.
fn map_hwp_error(e: hwp::HttpError) -> String {
    match e {
        hwp::HttpError::EgressDenied(host) => format!(
            "host/http.egress_denied: '{host}' is not on the paying user's allowed-hosts grant"
        ),
        hwp::HttpError::PlaceholderDenied(marker) => format!(
            "host/http.placeholder_denied: marker '{marker}' is not permitted for this caller"
        ),
        hwp::HttpError::PlaceholderUnknown(marker) => format!(
            "host/http.placeholder_unknown: '{marker}' is not a field on the user profile schema"
        ),
        hwp::HttpError::PlaceholderNoUserContext => {
            "host/http.placeholder_no_user_context: no user context bound for placeholder resolution".to_string()
        }
        hwp::HttpError::UpstreamError(reason) => format!("upstream: {reason}"),
    }
}
