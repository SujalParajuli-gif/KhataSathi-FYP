import GoogleIcon from "~/components/ui/GoogleIcon";
import navData from "~/config/ui.nav.json";

type Props = {
  pageTitle: string;
  greetingText?: string;
  onOpenMobileSidebar: () => void;
  onToggleCollapse: () => void;
  isCollapsed: boolean;
  userName?: string;
  roleLabel?: string;
};

export default function Topbar({
  pageTitle,
  greetingText = "Hi Admin, Good Morning!",
  onOpenMobileSidebar,
  onToggleCollapse,
  isCollapsed,
  userName = "Admin User",
  roleLabel = "Admin",
}: Props) {
  return (
    <header className="sticky top-0 z-30 bg-white/80 backdrop-blur-md border-b border-slate-200/60">
      <div className="px-5 py-3">
        <div className="flex items-center justify-between gap-4">
          {/* LEFT: Page Info & Toggles */}
          <div className="flex items-center gap-4 min-w-0">
            <div className="flex items-center gap-3">
              {/* Mobile Menu Toggle */}
              <button
                type="button"
                onClick={onOpenMobileSidebar}
                className="lg:hidden flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-sm transition-all hover:bg-slate-50 active:scale-95"
                aria-label="Open sidebar"
              >
                <GoogleIcon name="menu" />
              </button>

              {/* Desktop Collapse Toggle */}
              <button
                type="button"
                onClick={onToggleCollapse}
                className="hidden lg:flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-sm transition-all hover:bg-slate-50 active:scale-95"
                aria-label="Toggle sidebar collapse"
              >
                <GoogleIcon name={isCollapsed ? "menu" : "menu_open"} />
              </button>

              <div className="min-w-0">
                <h1 className="text-[16px] font-bold text-slate-900 truncate tracking-tight">
                  {pageTitle}
                </h1>
                <p className="text-[12px] font-medium text-slate-500 truncate opacity-80">
                  {greetingText}
                </p>
              </div>
            </div>
          </div>

          {/* RIGHT: Search, Notifications, User */}
          <div className="flex items-center gap-3">
            {/* Desktop Search Bar */}
            <div className="hidden md:flex items-center gap-3 rounded-full border border-slate-200 bg-slate-50/50 px-4 py-2 w-[400px] xl:w-[500px] transition-all focus-within:border-orange-500/50 focus-within:bg-white focus-within:ring-4 focus-within:ring-orange-500/10 group">
              <GoogleIcon
                name="search"
                className="text-slate-400 group-focus-within:text-orange-500 transition-colors"
              />
              <input
                className="w-full bg-transparent text-sm font-medium outline-none placeholder:text-slate-400 text-slate-700"
                placeholder={navData.topbar.searchPlaceholder}
              />
              <div className="hidden lg:block"></div>
            </div>

            {/* Notification Bell */}
            <button
              type="button"
              className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-sm transition-all hover:bg-slate-50 active:scale-95"
              aria-label="Notifications"
            >
              <GoogleIcon name="notifications" />

              {/* Static Dot - Visible only on alert/error */}
              {/* we will wrap this in our logic: {hasAlert && (...)} */}
              <span className="absolute top-[10px] right-[10px] h-2.5 w-2.5 rounded-full bg-rose-500 border-2 border-white shadow-sm" />
            </button>

            {/* User Profile Menu */}
            <button
              type="button"
              className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-1.5 pr-3 shadow-sm transition-all hover:border-slate-300 hover:bg-slate-50 active:scale-[0.98]"
              aria-label="User menu"
            >
              <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-orange-100 to-orange-200 flex items-center justify-center border border-orange-200/50 shadow-inner">
                <GoogleIcon name="person" className="text-orange-700" />
              </div>
              <div className="text-left leading-tight hidden sm:block">
                <div className="text-[13px] font-bold text-slate-900 whitespace-nowrap">
                  {userName}
                </div>
                <div className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider">
                  {roleLabel}
                </div>
              </div>
            </button>
          </div>
        </div>

        {/* Mobile Search Row */}
        <div className="mt-3 md:hidden">
          <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50/50 px-4 py-2.5">
            <GoogleIcon name="search" className="text-slate-400" />
            <input
              className="w-full bg-transparent text-sm font-medium outline-none placeholder:text-slate-400 text-slate-700"
              placeholder={navData.topbar.searchPlaceholder}
            />
          </div>
        </div>
      </div>
    </header>
  );
}
