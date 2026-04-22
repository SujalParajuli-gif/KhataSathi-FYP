// reusable icon component that renders a Google Material Symbols Rounded icon
// we use this everywhere in the app instead of importing icon SVGs individually
type Props = {
  name: string; // the Material Symbols icon name (e.g., "close", "check_circle")
  sizePx?: number; // icon size in pixels — defaults to 20px
  className?: string;
};

export default function Icon({
  name,
  sizePx = 20,
  className = "",
}: Props) {
  return (
    <span
      className={`material-symbols-rounded ${className}`}
      style={{ fontSize: `${sizePx}px`, lineHeight: `${sizePx}px` }}
      aria-hidden="true"
    >
      {name}
    </span>
  );
}

