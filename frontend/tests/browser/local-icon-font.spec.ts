import { expect, test } from "@playwright/test";

// Keep the requested icon inventory explicit so font updates cannot silently drop a name.
// package_search is unsupported by both the original full font and this subset.
const knownIcons = [
  "inventory_2", "inventory", "assignment_return", "payments", "settings", "error", "receipt_long",
  "image", "picture_as_pdf", "upload_file", "loyalty", "description",
  "block", "check_circle", "sell", "sync_alt",
  "search", "person",
  "home", "point_of_sale", "folder_open", "delete", "analytics", "percent", "history", "notifications", "pending_actions",
  "table_chart", "progress_activity", "warning", "sync", "arrow_forward",
  "wifi_off", "lock_clock", "lock", "hourglass_top", "schedule", "cloud_off", "sync_problem",
  "info", "qr_code_2", "account_balance", "call_split",
  "pause_circle", "priority_high", "bar_chart",
  "task_alt", "check", "close", "chevron_right", "chevron_left", "refresh",
  "account_balance_wallet", "add", "add_shopping_cart", "admin_panel_settings", "arrow_back", "arrow_downward", "arrow_drop_down", "arrow_upward", "assignment_turned_in", "barcode_scanner", "bookmark_add", "broken_image", "calculate", "calendar_month", "call", "cancel", "category", "center_focus_strong", "checklist", "cloud_download", "crop_square", "database", "date_range", "delete_forever", "delete_sweep", "deployed_code", "do_not_disturb_on", "done_all", "download", "edit", "edit_note", "edit_square", "encrypted", "event_busy", "expand_less", "expand_more", "fact_check", "filter_alt", "filter_none", "forward_to_inbox", "fullscreen", "group", "hourglass_empty", "inbox", "key", "keyboard", "keyboard_double_arrow_left", "keyboard_double_arrow_right", "layers", "link", "list", "list_alt", "local_parking", "location_on", "login", "logout", "mail", "mark_email_unread", "menu", "menu_open", "monitoring", "more_horiz", "more_vert", "move_to_inbox", "north_east", "notifications_off", "open_in_full", "open_in_new", "package_search", "payment", "pending",
  "add_a_photo", "add_circle", "check_box", "check_box_outline_blank", "deselect", "error_outline", "filter_alt_off", "person_add", "phone", "photo_camera", "playlist_add", "policy", "print", "publish", "published_with_changes", "receipt", "redo", "remove", "remove_circle_outline", "restart_alt", "restore", "rule", "save", "search_off", "select_all", "send", "shield", "shopping_cart", "shopping_cart_checkout", "south_west", "star", "storage", "storefront", "swap_horiz", "swap_vert", "toggle_on", "trending_up", "tune", "undo", "upload", "verified", "verified_user", "visibility", "visibility_off", "zoom_in", "zoom_out"
].filter((name) => name !== "package_search").sort();

for (const width of [390, 1440]) {
  test(`Material Symbols subset renders locally at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const externalFontRequests: string[] = [];
    page.on("request", (request) => {
      if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(request.url())) {
        externalFontRequests.push(request.url());
      }
    });
    await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort());

    // Login uses the same global stylesheet as the authenticated routes.
    const fontResponse = page.waitForResponse((response) =>
      response.url().endsWith("/assets/fonts/Material_Symbols/MaterialSymbolsRounded.woff2"),
    );
    await page.goto("/login");
    expect((await fontResponse).ok()).toBe(true);

    expect(externalFontRequests).toEqual([]);

    expect(knownIcons).toHaveLength(168);
    expect(new Set(knownIcons).size).toBe(knownIcons.length);

    // Exercise the supported ligatures at normal, bold, and filled settings.
    await page.evaluate(async (icons) => {
      const container = document.createElement("div");
      container.style.position = "absolute";
      container.style.top = "0";
      container.style.left = "0";
      for (const name of icons) {
        for (const [variant, fill, weight] of [["normal", 0, 400], ["bold", 0, 700], ["filled", 1, 400]] as const) {
          const span = document.createElement("span");
          span.className = `material-symbols-rounded test-${variant}`;
          span.style.fontVariationSettings = `'FILL' ${fill}, 'wght' ${weight}, 'GRAD' 0, 'opsz' 24`;
          span.textContent = name;
          container.appendChild(span);
        }
      }
      document.body.appendChild(container);
      await document.fonts.ready;
    }, knownIcons);

    const result = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll<HTMLElement>(".material-symbols-rounded.test-normal, .material-symbols-rounded.test-bold, .material-symbols-rounded.test-filled"));
      return {
        count: spans.length,
        failures: spans.filter((span) => span.getBoundingClientRect().width > 28)
          .map((span) => `${span.textContent} (${span.className})`),
      };
    });

    expect(result.count).toBe(knownIcons.length * 3);
    expect(result.failures).toEqual([]);
  });
}
