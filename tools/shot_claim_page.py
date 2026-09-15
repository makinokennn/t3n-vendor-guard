#!/usr/bin/env python3
"""Capture the ADK claim page and the claim form.

Both are real page loads; the form capture opens the modal by clicking the
page's own "Login with Google" control. Nothing here is a mock-up.

The form itself is Google-SSO + work-email gated, so it cannot be submitted
headlessly -- that is the point of the screenshot.
"""
import pathlib

from playwright.sync_api import sync_playwright

CHROME = "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome"
OUT = pathlib.Path("/root/t3n-vendor-guard/docs/screenshots")
URL = "https://terminal3.io/products/agent-developer-kit"


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=CHROME,
            headless=False,  # headful under Xvfb: the checkpoint blocks headless
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
        )
        page = browser.new_page(viewport={"width": 1440, "height": 960}, device_scale_factor=2)
        page.goto(URL, wait_until="domcontentloaded", timeout=90_000)
        page.wait_for_timeout(6000)

        landing = OUT / "15-adk-claim-page.png"
        page.screenshot(path=str(landing), full_page=True)
        print(f"{landing.name:28} {landing.stat().st_size/1024:7.1f} KB")

        # Open the claim form using the page's own control.
        clicked = False
        for name in ["Login with Google", "Claim credits", "Get started", "Claim"]:
            try:
                el = page.get_by_role("button", name=name).first
                if el.count() and el.is_visible():
                    el.click(timeout=5000)
                    clicked = True
                    print(f"  clicked: {name!r}")
                    break
            except Exception:
                continue

        if not clicked:
            # fall back to any element whose text matches
            for sel in ["text=Login with Google", "text=Claim credits"]:
                try:
                    el = page.locator(sel).first
                    if el.count():
                        el.click(timeout=5000)
                        clicked = True
                        print(f"  clicked: {sel!r}")
                        break
                except Exception:
                    continue

        page.wait_for_timeout(5000)
        form = OUT / "16-claim-form-sso.png"
        page.screenshot(path=str(form), full_page=False)
        print(f"{form.name:28} {form.stat().st_size/1024:7.1f} KB  (form opened: {clicked})")
        browser.close()


if __name__ == "__main__":
    main()
