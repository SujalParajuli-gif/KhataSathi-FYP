import Icon from "~/components/ui/Icon";

export type ProfileWorkspaceTab<T extends string> = {
  key: T;
  label: string;
  icon: string;
  description?: string;
};

export default function ProfileWorkspaceNav<T extends string>({
  activeTab,
  tabs,
  onChange,
}: {
  activeTab: T;
  tabs: Array<ProfileWorkspaceTab<T>>;
  onChange: (tab: T) => void;
}) {
  return (
    <nav
      aria-label="Account settings sections"
      className="overflow-x-auto rounded-[10px] border border-slate-200 bg-white p-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <div className="flex min-w-max gap-1 lg:min-w-0 lg:flex-col">
        {tabs.map((tab) => {
          const active = tab.key === activeTab;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => onChange(tab.key)}
              className={[
                "flex min-h-11 items-center gap-3 rounded-[8px] border px-3 py-2.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2",
                active
                  ? "border-[#11120d] bg-[#11120d] text-white"
                  : "border-transparent bg-white text-slate-600 hover:border-slate-200 hover:bg-slate-100 hover:text-black",
              ].join(" ")}
              aria-current={active ? "page" : undefined}
            >
              <Icon name={tab.icon} className="shrink-0 text-[20px]" />
              <span className="min-w-0">
                <span className="block whitespace-nowrap text-[13px] font-extrabold">
                  {tab.label}
                </span>
                {tab.description ? (
                  <span
                    className={[
                      "mt-0.5 hidden text-[11px] font-medium leading-4 lg:block",
                      active ? "text-white/70" : "text-slate-400",
                    ].join(" ")}
                  >
                    {tab.description}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
