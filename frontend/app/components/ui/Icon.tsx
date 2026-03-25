type Props = {
  name: string;
  sizePx?: number;
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
