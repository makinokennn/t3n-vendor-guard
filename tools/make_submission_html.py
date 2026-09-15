#!/usr/bin/env python3
"""Render SUBMISSION.md into a single HTML file that pastes cleanly into Google Docs.

Google Docs does not understand markdown tables or code fences: pasting the raw
markdown gives literal pipes and backticks. Pasting *rendered* HTML keeps the
tables, headings and code blocks intact, because Docs maps them onto its own
styles.

    python3 tools/make_submission_html.py
    -> docs/SUBMISSION.html   (open it, select all, copy, paste into a Doc)

The HTML is self-contained: no external CSS, no images fetched over the network.
"""
from __future__ import annotations

import html
import pathlib
import re

REPO = pathlib.Path(__file__).resolve().parent.parent
SRC = REPO / "SUBMISSION.md"
OUT = REPO / "docs" / "SUBMISSION.html"

CSS = """
body { font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
       max-width: 46rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.55;
       color: #1a1a1a; }
h1 { font-size: 1.7rem; border-bottom: 1px solid #ddd; padding-bottom: .3rem; }
h2 { font-size: 1.3rem; margin-top: 1.8rem; }
h3 { font-size: 1.08rem; margin-top: 1.4rem; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: .94rem; }
th, td { border: 1px solid #bbb; padding: .4rem .55rem; text-align: left;
         vertical-align: top; }
th { background: #f2f2f2; }
code { background: #f4f4f4; padding: .1rem .3rem; border-radius: 3px;
       font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: .89em; }
pre { background: #f6f6f6; border: 1px solid #ddd; border-radius: 4px;
      padding: .7rem .8rem; overflow-x: auto; }
pre code { background: none; padding: 0; }
blockquote { border-left: 3px solid #ccc; margin-left: 0; padding-left: .9rem;
             color: #333; }
hr { border: none; border-top: 1px solid #ddd; margin: 1.6rem 0; }
"""


def main() -> int:
    import markdown

    text = SRC.read_text()

    # The header note about pasting is for whoever runs this, not for the Doc.
    text = re.sub(
        r"\AThis file is the submission \*content\*.*?Placeholders[^\n]*\n+",
        "",
        text,
        flags=re.S,
    )

    body = markdown.markdown(
        text,
        extensions=["tables", "fenced_code", "sane_lists", "attr_list"],
    )
    body = body.replace("<table>", '<table border="1" cellpadding="6" cellspacing="0">')

    OUT.write_text(
        "<!doctype html>\n<html><head><meta charset='utf-8'>"
        "<title>vendor-guard submission</title>"
        f"<style>{CSS}</style></head>\n<body>\n{body}\n</body></html>\n"
    )

    tables = body.count("<table")
    pre = body.count("<pre>")
    print(f"wrote {OUT.relative_to(REPO)}  ({OUT.stat().st_size/1024:.1f} KB)")
    print(f"  tables: {tables} | code blocks: {pre} | headings: {body.count('<h')}")
    if "<DOC_URL>" in body:
        print("  note: <DOC_URL> is still a placeholder, fill it before pasting")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
