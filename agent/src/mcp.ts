/**
 * An MCP server exposing the payment gate as tools.
 *
 * Implemented directly against the Model Context Protocol wire format —
 * newline-delimited JSON-RPC 2.0 over stdio — rather than pulling in an SDK. Two
 * reasons, and the second is the real one:
 *
 *   1. It keeps the agent's dependency surface at exactly one package (the T3N
 *      SDK), which matters for something that runs unattended next to money.
 *   2. The MCP surface *is* the agent's authority. Reading it in full, in one
 *      file, is how a reviewer confirms that `pay_vendor` demands an approval
 *      token and that no tool lets the model widen a limit. A framework would
 *      hide exactly the part worth auditing.
 *
 * The tool set is deliberately small. Notably absent: any tool that mints an
 * approval, edits the policy, or registers a vendor. Those are human actions
 * with their own CLI (`approver.ts`, `admin.ts`) precisely so that a language
 * model driving this server cannot reach them.
 */

import type { PaymentGate } from "./gate.ts";
import type { PayoutIntent } from "./types.ts";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "vendor-guard", version: "0.1.0" };

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const TOOLS = [
  {
    name: "get_policy",
    description:
      "Read the effective payout policy and the vendor registry from the T3N enclave. " +
      "Call this before proposing any payment so you know the real limits, currencies and " +
      "which vendors exist. Also returns ignored_overrides: any attempted policy change that " +
      "was refused because it would have loosened a limit.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "check_payout",
    description:
      "Ask the enclave whether a payout WOULD be allowed, without moving money and without " +
      "consuming any daily budget. Use this to test an intent. Returns decision 'allow', " +
      "'review' or 'deny' plus machine-readable reason codes. A 'deny' means a human must " +
      "change the policy; you cannot proceed by trying again or by splitting the amount.",
    inputSchema: {
      type: "object",
      properties: {
        vendor_id: { type: "string", description: "Vendor id from get_policy, e.g. 'acme-cloud'." },
        amount: { type: "integer", description: "Amount in MINOR units (cents). Integer only.", minimum: 1 },
        currency: { type: "string", description: "ISO-4217 code, e.g. 'USD'." },
        memo: { type: "string", description: "What this payment is for. Required above the policy's memo threshold." },
      },
      required: ["vendor_id", "amount", "currency"],
      additionalProperties: false,
    },
  },
  {
    name: "pay_vendor",
    description:
      "Execute a payout. Requires an approval_token: an HMAC token that a HUMAN minted for " +
      "this exact vendor, amount, currency and memo. You cannot create one. If you do not " +
      "have a token for precisely this intent, stop and ask the operator for one — do not " +
      "alter the amount or memo to fit a token you were given.",
    inputSchema: {
      type: "object",
      properties: {
        vendor_id: { type: "string" },
        amount: { type: "integer", description: "Amount in MINOR units (cents).", minimum: 1 },
        currency: { type: "string" },
        memo: { type: "string" },
        approval_token: {
          type: "string",
          description: "Token from the operator, of the form 'vg1.<payload>.<mac>'. Bound to one exact intent.",
        },
      },
      required: ["vendor_id", "amount", "currency", "approval_token"],
      additionalProperties: false,
    },
  },
  {
    name: "audit_tail",
    description:
      "Read the most recent entries of the local audit log: every check, refusal, approval " +
      "rejection and payment, with reason codes. Use this to answer 'what has this agent " +
      "done' without touching the cluster.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "How many recent entries to return. Default 20, max 500.", minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
  },
] as const;

export interface McpDeps {
  gate: PaymentGate;
  /** Read recent audit entries. Injected so the server is testable without a file. */
  auditTail: (limit: number) => Promise<unknown[]>;
}

function textResult(value: unknown, isError = false): unknown {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function asString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${field} is required and must be a non-empty string`);
  return v;
}

function asInt(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`${field} must be an integer (amounts are in minor units, never floats)`);
  return v;
}

/**
 * Handle one JSON-RPC message. Returns `null` for notifications (which take no
 * reply). Exported separately from the stdio loop so it can be driven directly
 * in tests.
 */
export async function handleMessage(deps: McpDeps, msg: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined || msg.id === null;

  const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return reply({});

    case "tools/list":
      return reply({ tools: TOOLS });

    case "tools/call": {
      const params = msg.params ?? {};
      const name = params.name;
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (typeof name !== "string") return fail(-32602, "tools/call requires a string 'name'");

      try {
        switch (name) {
          case "get_policy":
            return reply(textResult(await deps.gate.getPolicy()));

          case "check_payout": {
            const intent: PayoutIntent = {
              vendorId: asString(args.vendor_id, "vendor_id"),
              amount: asInt(args.amount, "amount"),
              currency: asString(args.currency, "currency"),
              memo: typeof args.memo === "string" ? args.memo : undefined,
            };
            return reply(textResult(await deps.gate.check(intent)));
          }

          case "pay_vendor": {
            const intent: PayoutIntent = {
              vendorId: asString(args.vendor_id, "vendor_id"),
              amount: asInt(args.amount, "amount"),
              currency: asString(args.currency, "currency"),
              memo: typeof args.memo === "string" ? args.memo : undefined,
            };
            const approvalToken = asString(args.approval_token, "approval_token");
            const outcome = await deps.gate.pay({ intent, approvalToken });
            // A refusal is a legitimate, informative result — not a protocol
            // error. Returning it as a normal tool result lets the model read
            // the reason codes and explain itself to the operator.
            return reply(textResult(outcome, outcome.status === "refused"));
          }

          case "audit_tail": {
            const raw = args.limit;
            const limit = raw === undefined ? 20 : asInt(raw, "limit");
            if (limit < 1 || limit > 500) throw new Error("limit must be between 1 and 500");
            return reply(textResult(await deps.auditTail(limit)));
          }

          default:
            return fail(-32602, `unknown tool '${name}'`);
        }
      } catch (err) {
        // Tool-level failures are results, not transport errors: the model
        // should see the message and be able to correct its call.
        return reply(textResult(`error: ${(err as Error).message}`, true));
      }
    }

    default:
      if (isNotification) return null;
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

/**
 * Run the server over stdio until stdin closes.
 *
 * Malformed input gets a JSON-RPC parse error rather than crashing the process —
 * a payment agent that dies on one bad line is worse than one that answers
 * "I did not understand that" and keeps its audit log consistent.
 */
export async function runStdio(deps: McpDeps): Promise<void> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n",
      );
      continue;
    }
    const response = await handleMessage(deps, msg);
    if (response !== null) process.stdout.write(JSON.stringify(response) + "\n");
  }
}

export { TOOLS };
