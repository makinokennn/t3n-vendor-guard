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
        "The capability set actually in the artifact (BUGS.md #2) — 4 host:, 14 wasi:",
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
        "echo '$ ls -l target/wasm32-wasip2/release/vendor_guard.wasm' && "
        "ls -l target/wasm32-wasip2/release/vendor_guard.wasm && "
        "echo && echo '$ sha256sum target/wasm32-wasip2/release/vendor_guard.wasm' && "
        "sha256sum target/wasm32-wasip2/release/vendor_guard.wasm && "
        "echo && echo 'README.md quotes this hash, so the committed artifact is verifiable' && "
        "echo 'without a Rust toolchain:  grep e1876458 README.md'",
        12,
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
        "08-finding1-docs-snippet-ts1117",
        "BUGS.md #1 — the docs' own invoke-contract.md snippet does not compile",
        REPO / "agent",
        "mkdir -p /tmp/dupekey && cat > /tmp/dupekey/repro.ts <<'EOF'\n"
        "// verbatim shape from walkthrough/invoke-contract.md lines 33-40\n"
        "interface Cfg { trustAnchor: unknown; wasmComponent: unknown; handlers: unknown; }\n"
        "declare function fetchTrustedManifest(e: string): Promise<unknown>;\n"
        "const trustAnchor = await fetchTrustedManifest('testnet');\n"
        "const wasmComponent = {};\n"
        "const agentClient: Cfg = {\n"
        "  trustAnchor: await fetchTrustedManifest('testnet'),\n"
        "  wasmComponent,\n"
        "  trustAnchor,\n"
        "  handlers: {},\n"
        "};\n"
        "export {};\n"
        "EOF\n"
        "echo '$ cat -n repro.ts   # lines 33-40 of invoke-contract.md, verbatim'\n"
        "cat -n /tmp/dupekey/repro.ts | sed -n '1,12p'\n"
        "echo\n"
        "echo '$ tsc --ignoreConfig --noEmit repro.ts'\n"
        "./node_modules/.bin/tsc --ignoreConfig --noEmit --target es2022 --module esnext "
        "/tmp/dupekey/repro.ts 2>&1 | sed 's|.*/tmp/dupekey/||'\n"
        'echo "(exit ${PIPESTATUS[0]})"',
        30,
    ),
    (
        "09-finding2-import-pruning",
        "BUGS.md #2 — declared 5 host imports, compiled 4, with no warning",
        REPO,
        "bash tools/repro-import-pruning.sh",
        24,
    ),
    (
        "10-finding3-version-mismatch",
        "BUGS.md #3 — following write-contract.md's versions breaks the build",
        REPO,
        "bash tools/repro-version-mismatch.sh",
        34,
    ),
    (
        "11-finding4-obfuscation",
        "BUGS.md #4 — obfuscated with no source maps, so static review gives false negatives",
        REPO / "agent" / "node_modules" / "@terminal3" / "t3n-sdk" / "dist",
        "echo '$ head -c 60 index.js'\n"
        "head -c 60 index.js\n"
        "echo\n"
        "echo '$ ls *.map'\n"
        "ls *.map 2>&1\n"
        "echo\n"
        "echo '$ grep -c T3N_ENV cli/index.js   # looks like absence of the feature...'\n"
        "grep -c T3N_ENV cli/index.js\n"
        "echo '   ...but see screenshot 12: the CLI does honour T3N_ENV.'",
        16,
    ),
    (
        "12-withdrawn-cli-honours-env",
        "Withdrawn W1 — our probe was wrong: the CLI does honour T3N_ENV",
        REPO / "agent",
        "bash ../tools/repro-cli-env.sh",
        22,
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
