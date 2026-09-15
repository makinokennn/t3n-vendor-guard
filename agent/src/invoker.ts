/**
 * The real T3N invoker — the only file in this package that talks to the SDK.
 *
 * Why the stateless `invoke()` path instead of a `T3nClient` session: an agent
 * that pays vendors on a schedule is a *workload*, not a browser. `invoke()`
 * authenticates one request with the agent's opaque API key — no handshake, no
 * session to expire mid-run, no WASM component to load, no trust anchor to
 * refresh. Fewer moving parts on the money path is the whole point.
 *
 * (The session-based path still matters when you need delegation: a *user*
 * granting an agent the right to act for them. That grant is made out-of-band by
 * the user's own tooling — see `docs/DELEGATION.md` — and the resulting agent key
 * is what this file consumes. Keeping the grant ceremony out of the payment path
 * means a payment can never silently widen its own authority.)
 */

import { getContractVersion, getNodeUrl, invoke, setEnvironment } from "@terminal3/t3n-sdk";
import { canonicalContractName } from "./config.ts";
import type { ContractInvoker } from "./types.ts";
import { VendorGuardError } from "./types.ts";
import { validateCheckResult, validatePayoutResult, validatePolicyResponse } from "./validate.ts";

export type T3nEnvironment = "sandbox" | "testnet" | "production";

export interface SdkInvokerOptions {
  tenantDid: string;
  contractTail: string;
  /** The agent's own key (`t3n_key_...`) — never the tenant's key. */
  apiKey: string;
  environment?: T3nEnvironment;
  /** Override the resolved node URL (self-hosted node, local dev). */
  baseUrl?: string;
  /** How long a resolved contract version stays fresh. Default 5 minutes. */
  versionTtlMs?: number;
  /** Called with a line for each contract call, for operator visibility. */
  onCall?: (fn: string, phase: "start" | "ok" | "error") => void;
}

export class SdkContractInvoker implements ContractInvoker {
  readonly contractName: string;
  #apiKey: string;
  #baseUrl: string;
  #versionTtlMs: number;
  #onCall: SdkInvokerOptions["onCall"];
  #cachedVersion: { value: string; at: number } | null = null;

  constructor(opts: SdkInvokerOptions) {
    if (!opts.apiKey) {
      throw new VendorGuardError("config", "SdkContractInvoker needs an agent API key");
    }
    this.contractName = canonicalContractName(opts.tenantDid, opts.contractTail);
    this.#apiKey = opts.apiKey;
    this.#versionTtlMs = opts.versionTtlMs ?? 300_000;
    this.#onCall = opts.onCall;

    if (opts.environment) setEnvironment(opts.environment);
    this.#baseUrl = opts.baseUrl ?? getNodeUrl();
    if (!/^https:/.test(this.#baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(this.#baseUrl)) {
      throw new VendorGuardError(
        "config",
        `refusing to send an API key to a non-TLS node URL: ${this.#baseUrl}`,
      );
    }
  }

  async invoke<T>(functionName: string, input: unknown): Promise<T> {
    const version = await this.#version();
    this.#onCall?.(functionName, "start");
    let raw: unknown;
    try {
      raw = await invoke({
        baseUrl: this.#baseUrl,
        apiKey: this.#apiKey,
        request: {
          contract_id: this.contractName,
          contract_version: version,
          function_name: functionName,
          input,
        },
      });
    } catch (err) {
      // A version bump between the cache fill and this call is the one failure
      // that is worth retrying once, because the fix is simply to re-resolve.
      if (this.#looksLikeStaleVersion(err)) {
        this.#cachedVersion = null;
        const fresh = await this.#version();
        raw = await invoke({
          baseUrl: this.#baseUrl,
          apiKey: this.#apiKey,
          request: {
            contract_id: this.contractName,
            contract_version: fresh,
            function_name: functionName,
            input,
          },
        });
      } else {
        this.#onCall?.(functionName, "error");
        throw new VendorGuardError("transport", `${functionName} failed: ${String(err)}`);
      }
    }
    this.#onCall?.(functionName, "ok");
    return this.#decode<T>(functionName, raw);
  }

  #decode<T>(functionName: string, raw: unknown): T {
    switch (functionName) {
      case "check-payout":
        return validateCheckResult(raw) as unknown as T;
      case "get-policy":
        return validatePolicyResponse(raw) as unknown as T;
      case "payout":
        return validatePayoutResult(raw) as unknown as T;
      default:
        // Unknown function: pass through. The contract is the authority on its
        // own surface, and a validator here would silently lag behind it.
        return raw as T;
    }
  }

  async #version(): Promise<string> {
    const now = Date.now();
    if (this.#cachedVersion && now - this.#cachedVersion.at < this.#versionTtlMs) {
      return this.#cachedVersion.value;
    }
    const value = await getContractVersion(this.#baseUrl, this.contractName);
    if (typeof value !== "string" || value.trim() === "") {
      throw new VendorGuardError(
        "contract",
        `no registered version found for ${this.contractName} — has the contract been registered?`,
      );
    }
    this.#cachedVersion = { value, at: now };
    return value;
  }

  #looksLikeStaleVersion(err: unknown): boolean {
    const msg = String((err as Error)?.message ?? err).toLowerCase();
    return msg.includes("version") && (msg.includes("not found") || msg.includes("unknown") || msg.includes("mismatch"));
  }
}
