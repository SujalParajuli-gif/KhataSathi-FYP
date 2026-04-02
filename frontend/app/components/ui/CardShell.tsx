export default function CardShell({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-[20px] border border-[#CFCFD3] bg-[#FFFFFF]  ${className ?? ""}`}>
      {children}
    </div>
  );
}

