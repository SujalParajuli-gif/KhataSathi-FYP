import symbols from "./materialSymbols.json";

// Use a bounded glyph instead of exposing a ligature name as text. The registry
// comes from the same complete local font served by app.css.
export function materialSymbol(name: string): string {
  const codepoint = Object.prototype.hasOwnProperty.call(symbols, name)
    ? (symbols as Record<string, number>)[name]
    : symbols.help_outline;
  return String.fromCodePoint(codepoint);
}
