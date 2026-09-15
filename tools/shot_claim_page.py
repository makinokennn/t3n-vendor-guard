import pathlib
from playwright.sync_api import sync_playwright

CHROME = "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome"
OUT = pathlib.Path("/root/t3n-vendor-guard/docs/screenshots")
OUT.mkdir(parents=True, exist_ok=True)

URLS = [
    ("10-adk-claim-page", "https://terminal3.io/products/agent-developer-kit"),
]

with sync_playwright() as pw:
    browser = pw.chromium.launch(
        executable_path=CHROME,
        headless=False,
        args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
    )
    ctx = browser.new_context(
        viewport={"width": 1440, "height": 1000},
        device_scale_factor=1,
        user_agent=(
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        ),
        locale="en-US",
    )
    page = ctx.new_page()
    for name, url in URLS:
        try:
            resp = page.goto(url, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(5000)
            title = page.title()
            body = page.inner_text("body")[:400]
            blocked = any(
                k in body.lower()
                for k in ("security checkpoint", "verifying you are human", "just a moment")
            )
            path = OUT / f"{name}.png"
            page.screenshot(path=str(path), full_page=False)
            print(f"{name}: HTTP {resp.status if resp else '?'} | blocked={blocked} | {title!r}")
            print(f"  body[0:200]: {body[:200]!r}")
            print(f"  saved: {path} ({path.stat().st_size/1024:.0f} KB)")
        except Exception as e:
            print(f"{name}: FAILED {type(e).__name__}: {e}")
    browser.close()
