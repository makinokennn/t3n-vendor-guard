/**
 * Append-only audit log, and the nonce store built on it.
 *
 * Every decision the agent makes — allowed, reviewed, refused, paid — is
 * written here before the caller sees the result. For an agent that moves money,
 * "what did it do and why" is not a nice-to-have: it is the artefact a finance
 * team reconciles against, and the only way to notice a policy that is being
 * probed rather than obeyed.
 *
 * Format is JSONL: one self-contained object per line. Appending a line is
 * atomic enough for a single writer, it survives a crash mid-run without
 * corrupting earlier entries, and it is readable by `jq`, by grep, and by
 * anything that speaks text. A binary format would buy nothing here.
 *
 * Honest limitation: this is a *local* log. A compromised agent host can delete
 * or rewrite it. In a real deployment the durable copy belongs in the tenant's
 * TEE KV store (`z:<tid>:state`), which the agent cannot edit — the contract
 * already writes its own decision lines via `logging`, and those are the ones to
 * trust. This file is for the operator's convenience and for the audit trail a
 * reviewer can read without cluster access.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuditEntry, AuditEvent } from "./types.ts";

export interface AppendInput {
  event: AuditEvent;
  intent?: { vendorId: string; amount: number; currency: string; memo?: string };
  decision?: string;
  reasons?: { code: string; detail: string }[];
  reference?: string;
  approver?: string;
  nonce?: string;
  detail?: string;
}

export class AuditLog {
  readonly path: string;
  #ready: Promise<void> | null = null;

  constructor(path: string) {
    this.path = path;
  }

  async #ensureDir(): Promise<void> {
    if (this.#ready === null) {
      this.#ready = mkdir(dirname(this.path), { recursive: true }).then(() => undefined);
    }
    return this.#ready;
  }

  /** Append one entry. Returns the entry as written, including its timestamp. */
  async append(input: AppendInput): Promise<AuditEntry> {
    await this.#ensureDir();
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      ...input,
    };
    await appendFile(this.path, JSON.stringify(entry) + "\n", "utf8");
    return entry;
  }

  /** Read every entry. Malformed lines are surfaced, not skipped: a truncated
   *  audit log is itself an incident and must not be silently absorbed. */
  async readAll(): Promise<AuditEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: AuditEntry[] = [];
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (line === "") continue;
      try {
        out.push(JSON.parse(line) as AuditEntry);
      } catch {
        throw new Error(
          `audit log ${this.path} line ${i + 1} is not valid JSON — the log has been corrupted or hand-edited`,
        );
      }
    }
    return out;
  }

  /** Every nonce that has already been spent on a successful payment. */
  async usedNonces(): Promise<Set<string>> {
    const entries = await this.readAll();
    const used = new Set<string>();
    for (const e of entries) {
      if (e.event === "paid" && e.nonce) used.add(e.nonce);
    }
    return used;
  }
}

/** Nonce store backed by the audit log. */
export class AuditNonceStore {
  #log: AuditLog;
  #cache: Set<string> | null = null;

  constructor(log: AuditLog) {
    this.#log = log;
  }

  async isUsed(nonce: string): Promise<boolean> {
    if (this.#cache === null) this.#cache = await this.#log.usedNonces();
    return this.#cache.has(nonce);
  }

  /** Called after a payment succeeds, so a replay within the same process is
   *  caught without re-reading the file. */
  remember(nonce: string): void {
    this.#cache ??= new Set();
    this.#cache.add(nonce);
  }
}
