import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "~/components/ui/Icon";

export default function BillingOverflowMenu({ label, options, selected, onSelect, searchable = false }: {
  label: string;
  options: Array<{ value: string; label: string }>;
  selected?: string;
  onSelect: (value: string) => void;
  searchable?: boolean;
}) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [query, setQuery] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const filtered = options.filter(option => option.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const close = (restore = false) => {
    setPosition(null);
    if (restore) trigger.current?.focus();
  };
  useEffect(() => {
    if (!position) return;
    const frame = requestAnimationFrame(() => (searchable ? search.current : menu.current?.querySelector<HTMLButtonElement>('button'))?.focus());
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    };
    const reposition = () => close();
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', reposition);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', reposition);
    };
  }, [position, searchable]);
  return <>
    <button ref={trigger} type="button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={!!position}
      data-selected={options.some(option => option.value === selected)}
      onClick={() => {
        if (position) { close(); return; }
        setQuery("");
        const rect = trigger.current!.getBoundingClientRect();
        const height = Math.min(options.length * 40 + (searchable ? 64 : 12), 320);
        setPosition({ left: Math.max(8, Math.min(innerWidth - 232, rect.right - 224)), top: rect.bottom + height + 8 > innerHeight ? Math.max(8, rect.top - height - 4) : rect.bottom + 4 });
      }}><Icon name="more_horiz" sizePx={18}/><span>More</span></button>
    {position && createPortal(<div ref={menu} className="billing-overflow-menu" style={position}
      onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) close(); }}
      onKeyDown={event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        const buttons = Array.from(menu.current!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
        if (!buttons.length) return;
        event.preventDefault();
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}>
      {searchable && <label className="billing-overflow-search"><input ref={search} aria-label="Search categories" placeholder="Search categories..." value={query} onChange={event => setQuery(event.target.value)}/></label>}
      <div className="billing-overflow-options" role="menu" aria-label={label}>
        {filtered.map(option => <button type="button" role="menuitemradio" aria-checked={selected === option.value} key={option.value}
          onClick={() => { onSelect(option.value); close(true); }}>{option.label}</button>)}
      </div>
      {!filtered.length && <p className="billing-overflow-empty" role="status">No categories match.</p>}
    </div>, document.body)}
  </>;
}
