import Icon from "./Icon";
import type { CapabilityIssue } from "~/lib/capabilityRecovery";

export function ConnectionStatusBanner({
  issue,
  context,
  busy,
  onRetry,
}: {
  issue: CapabilityIssue;
  context: string;
  busy: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-3 py-2 text-amber-950 md:px-5" role="status">
      <div className="mx-auto flex max-w-[1500px] items-center gap-3">
        <Icon name={issue.icon} sizePx={19} className="shrink-0 text-amber-700" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-extrabold leading-4 md:text-[13px]">{issue.title}</div>
          <div className="line-clamp-2 text-[11px] font-semibold leading-4 text-amber-800 md:text-[12px]">
            {context}
          </div>
        </div>
        <button
          type="button"
          onClick={onRetry}
          disabled={busy}
          className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-[11px] border border-amber-300 bg-white px-3 text-[12px] font-extrabold text-amber-950 transition active:scale-95 disabled:opacity-60"
        >
          <Icon name={busy ? "progress_activity" : "refresh"} sizePx={17} className={busy ? "animate-spin" : ""} />
          <span className="hidden sm:inline">{busy ? "Checking" : "Retry"}</span>
        </button>
      </div>
    </div>
  );
}

export function AppStartupState({
  issue,
  busy,
  onRetry,
}: {
  issue?: CapabilityIssue | null;
  busy: boolean;
  onRetry: () => void;
}) {
  if (!issue) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-[#F7F7F5] px-5">
        <div className="flex flex-col items-center text-center">
          <img src="/assets/icons/smalllogo.png" alt="KhataSathi" className="h-14 w-14 rounded-[14px] object-contain" />
          <Icon name="progress_activity" sizePx={27} className="mt-5 animate-spin text-[#565449]" />
          <div className="mt-3 text-[14px] font-extrabold text-[#11120d]">Checking shop access</div>
          <div className="mt-1 text-[12px] font-semibold text-[#64748B]">Connecting securely to KhataSathi…</div>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#F7F7F5] p-5">
      <section className="w-full max-w-[460px] rounded-[22px] border border-[#DADDE3] bg-white p-6 text-center shadow-[0_18px_50px_rgba(15,23,42,0.09)] md:p-8" role="alert">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-amber-50 text-amber-700">
          <Icon name={issue.icon} sizePx={29} />
        </div>
        <h1 className="mt-4 text-[20px] font-extrabold text-[#11120d]">{issue.title}</h1>
        <p className="mx-auto mt-2 max-w-sm text-[13px] font-semibold leading-6 text-[#565449]">{issue.message}</p>
        <button
          type="button"
          onClick={onRetry}
          disabled={busy}
          className="mt-6 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[13px] bg-[#11120d] px-5 text-[13px] font-extrabold text-white transition active:scale-[0.99] disabled:opacity-60"
        >
          <Icon name={busy ? "progress_activity" : "refresh"} sizePx={19} className={busy ? "animate-spin" : ""} />
          {busy ? "Checking connection…" : "Try again"}
        </button>
        <p className="mt-3 text-[11px] font-semibold leading-5 text-[#8C8889]">
          Your shop data has not been changed by this connection problem.
        </p>
      </section>
    </main>
  );
}
