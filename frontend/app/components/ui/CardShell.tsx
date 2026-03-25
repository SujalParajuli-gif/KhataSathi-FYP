export default function CardShell({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-[18px] border-2 border-slate-200 bg-white shadow-sm ${className ?? ""}`}>
      {children}
    </div>
  );
}
