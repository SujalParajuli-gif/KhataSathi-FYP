// alternative icon component — same as Icon but with lineHeight set to 1 instead of matching the font size
// some older parts of the codebase use this one so we kept it for backwards compatibility
export default function GIcon({ name, sizePx = 24, className }: { name: string; sizePx?: number; className?: string }) {
  return (
    <span
      className={`material-symbols-rounded ${className ?? ""}`}
      style={{ fontSize: `${sizePx}px`, lineHeight: 1 }}
    >
      {name}
    </span>
  );
}

