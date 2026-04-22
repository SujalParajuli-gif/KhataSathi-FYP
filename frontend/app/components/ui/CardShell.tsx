// reusable card wrapper — gives a consistent white card with rounded corners and a subtle border
// we use this for wrapping sections on the dashboard, settings, and other pages
export default function CardShell({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-[20px] border border-[#CFCFD3] bg-[#FFFFFF]  ${className ?? ""}`}>
      {children}
    </div>
  );
}

