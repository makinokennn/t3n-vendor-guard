/**
 * End-to-end proof that the contract really runs on Terminal 3.
 *
 *   . /root/.t3n_env.sh && npx tsx src/e2e.ts        # or: npm run e2e
 *
 * Requires: TENANT_API_KEY (the tenant's own 0x… key) and AGENT_TENANT_DID, plus
 * the contract already registered under the `vendor-guard` tail with its maps
 * created and a vendor seeded (see docs/SETUP.md steps 5-7).
 *
 * This is the documented **direct (self) call**: the tenant invokes its own
 * contract, so no separate agent key is needed. It deliberately does NOT use the
 * keyed `invoke()` helper, because that one wants an agent's opaque
 * `t3n_key_…`; an authenticated session is the path for a self-call.
 *
 * What it proves:
 *   1. the contract is deployed and executes inside the enclave
 *   2. it reads the state and secrets maps seeded by `admin.ts`
 *   3. the policy engine allows and denies correctly, with reason codes
 *   4. a payout attempt is stopped by the host, not by the contract, because
 *      egress belongs to the paying user's grant
 *
 * It does NOT prove a successful vendor HTTP call: that needs a real
 * allowed-hosts grant plus a live payout endpoint. See BUGS.md and
 * docs/SETUP.md ("What is not covered").
 */
import {
  T3nClient,
  createEthAuthInput,
  eth_get_address,
  fetchTrustedManifest,
  getContractVersion,
  getNodeUrl,
  loadWasmComponent,
  metamask_sign,
  setEnvironment,
} from "@terminal3/t3n-sdk";

const KEY = process.env.TENANT_API_KEY;
const DID = process.env.AGENT_TENANT_DID;
const ENV = (process.env.T3N_ENVIRONMENT ?? "testnet") as "sandbox" | "testnet";
const TAIL = process.env.AGENT_CONTRACT_TAIL ?? "vendor-guard";
const VENDOR = process.env.E2E_VENDOR ?? "acme-cloud";

if (!KEY || !DID) {
  console.error("TENANT_API_KEY and AGENT_TENANT_DID must both be set");
  process.exit(2);
}

const line = (s: string) => console.log(s);

async function main() {
  setEnvironment(ENV);
  const address = eth_get_address(KEY!);
  const wasmComponent = await loadWasmComponent();

  const t3n = new T3nClient({
    trustAnchor: await fetchTrustedManifest(ENV),
    wasmComponent,
    handlers: { EthSign: metamask_sign(address, undefined, KEY) },
  });

  await t3n.handshake();
  await t3n.authenticate(createEthAuthInput(address));

  const baseUrl = getNodeUrl();
  const contractName = `z:${DID!.replace(/^did:t3n:/, "")}:${TAIL}`;
  // contract_version is mandatory on the wire request; omitting it is an HTTP 400.
  const version = await getContractVersion(baseUrl, contractName);

  line(`tenant    : ${DID}`);
  line(`contract  : ${contractName}`);
  line(`version   : ${version}`);
  line("");

  const call = async (fn: string, input: unknown): Promise<any> => {
    const raw: any = await t3n.execute({
      contract_id: contractName,
      contract_version: version,
      function_name: fn,
      input,
    } as any);
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  };

  line("=== 1. get-policy (read-only: the contract runs and reads its maps) ===");
  const pol = await call("get-policy", {});
  line(`policy  : single=${pol.policy.max_single_payout} daily=${pol.policy.max_daily_total} ` +
       `currencies=${pol.policy.allowed_currencies.join("/")}`);
  line(`vendors : ${pol.vendors.map((v: any) => `${v.id} (${v.currency}, ${v.country}, ****${v.bank_last4})`).join(", ")}`);
  line(`ignored_overrides: ${JSON.stringify(pol.ignored_overrides)}`);
  line("");

  const brief = (label: string, r: any) => {
    line(`${label}: ${r.decision}`);
    for (const reason of r.reasons ?? []) line(`    ${reason.code}: ${reason.detail}`);
    if ((r.reasons ?? []).length === 0) line("    (no reasons: every rule passed)");
  };

  line(`=== 2. check-payout: 12500 USD to ${VENDOR} (expect allow) ===`);
  brief("decision", await call("check-payout", {
    vendor_id: VENDOR, amount: 12500, currency: "USD", memo: "INV-2026-0042",
  }));
  line("");

  line("=== 3. check-payout: 90000000 USD (expect deny: over the per-payout cap) ===");
  brief("decision", await call("check-payout", {
    vendor_id: VENDOR, amount: 90000000, currency: "USD", memo: "urgent",
  }));
  line("");

  line("=== 4. check-payout: an unregistered vendor (expect deny) ===");
  brief("decision", await call("check-payout", {
    vendor_id: "does-not-exist", amount: 100, currency: "USD",
  }));
  line("");

  line("=== 5. payout: the money path (no grant, so the HOST should refuse) ===");
  try {
    line(JSON.stringify(await call("payout", {
      vendor_id: VENDOR, amount: 12500, currency: "USD",
      memo: "INV-2026-0042", approval_ref: "e2e-selfcall-001",
    }), null, 2));
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    line(msg.slice(0, 300));
    if (msg.includes("egress_denied")) {
      line("");
      line("This is the designed outcome, not a failure. Egress is authorized by the");
      line("paying user, never by the contract, so a self-call with no allowed-hosts");
      line("grant is refused by the host. The contract did reach the egress attempt,");
      line("which is the whole point of putting the policy inside the enclave.");
    }
  }
}

main().catch((e) => { console.error("FATAL:", e?.message ?? e); process.exit(1); });
