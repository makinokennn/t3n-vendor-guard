//! Pure, side-effect-free payout policy engine.
//!
//! This module deliberately has **no** dependency on any T3N host interface, so
//! the whole decision surface is unit-testable on the host target with plain
//! `cargo test` and cannot be perturbed by enclave I/O. The contract's WASM
//! entry points are thin adapters around `Policy::evaluate`.
//!
//! Money is represented in **minor units** (integer cents) everywhere. Floating
//! point is never used for an amount, so there is no rounding drift and no
//! `0.1 + 0.2` class of bug in a path that authorises money movement.

use alloc::collections::BTreeSet;
use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec;
use alloc::vec::Vec;

/// Hard, compiled-in limits. These are intentionally not caller-supplied: an
/// agent must not be able to widen its own authority by sending a bigger cap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Policy {
    /// Largest single payout, in minor units.
    pub max_single_payout: u64,
    /// Largest cumulative payout per UTC day, in minor units.
    pub max_daily_total: u64,
    /// Currencies the tenant is willing to pay in (ISO-4217, upper case).
    pub allowed_currencies: Vec<String>,
    /// A memo is mandatory at or above this amount (minor units).
    pub require_memo_over: u64,
    /// Vendor countries the tenant refuses to pay into (ISO-3166-1 alpha-2).
    pub blocked_countries: Vec<String>,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            max_single_payout: 250_000, // 2,500.00
            max_daily_total: 1_000_000, // 10,000.00
            allowed_currencies: vec!["USD".to_string(), "EUR".to_string(), "IDR".to_string()],
            require_memo_over: 100_000, // 1,000.00
            blocked_countries: Vec::new(),
        }
    }
}

/// A vendor as stored in the tenant's `state` KV map (JSON).
///
/// Serde derives are on the *data* type only — this module still imports no host
/// interface, so it stays testable with plain `cargo test`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct Vendor {
    pub id: String,
    pub name: String,
    /// ISO-4217 currency the vendor invoices in.
    pub currency: String,
    /// ISO-3166-1 alpha-2 country of the vendor's receiving bank.
    pub country: String,
    /// Whether the tenant has this vendor switched on.
    pub active: bool,
    /// Account holder name, as it will be checked against the bank record.
    pub bank_holder: String,
    /// Last four digits only — the contract never needs the full account number,
    /// and the full number never leaves the bank's system.
    pub bank_last4: String,
    /// HTTPS endpoint the vendor exposes for payouts. Its host must also appear
    /// in the paying user's delegation grant, or the call is refused with
    /// `host/http.egress_denied`.
    pub payout_url: String,
}

/// The intent under evaluation. Amount is minor units.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayoutIntent {
    pub vendor_id: String,
    pub amount: u64,
    pub currency: String,
    pub memo: Option<String>,
}

/// Policy outcome. `Review` exists so that a tenant can express "not auto-denied,
/// but a human must look" — a binary allow/deny forces every edge case into one
/// of two wrong buckets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Review,
    Deny,
}

impl Decision {
    pub fn as_str(self) -> &'static str {
        match self {
            Decision::Allow => "allow",
            Decision::Review => "review",
            Decision::Deny => "deny",
        }
    }
}

/// Machine-readable reason code. Stable strings, safe to branch on in a caller;
/// the free-text `detail` is for humans and may change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reason {
    pub code: &'static str,
    pub detail: String,
}

impl Reason {
    fn new(code: &'static str, detail: String) -> Self {
        Self { code, detail }
    }
}

/// The full result of one evaluation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Evaluation {
    pub decision: Decision,
    pub reasons: Vec<Reason>,
}

impl Evaluation {
    pub fn denied(&self) -> bool {
        self.decision == Decision::Deny
    }
}

impl Policy {
    /// Evaluate `intent` against this policy.
    ///
    /// `vendor` is `None` when the vendor id is not registered. `daily_spent` is
    /// the amount already paid out today, in the intent's currency.
    ///
    /// Evaluation is exhaustive: every failing rule is reported rather than
    /// short-circuiting, so a finance operator sees all the reasons at once
    /// instead of fixing one and rediscovering the next.
    pub fn evaluate(
        &self,
        vendor: Option<&Vendor>,
        intent: &PayoutIntent,
        daily_spent: u64,
    ) -> Evaluation {
        let mut reasons: Vec<Reason> = Vec::new();
        let mut needs_review = false;

        // --- vendor resolution -------------------------------------------------
        match vendor {
            None => reasons.push(Reason::new(
                "vendor_unknown",
                format!(
                    "vendor '{}' is not registered for this tenant",
                    intent.vendor_id
                ),
            )),
            Some(v) => {
                if !v.active {
                    reasons.push(Reason::new(
                        "vendor_inactive",
                        format!("vendor '{}' is switched off", v.id),
                    ));
                }
                if self
                    .blocked_countries
                    .iter()
                    .any(|c| c.eq_ignore_ascii_case(&v.country))
                {
                    reasons.push(Reason::new(
                        "vendor_country_blocked",
                        format!("payouts into {} are blocked by policy", v.country),
                    ));
                }
                if !v.currency.eq_ignore_ascii_case(&intent.currency) {
                    reasons.push(Reason::new(
                        "currency_mismatch",
                        format!(
                            "vendor invoices in {}, intent is in {}",
                            v.currency, intent.currency
                        ),
                    ));
                }
            }
        }

        // --- currency allow-list ----------------------------------------------
        if !self
            .allowed_currencies
            .iter()
            .any(|c| c.eq_ignore_ascii_case(&intent.currency))
        {
            reasons.push(Reason::new(
                "currency_not_allowed",
                format!(
                    "{} is not in the tenant's allowed currencies",
                    intent.currency
                ),
            ));
        }

        // --- amount sanity -----------------------------------------------------
        if intent.amount == 0 {
            reasons.push(Reason::new(
                "amount_zero",
                "amount must be greater than zero".to_string(),
            ));
        }

        // --- per-transaction cap ----------------------------------------------
        if intent.amount > self.max_single_payout {
            reasons.push(Reason::new(
                "amount_exceeds_single_cap",
                format!(
                    "{} exceeds the per-payout cap of {}",
                    intent.amount, self.max_single_payout
                ),
            ));
        }

        // --- rolling daily cap -------------------------------------------------
        // `saturating_add` so a hostile or corrupt ledger value cannot wrap into
        // a passing check.
        let projected = daily_spent.saturating_add(intent.amount);
        if projected > self.max_daily_total {
            reasons.push(Reason::new(
                "daily_cap_exceeded",
                format!(
                    "{} already paid today + {} would exceed the daily cap of {}",
                    daily_spent, intent.amount, self.max_daily_total
                ),
            ));
        }

        // --- memo requirement --------------------------------------------------
        if intent.amount >= self.require_memo_over {
            match intent.memo.as_deref().map(str::trim) {
                Some(m) if !m.is_empty() => {}
                _ => reasons.push(Reason::new(
                    "memo_required",
                    format!(
                        "a memo is required for payouts of {} or more",
                        self.require_memo_over
                    ),
                )),
            }
        }

        // --- soft signals -> review, never a hard deny -------------------------
        // Near-cap amounts are allowed but flagged: the operator gets an audit
        // trail without the agent being blocked on a legitimate payment.
        if intent.amount <= self.max_single_payout
            && intent.amount.saturating_mul(100) >= self.max_single_payout.saturating_mul(90)
        {
            needs_review = true;
            reasons.push(Reason::new(
                "near_single_cap",
                format!(
                    "{} is within 10% of the per-payout cap of {}",
                    intent.amount, self.max_single_payout
                ),
            ));
        }
        if projected <= self.max_daily_total
            && projected.saturating_mul(100) >= self.max_daily_total.saturating_mul(90)
        {
            needs_review = true;
            reasons.push(Reason::new(
                "near_daily_cap",
                format!(
                    "{} would be within 10% of the daily cap of {}",
                    projected, self.max_daily_total
                ),
            ));
        }

        let decision = if reasons.iter().any(|r| is_deny_code(r.code)) {
            Decision::Deny
        } else if needs_review {
            Decision::Review
        } else {
            Decision::Allow
        };

        Evaluation { decision, reasons }
    }
}

/// Codes that hard-deny. Anything not listed here is advisory (it may still
/// upgrade the decision to `review`, but it never blocks on its own).
pub fn is_deny_code(code: &str) -> bool {
    matches!(
        code,
        "vendor_unknown"
            | "vendor_inactive"
            | "vendor_country_blocked"
            | "currency_mismatch"
            | "currency_not_allowed"
            | "amount_zero"
            | "amount_exceeds_single_cap"
            | "daily_cap_exceeded"
            | "memo_required"
    )
}

/// Deterministic 64-bit FNV-1a, hex encoded.
///
/// Used to stamp each payout with a stable `intent_ref` that finance can
/// reconcile against the enclave's decision log. Deliberately dependency-free:
/// pulling a crypto hash in for a reference string would be gratuitous, and this
/// value is an identifier, never a security primitive.
pub fn intent_ref(parts: &[&str]) -> String {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut h = OFFSET;
    for p in parts {
        for b in p.as_bytes() {
            h ^= *b as u64;
            h = h.wrapping_mul(PRIME);
        }
        // separator so ["ab","c"] and ["a","bc"] do not collide
        h ^= 0x1f;
        h = h.wrapping_mul(PRIME);
    }
    format!("{h:016x}")
}

/// The set of currencies this build knows about, used only for input validation
/// so a typo'd currency is rejected early rather than sent upstream.
pub fn known_currency(code: &str) -> bool {
    const CODES: &[&str] = &[
        "USD", "EUR", "GBP", "IDR", "SGD", "AUD", "JPY", "CHF", "CAD", "INR",
    ];
    CODES.iter().any(|c| c.eq_ignore_ascii_case(code))
}

/// Normalise a currency code to upper case, rejecting anything that is not a
/// 3-letter alphabetic code.
pub fn normalise_currency(code: &str) -> Option<String> {
    let t = code.trim();
    if t.len() != 3 || !t.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    Some(t.to_ascii_uppercase())
}

/// Guard against a vendor record that tries to smuggle a control character or a
/// path traversal into a KV key or a log line.
pub fn safe_identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !s.contains("..")
}

/// Deduplicate reason codes, preserving first-seen order. Keeps responses small
/// when several rules fire for the same underlying cause.
pub fn dedupe_reasons(reasons: Vec<Reason>) -> Vec<Reason> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for r in reasons {
        if seen.insert(r.code) {
            out.push(r);
        }
    }
    out
}

/// Tenant-supplied policy overrides, stored as JSON under `policy/overrides` in
/// the `state` map.
///
/// Every field is optional: a tenant supplies only what it wants to change.
/// Critically, an override may only ever **tighten** the compiled-in defaults —
/// see [`Policy::tightened_with`]. That one-way rule is what makes the KV map
/// safe to hand to an operator: no data written there, by anyone, can widen the
/// contract's authority.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct PolicyOverride {
    #[serde(default)]
    pub max_single_payout: Option<u64>,
    #[serde(default)]
    pub max_daily_total: Option<u64>,
    #[serde(default)]
    pub require_memo_over: Option<u64>,
    #[serde(default)]
    pub allowed_currencies: Option<Vec<String>>,
    #[serde(default)]
    pub blocked_countries: Option<Vec<String>>,
}

impl Policy {
    /// Fold tenant overrides into this policy, **clamping in the tightening
    /// direction only**.
    ///
    /// Returns the effective policy and a list of human-readable notes for every
    /// override that was refused for trying to loosen a limit. Refusals are
    /// reported rather than raised: a rejected override must not be able to take
    /// the payment path offline, and the operator should see exactly which knob
    /// was ignored and why.
    ///
    /// Invariant, asserted by tests: for every field, the effective policy is at
    /// least as strict as `self`.
    pub fn tightened_with(&self, ov: Option<&PolicyOverride>) -> (Policy, Vec<String>) {
        let mut out = self.clone();
        let mut ignored: Vec<String> = Vec::new();

        let ov = match ov {
            None => return (out, ignored),
            Some(o) => o,
        };

        if let Some(v) = ov.max_single_payout {
            if v < out.max_single_payout {
                out.max_single_payout = v;
            } else if v > out.max_single_payout {
                ignored.push(format!(
                    "max_single_payout={v} would raise the cap above the compiled-in {}",
                    out.max_single_payout
                ));
            }
        }

        if let Some(v) = ov.max_daily_total {
            if v < out.max_daily_total {
                out.max_daily_total = v;
            } else if v > out.max_daily_total {
                ignored.push(format!(
                    "max_daily_total={v} would raise the cap above the compiled-in {}",
                    out.max_daily_total
                ));
            }
        }

        // Lowering the memo threshold *adds* a requirement, so it tightens.
        if let Some(v) = ov.require_memo_over {
            if v < out.require_memo_over {
                out.require_memo_over = v;
            } else if v > out.require_memo_over {
                ignored.push(format!(
                    "require_memo_over={v} would drop the memo requirement below the compiled-in {}",
                    out.require_memo_over
                ));
            }
        }

        if let Some(list) = &ov.allowed_currencies {
            // Intersection: a tenant may narrow the payable currencies, never add
            // one the build does not sanction.
            let mut narrowed: Vec<String> = Vec::new();
            for c in &out.allowed_currencies {
                if list.iter().any(|x| x.eq_ignore_ascii_case(c)) {
                    narrowed.push(c.clone());
                }
            }
            for c in list {
                if !out
                    .allowed_currencies
                    .iter()
                    .any(|x| x.eq_ignore_ascii_case(c))
                {
                    ignored.push(format!(
                        "allowed_currencies contains '{c}', which is not sanctioned by this build"
                    ));
                }
            }
            out.allowed_currencies = narrowed;
        }

        if let Some(list) = &ov.blocked_countries {
            // Union: blocks can be added, never removed.
            for c in list {
                if !out
                    .blocked_countries
                    .iter()
                    .any(|x| x.eq_ignore_ascii_case(c))
                {
                    out.blocked_countries.push(c.clone());
                }
            }
        }

        (out, ignored)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vendor(id: &str) -> Vendor {
        Vendor {
            id: id.to_string(),
            name: "Acme Cloud".to_string(),
            currency: "USD".to_string(),
            country: "US".to_string(),
            active: true,
            bank_holder: "Acme Cloud Inc".to_string(),
            bank_last4: "4242".to_string(),
            payout_url: "https://api.acme.example/v1/payouts".to_string(),
        }
    }

    fn intent(amount: u64) -> PayoutIntent {
        PayoutIntent {
            vendor_id: "acme".to_string(),
            amount,
            currency: "USD".to_string(),
            memo: Some("invoice 2026-09".to_string()),
        }
    }

    fn codes(e: &Evaluation) -> Vec<&'static str> {
        e.reasons.iter().map(|r| r.code).collect()
    }

    // --- happy path --------------------------------------------------------

    #[test]
    fn ordinary_payout_is_allowed() {
        let p = Policy::default();
        let e = p.evaluate(Some(&vendor("acme")), &intent(50_000), 0);
        assert_eq!(e.decision, Decision::Allow, "{:?}", e.reasons);
        assert!(e.reasons.is_empty());
    }

    // --- hard denials ------------------------------------------------------

    #[test]
    fn unknown_vendor_is_denied() {
        let p = Policy::default();
        let e = p.evaluate(None, &intent(1_000), 0);
        assert_eq!(e.decision, Decision::Deny);
        assert!(codes(&e).contains(&"vendor_unknown"));
    }

    #[test]
    fn inactive_vendor_is_denied() {
        let p = Policy::default();
        let mut v = vendor("acme");
        v.active = false;
        let e = p.evaluate(Some(&v), &intent(1_000), 0);
        assert_eq!(e.decision, Decision::Deny);
        assert!(codes(&e).contains(&"vendor_inactive"));
    }

    #[test]
    fn blocked_country_is_denied_case_insensitively() {
        let mut p = Policy::default();
        p.blocked_countries = vec!["ru".to_string()];
        let mut v = vendor("acme");
        v.country = "RU".to_string();
        let e = p.evaluate(Some(&v), &intent(1_000), 0);
        assert_eq!(e.decision, Decision::Deny);
        assert!(codes(&e).contains(&"vendor_country_blocked"));
    }

    #[test]
    fn currency_mismatch_with_vendor_is_denied() {
        let p = Policy::default();
        let mut v = vendor("acme");
        v.currency = "EUR".to_string();
        let e = p.evaluate(Some(&v), &intent(1_000), 0);
        assert_eq!(e.decision, Decision::Deny);
        assert!(codes(&e).contains(&"currency_mismatch"));
    }

    #[test]
    fn unlisted_currency_is_denied() {
        let p = Policy::default();
        let mut i = intent(1_000);
        i.currency = "ZWL".to_string();
        let e = p.evaluate(Some(&vendor("acme")), &i, 0);
        assert_eq!(e.decision, Decision::Deny);
        assert!(codes(&e).contains(&"currency_not_allowed"));
    }

    #[test]
    fn zero_amount_is_denied() {
        let p = Policy::default();
        let e = p.evaluate(Some(&vendor("acme")), &intent(0), 0);
        assert_eq!(e.decision, Decision::Deny);
        assert!(codes(&e).contains(&"amount_zero"));
    }

    #[test]
    fn amount_above_single_cap_is_denied() {
        let p = Policy::default();
        let e = p.evaluate(Some(&vendor("acme")), &intent(250_001), 0);
        assert_eq!(e.decision, Decision::Deny);
        assert!(codes(&e).contains(&"amount_exceeds_single_cap"));
    }

    #[test]
    fn exactly_at_single_cap_is_allowed() {
        // Boundary: the cap is inclusive. 250_000 is also within 10% of the cap,
        // so it is allowed but flagged for review.
        let p = Policy::default();
        let e = p.evaluate(Some(&vendor("acme")), &intent(250_000), 0);
        assert_ne!(e.decision, Decision::Deny);
        assert_eq!(e.decision, Decision::Review);
    }

    #[test]
    fn daily_cap_is_enforced_against_prior_spend() {
        let p = Policy::default();
        let e = p.evaluate(Some(&vendor("acme")), &intent(50_000), 990_000);
        assert_eq!(e.decision, Decision::Deny);
        assert!(codes(&e).contains(&"daily_cap_exceeded"));
    }

    #[test]
    fn daily_cap_uses_saturating_add_so_a_hostile_ledger_cannot_wrap() {
        let p = Policy::default();
        let e = p.evaluate(Some(&vendor("acme")), &intent(1), u64::MAX);
        assert_eq!(e.decision, Decision::Deny);
        assert!(codes(&e).contains(&"daily_cap_exceeded"));
    }

    #[test]
    fn memo_is_required_above_the_threshold() {
        let p = Policy::default();
        let mut i = intent(100_000);
        i.memo = None;
        let e = p.evaluate(Some(&vendor("acme")), &i, 0);
        assert_eq!(e.decision, Decision::Deny);
        assert!(codes(&e).contains(&"memo_required"));
    }

    #[test]
    fn whitespace_only_memo_does_not_satisfy_the_requirement() {
        let p = Policy::default();
        let mut i = intent(100_000);
        i.memo = Some("   \t ".to_string());
        let e = p.evaluate(Some(&vendor("acme")), &i, 0);
        assert_eq!(e.decision, Decision::Deny);
        assert!(codes(&e).contains(&"memo_required"));
    }

    #[test]
    fn memo_below_the_threshold_is_optional() {
        let p = Policy::default();
        let mut i = intent(99_999);
        i.memo = None;
        let e = p.evaluate(Some(&vendor("acme")), &i, 0);
        assert_eq!(e.decision, Decision::Allow, "{:?}", e.reasons);
    }

    // --- soft review band --------------------------------------------------

    #[test]
    fn near_cap_amount_is_reviewed_not_denied() {
        let p = Policy::default();
        // 90% of 250_000 = 225_000 -> review band starts here.
        let e = p.evaluate(Some(&vendor("acme")), &intent(225_000), 0);
        assert_eq!(e.decision, Decision::Review);
        assert!(codes(&e).contains(&"near_single_cap"));
    }

    #[test]
    fn just_below_review_band_is_a_clean_allow() {
        let p = Policy::default();
        let e = p.evaluate(Some(&vendor("acme")), &intent(224_999), 0);
        assert_eq!(e.decision, Decision::Allow, "{:?}", e.reasons);
    }

    #[test]
    fn a_deny_always_outranks_a_review_signal() {
        let p = Policy::default();
        // Above the cap AND near the cap: must deny, not merely review.
        let e = p.evaluate(Some(&vendor("acme")), &intent(300_000), 0);
        assert_eq!(e.decision, Decision::Deny);
    }

    #[test]
    fn every_failing_rule_is_reported_not_just_the_first() {
        // An operator should see the whole list at once, not fix one and
        // rediscover the next on the following attempt.
        let p = Policy::default();
        let mut i = intent(500_000);
        i.memo = None;
        i.currency = "ZWL".to_string();
        let e = p.evaluate(Some(&vendor("acme")), &i, 999_999);
        let c = codes(&e);
        assert!(c.contains(&"amount_exceeds_single_cap"));
        assert!(c.contains(&"daily_cap_exceeded"));
        assert!(c.contains(&"memo_required"));
        assert!(c.contains(&"currency_not_allowed"));
    }

    // --- tightening-only override rule ------------------------------------

    #[test]
    fn override_can_lower_a_cap() {
        let p = Policy::default();
        let ov = PolicyOverride {
            max_single_payout: Some(100_000),
            ..Default::default()
        };
        let (eff, ignored) = p.tightened_with(Some(&ov));
        assert_eq!(eff.max_single_payout, 100_000);
        assert!(ignored.is_empty());
    }

    #[test]
    fn override_cannot_raise_a_cap() {
        let p = Policy::default();
        let ov = PolicyOverride {
            max_single_payout: Some(10_000_000),
            ..Default::default()
        };
        let (eff, ignored) = p.tightened_with(Some(&ov));
        assert_eq!(
            eff.max_single_payout, p.max_single_payout,
            "cap must not rise"
        );
        assert_eq!(ignored.len(), 1);
        assert!(ignored[0].contains("would raise the cap"));
    }

    #[test]
    fn override_can_only_narrow_the_currency_list() {
        let p = Policy::default();
        let ov = PolicyOverride {
            allowed_currencies: Some(vec!["USD".to_string(), "XBT".to_string()]),
            ..Default::default()
        };
        let (eff, ignored) = p.tightened_with(Some(&ov));
        assert_eq!(eff.allowed_currencies, vec!["USD".to_string()]);
        assert_eq!(ignored.len(), 1, "unsanctioned currency must be reported");
        assert!(ignored[0].contains("XBT"));
    }

    #[test]
    fn override_can_only_add_blocked_countries() {
        let mut p = Policy::default();
        p.blocked_countries = vec!["RU".to_string()];
        let ov = PolicyOverride {
            blocked_countries: Some(vec!["KP".to_string()]),
            ..Default::default()
        };
        let (eff, _) = p.tightened_with(Some(&ov));
        assert!(eff.blocked_countries.contains(&"RU".to_string()));
        assert!(eff.blocked_countries.contains(&"KP".to_string()));
    }

    #[test]
    fn lowering_the_memo_threshold_tightens() {
        let p = Policy::default();
        let ov = PolicyOverride {
            require_memo_over: Some(1),
            ..Default::default()
        };
        let (eff, ignored) = p.tightened_with(Some(&ov));
        assert_eq!(eff.require_memo_over, 1);
        assert!(ignored.is_empty());
    }

    #[test]
    fn raising_the_memo_threshold_is_refused() {
        let p = Policy::default();
        let ov = PolicyOverride {
            require_memo_over: Some(10_000_000),
            ..Default::default()
        };
        let (eff, ignored) = p.tightened_with(Some(&ov));
        assert_eq!(eff.require_memo_over, p.require_memo_over);
        assert_eq!(ignored.len(), 1);
    }

    #[test]
    fn no_override_is_a_no_op() {
        let p = Policy::default();
        let (eff, ignored) = p.tightened_with(None);
        assert_eq!(eff, p);
        assert!(ignored.is_empty());
    }

    /// The core safety property, exercised over a grid of hostile overrides:
    /// **nothing** written to the KV map can make the policy more permissive.
    #[test]
    fn fuzz_overrides_never_loosen_the_policy() {
        let base = Policy::default();
        let candidates: Vec<Option<u64>> = vec![
            None,
            Some(0),
            Some(1),
            Some(250_000),
            Some(1_000_000),
            Some(u64::MAX),
        ];

        for &single in &candidates {
            for &daily in &candidates {
                for &memo in &candidates {
                    let ov = PolicyOverride {
                        max_single_payout: single,
                        max_daily_total: daily,
                        require_memo_over: memo,
                        allowed_currencies: Some(vec![
                            "USD".to_string(),
                            "EUR".to_string(),
                            "IDR".to_string(),
                            "ZWL".to_string(),
                        ]),
                        blocked_countries: Some(vec!["KP".to_string()]),
                    };
                    let (eff, _) = base.tightened_with(Some(&ov));

                    assert!(
                        eff.max_single_payout <= base.max_single_payout,
                        "single cap loosened: {single:?}"
                    );
                    assert!(
                        eff.max_daily_total <= base.max_daily_total,
                        "daily cap loosened: {daily:?}"
                    );
                    assert!(
                        eff.require_memo_over <= base.require_memo_over,
                        "memo threshold loosened: {memo:?}"
                    );
                    for c in &eff.allowed_currencies {
                        assert!(
                            base.allowed_currencies
                                .iter()
                                .any(|b| b.eq_ignore_ascii_case(c)),
                            "unsanctioned currency survived: {c}"
                        );
                    }
                    for c in &base.blocked_countries {
                        assert!(
                            eff.blocked_countries
                                .iter()
                                .any(|e| e.eq_ignore_ascii_case(c)),
                            "existing block was dropped: {c}"
                        );
                    }
                }
            }
        }
    }

    // --- identifier / helper units ----------------------------------------

    #[test]
    fn intent_ref_is_stable_and_input_sensitive() {
        let a = intent_ref(&["acme", "1000", "USD"]);
        let b = intent_ref(&["acme", "1000", "USD"]);
        let c = intent_ref(&["acme", "1001", "USD"]);
        assert_eq!(a, b, "same inputs must give the same reference");
        assert_ne!(a, c, "a changed amount must change the reference");
    }

    #[test]
    fn intent_ref_has_no_field_boundary_collisions() {
        // Without a separator, ["ab","c"] and ["a","bc"] would hash identically.
        assert_ne!(intent_ref(&["ab", "c"]), intent_ref(&["a", "bc"]));
    }

    #[test]
    fn currency_normalisation_rejects_junk() {
        assert_eq!(normalise_currency(" usd "), Some("USD".to_string()));
        assert_eq!(normalise_currency("US"), None);
        assert_eq!(normalise_currency("US1"), None);
        assert_eq!(normalise_currency(""), None);
        assert_eq!(normalise_currency("USDD"), None);
    }

    #[test]
    fn identifiers_reject_traversal_and_control_bytes() {
        assert!(safe_identifier("acme-cloud_1.2"));
        assert!(!safe_identifier(""));
        assert!(!safe_identifier("../etc/passwd"));
        assert!(!safe_identifier("a/b"));
        assert!(!safe_identifier("a b"));
        assert!(!safe_identifier("a\nb"));
        assert!(!safe_identifier(&"x".repeat(65)));
    }

    #[test]
    fn reason_dedupe_keeps_first_occurrence_order() {
        let r = vec![
            Reason::new("b", "second".to_string()),
            Reason::new("a", "first".to_string()),
            Reason::new("b", "duplicate".to_string()),
        ];
        let d = dedupe_reasons(r);
        assert_eq!(d.len(), 2);
        assert_eq!(d[0].code, "b");
        assert_eq!(d[0].detail, "second");
        assert_eq!(d[1].code, "a");
    }
}
