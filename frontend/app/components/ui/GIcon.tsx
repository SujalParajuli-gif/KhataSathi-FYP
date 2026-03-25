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
