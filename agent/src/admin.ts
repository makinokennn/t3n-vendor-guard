#!/usr/bin/env node
/**
 * vendor-guard-admin — the tenant owner's tool. A separate binary, like the
 * approver's, and for the same reason: **the agent must not be able to do this.**
 *
 * This is the only program that can:
 *
 *   - create the two KV maps the contract reads (`state`, `secrets`)
 *   - register a vendor (which is what puts a payout URL in front of the money)
 *   - seed the vendor API key into the enclave
 *
 * None of these are exposed over MCP. An agent that can register a vendor can
 * redirect a payout to an account of its choosing, so the capability is kept off
 * the agent's surface entirely rather than guarded by a check inside it.
 *
 * Everything here runs on the *tenant* path (`tenant.executeControl`), not the
 * agent path — a control-plane write that bypasses the maps' `writers` ACL. That
 * is the documented way to seed a secret: there is no `set-credentials` export,
 * and there must not be one, because an export that writes a key is an export
 * that can be talked into writing a different key.
 *
 *   vendor-guard-admin register --version 0.1.0 [--wasm <path>]
 *   vendor-guard-admin create-maps --contract-id <n>
 *   vendor-guard-admin add-vendor --id acme-cloud --name "Acme Cloud" \
 *     --currency USD --country US --bank-holder "Acme Cloud Inc" \
 *     --bank-last4 4242 --payout-url https://api.acme.example/v1/payouts --active
 *   vendor-guard-admin seed-api-key            # reads VENDOR_API_KEY
 *   vendor-guard-admin show
 *
 * Environment:
 *   TENANT_API_KEY     the TENANT's Ethereum private key (0x…) — never the agent's
 *   AGENT_TENANT_DID   did:t3n:<hex>
 *   T3N_ENVIRONMENT    sandbox | testnet | production (default testnet)
 *   VENDOR_API_KEY     only for `seed-api-key`
 */

import { readFile } from "node:fs/promises";

import {
  T3nClient,
  TenantClient,
  createEthAuthInput,
  eth_get_address,
  fetchTrustedManifest,
  getNodeUrl,
  loadWasmComponent,
  metamask_sign,
  setEnvironment,
} from "@terminal3/t3n-sdk";

type Env = "sandbox" | "testnet" | "production";

const CONTRACT_TAIL = "vendor-guard";

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function need(flags: Record<string, string | boolean>, key: string): string {
  const v = flags[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`--${key} is required`);
  }
  return v.trim();
}

// ---------------------------------------------------------------------------
// tenant session
// ---------------------------------------------------------------------------

/**
 * Build an authenticated *tenant* client.
 *
 * This is the session-based path, deliberately — the opposite of the agent's
 * stateless `invoke()`. Admin work is a human-driven, interactive, multi-step
 * operation, so paying for a handshake once is cheaper than authenticating every
 * call. The agent's path is the other way round because it runs unattended.
 */
async function tenantSession() {
  const privateKey = process.env.TENANT_API_KEY;
  if (!privateKey) {
    throw new Error(
      "TENANT_API_KEY is not set. This must be the TENANT's key (0x-prefixed) — the agent has its own, and it must not be used here.",
    );
  }
  const tenantDid = process.env.AGENT_TENANT_DID;
  if (!tenantDid) throw new Error("AGENT_TENANT_DID is not set");

  const env = (process.env.T3N_ENVIRONMENT ?? "testnet") as Env;
  setEnvironment(env);

  const wasmComponent = await loadWasmComponent();
  const address = eth_get_address(privateKey);

  const t3n = new T3nClient({
    trustAnchor: await fetchTrustedManifest(env),
    wasmComponent,
    handlers: { EthSign: metamask_sign(address, undefined, privateKey) },
  });

  await t3n.handshake();
  await t3n.authenticate(createEthAuthInput(address));

  const tenant = new TenantClient({ t3n, baseUrl: getNodeUrl(), tenantDid });
  await tenant.tenant.me(); // throws if the session cannot actually manage this tenant
  return tenant;
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

/**
 * Register (or re-register) the contract component.
 *
 * Registration only stores the WASM and records a versioned entry — it does not
 * run the code, create maps, or grant egress. It does, however, mint the numeric
 * `contract_id` that the map ACLs are scoped to, which is why it runs first.
 *
 * The id is printed prominently and must be recorded: **re-registering the same
 * tail allocates a NEW contract_id**, and the SDK exposes no lookup for a tail's
 * current id (`ListedContract` has no `contract_id` field at all). A stale id
 * silently breaks map access, so the operator has to keep this number.
 */
async function cmdRegister(tenant: TenantClient, flags: Record<string, string | boolean>) {
  const version = need(flags, "version");
  const wasmPath =
    typeof flags.wasm === "string"
      ? flags.wasm
      : "../contract/target/wasm32-wasip2/release/vendor_guard.wasm";

  const wasm = await readFile(wasmPath).catch((e: unknown) => {
    throw new Error(`cannot read ${wasmPath}: ${String((e as Error)?.message ?? e)}`);
  });

  const result = await tenant.contracts.register({
    tail: CONTRACT_TAIL,
    version,
    wasm,
  });

  console.log(`registered ${tenant.canonicalName(CONTRACT_TAIL)} @ ${version}`);
  console.log(`  contract_id = ${result.contract_id}`);
  console.log(
    `\nRecord that id — it is what the map ACLs point at, and re-registering\n` +
      `allocates a fresh one with no SDK lookup to recover it.`,
  );
}

/**
 * Create the two maps the contract reads.
 *
 * Both ACLs are set to the numeric `contract_id` from registration, not to the
 * contract's canonical name: the wire type is `"all" | { only: number[] }`.
 * Passing a name string here is a type error, and at runtime it would leave the
 * contract unable to read its own registry.
 *
 * `readers` is set explicitly and that is not cosmetic: the runtime defaults an
 * unspecified `readers` to **deny-all**, so the map is created successfully and
 * then every read fails — including the contract's own read of its own secret.
 * The SDK only emits a `console.warn` when `readers` is omitted, so this is a
 * genuinely silent failure mode. Both sets are always stated.
 *
 * `MapAlreadyExists` is expected on a re-run and treated as success.
 */
async function cmdCreateMaps(tenant: TenantClient, flags: Record<string, string | boolean>) {
  const contractId = Number(need(flags, "contract-id"));
  if (!Number.isInteger(contractId) || contractId <= 0) {
    throw new Error(
      "--contract-id must be the numeric id returned by `register`. The map ACL type is { only: number[] } — a canonical name will not do.",
    );
  }

  for (const tail of ["state", "secrets"]) {
    try {
      await tenant.maps.create({
        tail,
        visibility: "private",
        writers: { only: [contractId] },
        readers: { only: [contractId] },
      });
      console.log(`created z:<tid>:${tail}  (writers/readers: contract_id ${contractId})`);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (/already exists/i.test(msg)) {
        console.log(`z:<tid>:${tail} already exists — ok`);
      } else {
        throw err;
      }
    }
  }
  console.log(
    "\nNext: `add-vendor` for each payee, then `seed-api-key`. Both maps are readable\n" +
      "only by the contract — the agent cannot read the registry or the key.",
  );
}

/**
 * Register a vendor.
 *
 * The JSON shape must match `Vendor` in `contract/src/policy.rs` exactly; that
 * struct has no `rename_all`, so these are the literal Rust field names. A
 * mismatch is not silently ignored — `read_vendor` parses strictly and reports a
 * malformed record as an error rather than as "vendor absent", so a typo here
 * fails loudly at the first `check-payout` rather than at payout time.
 */
async function cmdAddVendor(tenant: TenantClient, flags: Record<string, string | boolean>) {
  const vendor = {
    id: need(flags, "id"),
    name: need(flags, "name"),
    currency: need(flags, "currency").toUpperCase(),
    country: need(flags, "country").toUpperCase(),
    active: flags.active === true,
    bank_holder: need(flags, "bank-holder"),
    bank_last4: need(flags, "bank-last4"),
    payout_url: need(flags, "payout-url"),
  };

  if (!/^[A-Z]{3}$/.test(vendor.currency)) throw new Error("--currency must be a 3-letter ISO-4217 code");
  if (!/^[A-Z]{2}$/.test(vendor.country)) throw new Error("--country must be a 2-letter ISO-3166-1 code");
  if (!/^[0-9]{4}$/.test(vendor.bank_last4)) throw new Error("--bank-last4 must be exactly 4 digits");
  if (!/^https:\/\//.test(vendor.payout_url)) {
    throw new Error("--payout-url must be https:// — the enclave will not egress to a plaintext endpoint");
  }
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(vendor.id)) {
    throw new Error("--id must be 2..=63 chars of [a-z0-9_-] (the contract enforces the same rule)");
  }

  await tenant.executeControl("map-entry-set", {
    map_name: tenant.canonicalName("state"),
    key: `vendor/${vendor.id}`,
    value: JSON.stringify(vendor),
  });

  console.log(
    `registered vendor '${vendor.id}' (${vendor.active ? "active" : "INACTIVE"}) in z:<tid>:state`,
  );
  console.log(
    "\nNote: the payout_url host must also be present in the paying user's allowed-hosts\n" +
      "grant, or the contract's call fails with host/http.egress_denied. Egress is\ngranted to the user, not to the contract.",
  );
}

/**
 * Seed the vendor API key.
 *
 * Read from `VENDOR_API_KEY` rather than a flag so the key does not land in shell
 * history or in `ps` output.
 */
async function cmdSeedApiKey(tenant: TenantClient) {
  const value = process.env.VENDOR_API_KEY;
  if (!value) throw new Error("VENDOR_API_KEY is not set");
  await tenant.executeControl("map-entry-set", {
    map_name: tenant.canonicalName("secrets"),
    key: "vendor_api_key",
    value,
  });
  console.log(
    "sealed vendor_api_key in z:<tid>:secrets — readable only inside the enclave,\n" +
      "and there is no export that returns it.",
  );
}

/** Read back what is actually stored, so an operator can verify rather than assume. */
async function cmdShow(tenant: TenantClient) {
  console.log(`map: ${tenant.canonicalName("state")}`);
  console.log(
    "  (the tenant surface reads exact keys only — there is no prefix scan here,\n" +
      "   so listing the registry means asking for each vendor id by name)",
  );

  const vendorId = process.env.SHOW_VENDOR;
  if (vendorId) {
    const raw = await tenant.maps.entryGet("state", `vendor/${vendorId}`);
    console.log(`  vendor/${vendorId}: ${raw ?? "<absent>"}`);
  } else {
    console.log("  set SHOW_VENDOR=<id> to read one vendor back");
  }

  const overrides = await tenant.maps.entryGet("state", "policy/overrides");
  console.log(`  policy/overrides: ${overrides ?? "<none set — defaults apply>"}`);

  // The secrets map is deliberately NOT readable here in general; the owner can
  // read it, but printing a key to a terminal is how keys end up in scrollback.
  console.log("\nsecrets: not printed. Use `check-payout` on the contract to prove the key works.");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));

  if (cmd === undefined || cmd === "help" || flags.help === true) {
    console.log(`vendor-guard-admin — tenant owner's tool (never run by the agent)

  register    --version <semver> [--wasm <path>]   register the contract, print contract_id
  create-maps --contract-id <n>                    create the state + secrets KV maps
  add-vendor  --id --name --currency --country --bank-holder --bank-last4
              --payout-url [--active]
  seed-api-key                      seal VENDOR_API_KEY into z:<tid>:secrets
  show                              read back registry + overrides

Run order: register → create-maps --contract-id <n> → add-vendor… → seed-api-key.

env: TENANT_API_KEY (the tenant's, not the agent's), AGENT_TENANT_DID,
     T3N_ENVIRONMENT (default testnet), VENDOR_API_KEY (seed-api-key only)`);
    return;
  }

  const tenant = await tenantSession();
  switch (cmd) {
    case "register":
      return cmdRegister(tenant, flags);
    case "create-maps":
      return cmdCreateMaps(tenant, flags);
    case "add-vendor":
      return cmdAddVendor(tenant, flags);
    case "seed-api-key":
      return cmdSeedApiKey(tenant);
    case "show":
      return cmdShow(tenant);
    default:
      throw new Error(`unknown command '${cmd}' — try: vendor-guard-admin help`);
  }
}

main().catch((err) => {
  console.error(`vendor-guard-admin: ${String((err as Error)?.message ?? err)}`);
  process.exitCode = 1;
});
