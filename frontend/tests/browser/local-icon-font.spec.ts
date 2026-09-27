import { expect, test } from "@playwright/test";

for (const width of [390, 1440]) {
  test(`Material Symbols load locally at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const externalFontRequests: string[] = [];
    page.on("request", (request) => {
      if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(request.url())) {
        externalFontRequests.push(request.url());
      }
    });
    await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort());

    const fontResponse = page.waitForResponse((response) =>
      response.url().endsWith("/assets/fonts/Material_Symbols/MaterialSymbolsRounded.woff2"),
    );
    await page.goto("/login");
    expect((await fontResponse).ok()).toBe(true);

    const personIcon = page.locator(".material-symbols-rounded:visible", { hasText: "person" }).first();
    await expect(personIcon).toBeVisible();
    await expect.poll(() => personIcon.evaluate((element) => {
      const style = getComputedStyle(element);
      return document.fonts.check(`20px ${style.fontFamily}`, "person") &&
        element.getBoundingClientRect().width <= 32;
    })).toBe(true);
    expect(externalFontRequests).toEqual([]);
  });
}
