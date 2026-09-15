#!/usr/bin/env python3
"""Render real command output as terminal-styled PNGs for the submission.

Every image is generated from a command actually executed here — no mock-ups.
"""
import html
import pathlib
import subprocess

from playwright.sync_api import sync_playwright

REPO = pathlib.Path("/root/t3n-vendor-guard")
OUT = REPO / "docs" / "screenshots"
OUT.mkdir(parents=True, exist_ok=True)
CHROME = "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome"

# (filename, caption, cwd, command, max_lines)
SHOTS = [
    (
        "01-contract-tests",
        "Policy engine tested on the host target — no enclave, no tenant, no network",
        REPO / "contract",
        "cargo test --target x86_64-unknown-linux-gnu 2>&1 | grep -E 'running|test result|^test '",
        40,
    ),
    (
        "02-agent-typecheck-and-tests",
        "Agent type-checks clean and the gate suite passes",
        REPO / "agent",
        "echo '$ npx tsc --noEmit' && npx tsc --noEmit && echo 'tsc --noEmit: exit 0 (no type errors)' && "
        "echo && echo '$ node --test \"test/**/*.test.ts\"' && "
        "node --test 'test/**/*.test.ts' 2>&1 | grep -E '^(✔|✖|ℹ)' | head -18",
        26,
    ),
    (
        "03-capability-set",
        "The capability set that is actually in the artifact (finding 8 in BUGS.md)",
        REPO / "contract",
        "echo '$ wasm-tools component wit target/wasm32-wasip2/release/vendor_guard.wasm | grep import' && "
        "wasm-tools component wit target/wasm32-wasip2/release/vendor_guard.wasm | grep import && "
        "echo && echo 'host: imports =' $(wasm-tools component wit target/wasm32-wasip2/release/vendor_guard.wasm | grep -c 'import host:') "
        "'  wasi: imports =' $(wasm-tools component wit target/wasm32-wasip2/release/vendor_guard.wasm | grep -c 'import wasi:')",
        26,
    ),
    (
        "04-artifact-hash",
        "The committed component is hash-verifiable without a Rust toolchain",
        REPO / "contract",
        "ls -la target/wasm32-wasip2/release/vendor_guard.wasm && sha256sum target/wasm32-wasip2/release/vendor_guard.wasm",
        10,
    ),
    (
        "05-agent-cli",
        "The agent's surface: four commands, and pay is the only one that moves money",
        REPO / "agent",
        "node src/cli.ts --help",
        24,
    ),
    (
        "06-admin-cli",
        "The tenant owner's tool — a separate binary, deliberately not exposed over MCP",
        REPO / "agent",
        "node src/admin.ts help",
        20,
    ),
    (
        "07-approver-cli",
        "Approval minting is its own binary, so the agent cannot authorise its own payouts",
        REPO / "agent",
        "node src/approver.ts",
        20,
    ),
    (
        "08-bug1-contract-id-types",
        "BUGS.md #1 — the contract id changes type between write and read paths",
        REPO / "agent" / "node_modules" / "@terminal3" / "t3n-sdk" / "dist",
        "echo '--- publish result: contract_id is number ---' && "
        "grep -n -A6 'interface ContractRegisterResult' index.d.ts | grep -E 'contract_id|interface' && "
        "echo && echo '--- the ACL grant consumes it as string ---' && "
        "grep -n -A3 'interface WriterSet' index.d.ts | head -6 && "
        "echo && echo '--- and the read APIs omit it entirely ---' && "
        "grep -n -A12 'interface ListedContract' index.d.ts | grep -E 'interface|:' | head -12",
        30,
    ),
    (
        "09-bug3-env-ignored",
        "BUGS.md #3 — T3N_ENV / T3N_NODE_URL are ignored silently",
        REPO / "agent",
        "cat > /tmp/p_env.mjs <<'EOF'\n"
        "import * as sdk from '@terminal3/t3n-sdk';\n"
        "process.env.T3N_ENV = 'production';\n"
        "process.env.T3N_NODE_URL = 'https://example.invalid';\n"
        "console.log('T3N_ENV=production, T3N_NODE_URL=https://example.invalid');\n"
        "console.log('  getNodeUrl()  ->', sdk.getNodeUrl());\n"
        "console.log('  => the env vars had no effect');\n"
        "EOF\n"
        "node /tmp/p_env.mjs 2>&1 | grep -vE '^const _0x|^\\s+at '",
        14,
    ),
]


def run(cwd, command):
    p = subprocess.run(
        ["bash", "-lc", command],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        timeout=900,
    )
    out = (p.stdout or "") + (p.stderr or "")
    return out.rstrip("\n")


PAGE = """<!doctype html><meta charset="utf-8">
<style>
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; padding: 22px 24px 26px;
    background: #0d1117;
    font-family: "DejaVu Sans Mono", "Liberation Mono", monospace;
    color: #c9d1d9;
  }}
  .cap {{
    font-size: 15px; color: #8b949e; margin: 0 0 4px;
    font-family: "DejaVu Sans", system-ui, sans-serif;
  }}
  .cmd {{ font-size: 14.5px; color: #58a6ff; margin: 0 0 14px; word-break: break-all; }}
  .cmd::before {{ content: "$ "; color: #3fb950; }}
  pre {{ margin: 0; font-size: 14px; line-height: 1.5; white-space: pre-wrap; }}
  .ok {{ color: #3fb950; }}
  .dim {{ color: #6e7681; }}
</style>
<div class="cap">{cap}</div>
<div class="cmd">{cmd_show}</div>
<pre>{body}</pre>
"""


def colourise(text):
    """Minimal, honest highlighting — only lines whose own text says so."""
    lines = []
    for line in text.split("\n"):
        esc = html.escape(line)
        low = line.lower()
        if "test result: ok" in low or "exit 0" in low or line.strip().startswith("# pass"):
            esc = f'<span class="ok">{esc}</span>'
        elif "import wasi:" in low:
            esc = f'<span class="dim">{esc}</span>'
        lines.append(esc)
    return "\n".join(lines)


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": 1180, "height": 700}, device_scale_factor=2)
        for name, caption, cwd, command, max_lines in SHOTS:
            out = run(cwd, command)
            lines = out.split("\n")
            if len(lines) > max_lines:
                lines = lines[:max_lines] + [f"... ({len(out.splitlines()) - max_lines} more lines)"]
            shown = "\n".join(lines)
            # keep the visible command short for the header
            cmd_show = command.split("&&")[0].strip()
            if len(cmd_show) > 150:
                cmd_show = cmd_show[:147] + "..."
            body = colourise(shown)
            page.set_content(
                PAGE.format(cap=html.escape(caption), cmd_show=html.escape(cmd_show), body=body)
            )
            path = OUT / f"{name}.png"
            page.screenshot(path=str(path), full_page=True)
            size = path.stat().st_size
            print(f"{path.name:34} {size/1024:7.1f} KB  {len(lines)} lines")
        browser.close()


if __name__ == "__main__":
    main()
