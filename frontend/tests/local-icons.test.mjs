import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const app = fileURLToPath(new URL("../app/", import.meta.url));
const symbols = JSON.parse(readFileSync(path.join(app, "lib/ui/materialSymbols.json"), "utf8"));
function sources(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(folder, entry.name);
    return entry.isDirectory() ? sources(filename) : /\.(tsx|ts|json)$/.test(filename) ? [filename] : [];
  });
}

test("all literal shared icon names are included in the local font registry", () => {
  assert.ok(Object.keys(symbols).length > 4000);
  for (const filename of sources(app)) {
    const source = readFileSync(filename, "utf8");
    for (const match of source.matchAll(/<(?:GIcon|Icon|GoogleIcon)\b[^>]*?\bname=["']([a-z0-9_]+)["']/gs)) {
      assert.ok(symbols[match[1]], `${path.relative(app, filename)}: missing icon ${match[1]}`);
    }
  }
  for (const name of ["archive", "attach_file", "badge", "cloud_upload", "groups", "help_outline", "password", "post_add", "shopping_bag", "table_view"]) assert.ok(symbols[name], name);
});

test("icons use bounded glyphs and the complete font is served locally", () => {
  const helper = readFileSync(path.join(app, "lib/ui/materialSymbol.ts"), "utf8");
  assert.match(helper, /symbols\.help_outline/);
  assert.match(helper, /String\.fromCodePoint/);
  for (const file of ["Icon.tsx", "GIcon.tsx"]) {
    const source = readFileSync(path.join(app, "components/ui", file), "utf8");
    assert.match(source, /materialSymbol\(name\)/);
    assert.doesNotMatch(source, /\{name\}/);
  }
  const font = readFileSync(new URL("../public/assets/fonts/Material_Symbols/MaterialSymbolsRounded.woff2", import.meta.url));
  assert.equal(font.subarray(0, 4).toString(), "wOF2");
  assert.match(readFileSync(path.join(app, "app.css"), "utf8"), /url\("\/assets\/fonts\/Material_Symbols\/MaterialSymbolsRounded\.woff2"\)/);
});
