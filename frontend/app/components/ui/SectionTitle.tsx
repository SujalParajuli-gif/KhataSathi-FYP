// reusable section title — used for table headers and form section labels throughout the app
export default function SectionTitle({ title }: { title: string }) {
  return (
    <div className="text-[13px] font-extrabold text-slate-900 uppercase ">
      {title}
    </div>
  );
}

