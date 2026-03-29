export default function CardShell({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-[20px] border border-[var(--app-border)] bg-white shadow-[0_18px_45px_-38px_rgba(17,18,13,0.45)] ${className ?? ""}`}>
      {children}
    </div>
  );
}
