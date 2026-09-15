/**
 * The payment gate — where policy, approval and audit meet.
 *
 * Read `pay()` top to bottom: it is the whole control flow, in order, with no
 * hidden branches. That is intentional. A reviewer should be able to confirm the
 * security properties by reading one function:
 *
 *   1. Policy is checked **inside the TEE** and its answer is what we act on.
 *      The local copy of the policy is only ever used for pre-flight messaging.
 *   2. A `deny` stops here. The vendor is never contacted.
 *   3. A human approval token is verified, and it is bound to the exact amount.
 *   4. Only then is `payout` called — and the contract re-evaluates policy on its
 *      own side, so nothing here has to be trusted for the money to be safe.
 */

import { AuditLog, AuditNonceStore } from "./audit.ts";
import { verifyApproval } from "./approval.ts";
import { canonicalContractName } from "./config.ts";
import type {
  AgentConfig,
  CheckResult,
  ContractInvoker,
  PayoutIntent,
  PayoutResult,
  PolicyResponse,
} from "./types.ts";
import { VendorGuardError } from "./types.ts";

export interface PayRequest {
  intent: PayoutIntent;
  /** HMAC approval token minted by the approver for exactly this intent. */
  approvalToken: string;
}

export interface PayOutcome {
  status: PayoutResult["status"];
  /** Populated when the money moved. */
  reference?: string;
  /** Populated when it did not, and why. */
  reasons?: { code: string; detail: string }[];
  decision: CheckResult["decision"];
  /** True when the payment went through but policy flagged it for review. */
  reviewFlagged: boolean;
}

export class PaymentGate {
  readonly #invoker: ContractInvoker;
  readonly #config: AgentConfig;
  readonly #audit: AuditLog;
  readonly #nonces: AuditNonceStore;
  readonly #contractName: string;

  constructor(invoker: ContractInvoker, config: AgentConfig, audit: AuditLog) {
    this.#invoker = invoker;
    this.#config = config;
    this.#audit = audit;
    this.#nonces = new AuditNonceStore(audit);
    this.#contractName = canonicalContractName(config.tenantDid, config.contractTail);
  }

  /** The canonical contract name this gate calls, e.g. `z:<tid>:vendor-guard`. */
  get contractName(): string {
    return this.#contractName;
  }

  /** Read the effective policy and the vendor registry from the enclave. */
  async getPolicy(): Promise<PolicyResponse> {
    try {
      return await this.#invoker.invoke<PolicyResponse>("get-policy", {});
    } catch (err) {
      throw new VendorGuardError("transport", `get-policy failed: ${String(err)}`);
    }
  }

  /**
   * Ask the enclave whether an intent *would* be allowed. Moves no money and
   * writes no counter, so it is free to call as often as you like.
   */
  async check(intent: PayoutIntent): Promise<CheckResult> {
    const result = await this.#invokeContract<CheckResult>("check-payout", {
      vendor_id: intent.vendorId,
      amount: intent.amount,
      currency: intent.currency,
      memo: intent.memo,
    });

    await this.#audit.append({
      event: "check",
      intent,
      decision: result.decision,
      reasons: result.reasons,
    });

    return result;
  }

  /**
   * The only method that can move money.
   *
   * Order is load-bearing: policy first (cheap, and stops the common case), then
   * approval (expensive to forge, and only meaningful for an allowed intent).
   * Verifying approval before policy would waste the approver's attention on
   * intents the policy rejects anyway.
   */
  async pay(req: PayRequest): Promise<PayOutcome> {
    const { intent, approvalToken } = req;

    // --- 1. policy, evaluated in the enclave ------------------------------
    const check = await this.check(intent);

    if (check.decision === "deny") {
      await this.#audit.append({
        event: "refused",
        intent,
        decision: "deny",
        reasons: check.reasons,
        detail: "contract policy denied the intent; no approval was requested",
      });
      return {
        status: "refused",
        decision: "deny",
        reasons: check.reasons,
        reviewFlagged: false,
      };
    }

    if (check.decision === "review" && !this.#config.allowReview) {
      await this.#audit.append({
        event: "refused",
        intent,
        decision: "review",
        reasons: check.reasons,
        detail:
          "policy flagged this for human review and AGENT_ALLOW_REVIEW is false; " +
          "a review-flagged payment needs a human to raise the limit or set AGENT_ALLOW_REVIEW=true",
      });
      return {
        status: "refused",
        decision: "review",
        reasons: check.reasons,
        reviewFlagged: true,
      };
    }

    // --- 2. approval, bound to this exact intent --------------------------
    let approver: string;
    let nonce: string;
    try {
      const token = await verifyApproval(
        this.#config.approvalSecret,
        approvalToken,
        intent,
        {
          maxTtlSecs: this.#config.maxApprovalTtlSecs,
          isNonceUsed: (n) => this.#nonces.isUsed(n),
        },
      );
      approver = token.approver;
      nonce = token.nonce;
    } catch (err) {
      const reasons =
        err instanceof VendorGuardError
          ? [{ code: "approval_invalid", detail: err.message }]
          : [{ code: "approval_invalid", detail: String(err) }];
      await this.#audit.append({
        event: "approval_rejected",
        intent,
        decision: check.decision,
        reasons,
        detail: "payment not attempted",
      });
      return {
        status: "refused",
        decision: check.decision,
        reasons,
        reviewFlagged: check.decision === "review",
      };
    }

    // --- 3. execute. The contract re-evaluates policy on its own side. -----
    const result = await this.#invokeContract<PayoutResult>("payout", {
      vendor_id: intent.vendorId,
      amount: intent.amount,
      currency: intent.currency,
      memo: intent.memo,
      approval_ref: `approver:${approver};nonce:${nonce}`,
    });

    if (result.status === "paid") {
      this.#nonces.remember(nonce);
      await this.#audit.append({
        event: "paid",
        intent,
        decision: check.decision,
        reasons: result.reasons,
        reference: result.reference,
        approver,
        nonce,
      });
    } else if (result.status === "upstream_error") {
      await this.#audit.append({
        event: "upstream_error",
        intent,
        decision: check.decision,
        reference: result.reference,
        approver,
        nonce,
        detail: `vendor returned HTTP ${result.upstream_code}`,
      });
    } else {
      // The contract refused a payout that our pre-flight allowed. This means
      // state moved between the two calls — the most likely cause is another
      // payout consuming the daily budget. Worth logging loudly.
      await this.#audit.append({
        event: "refused",
        intent,
        decision: "deny",
        reasons: result.reasons,
        approver,
        nonce,
        detail:
          "contract refused at payout time despite an allowing pre-flight — " +
          "policy state changed between check and payout",
      });
    }

    return {
      status: result.status,
      reference: result.reference,
      reasons: result.reasons,
      decision: check.decision,
      reviewFlagged: check.decision === "review",
    };
  }

  async #invokeContract<T>(fn: string, input: unknown): Promise<T> {
    try {
      return await this.#invoker.invoke<T>(fn, input);
    } catch (err) {
      await this.#audit.append({
        event: "transport_error",
        detail: `${fn} failed: ${String(err)}`,
      });
      throw err;
    }
  }
}
