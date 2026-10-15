import { test, expect } from "@playwright/test";

for (const injectExtensionAttribute of [false, true]) {
  test(`root hydration with extension attribute: ${injectExtensionAttribute}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    page.on("pageerror", error => errors.push(error.message));
    if (injectExtensionAttribute) {
      await page.addInitScript(() => {
        const apply = () => document.documentElement?.setAttribute("data-lt-installed", "true");
        if (document.documentElement) apply();
        else {
          const observer = new MutationObserver(() => { if (document.documentElement) { apply(); observer.disconnect(); } });
          observer.observe(document, { childList: true });
        }
      });
    }
    await page.goto("/login");
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
    if (injectExtensionAttribute) await expect(page.locator("html")).toHaveAttribute("data-lt-installed", "true");
    expect(errors.filter(message => /hydrat|didn't match|did not match/i.test(message))).toEqual([]);
    await expect(page.locator('meta[name="mobile-web-app-capable"]')).toHaveAttribute("content", "yes");
  });
}

test("descendant hydration mismatches still produce diagnostics", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      if (!document.body) return;
      document.body.setAttribute("data-test-mismatch", "true");
      observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  await page.goto("/login");
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
  expect(errors.some(message => /hydrat/i.test(message) && message.includes("data-test-mismatch"))).toBe(true);
});
