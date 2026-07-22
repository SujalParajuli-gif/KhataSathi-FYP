import { useEffect, useState, type ReactNode } from "react";
import { API_BASE_URL } from "~/lib/api/baseUrl";
import Icon from "./Icon";

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function resolveImageUrl(src?: string | null) {
  if (!src) return "";
  if (
    src.startsWith("blob:") ||
    src.startsWith("http://") ||
    src.startsWith("https://")
  ) {
    return src;
  }
  return `${API_BASE_URL}${src}`;
}

type Props = {
  src?: string | null;
  alt: string;
  title?: string;
  subtitle?: string;
  className?: string;
  imgClassName?: string;
  fallback?: ReactNode;
  previewCue?: "hover" | "always";
  enablePreview?: boolean | "desktop";
};

export default function PreviewableImage({
  src,
  alt,
  title,
  subtitle,
  className = "",
  imgClassName = "h-full w-full object-cover",
  fallback = null,
  previewCue = "hover",
  enablePreview = true,
}: Props) {
  const imageUrl = resolveImageUrl(src);
  const [ready, setReady] = useState(false);
  const [broken, setBroken] = useState(false);
  const [open, setOpen] = useState(false);
  const [desktopViewport, setDesktopViewport] = useState(false);
  const previewEnabled =
    enablePreview === true ||
    (enablePreview === "desktop" && desktopViewport);

  useEffect(() => {
    setReady(false);
    setBroken(false);
    setOpen(false);
  }, [imageUrl]);

  useEffect(() => {
    if (enablePreview !== "desktop") return undefined;
    const media = window.matchMedia("(min-width: 1024px)");
    const syncViewport = () => setDesktopViewport(media.matches);
    syncViewport();
    media.addEventListener("change", syncViewport);
    return () => media.removeEventListener("change", syncViewport);
  }, [enablePreview]);

  useEffect(() => {
    if (!open) return undefined;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!imageUrl || broken) {
    return <div className={className}>{fallback}</div>;
  }

  if (!previewEnabled) {
    return (
      <div className={className}>
        <img
          src={imageUrl}
          alt={alt}
          className={imgClassName}
          onError={() => setBroken(true)}
        />
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        disabled={!ready}
        onClick={() => {
          if (ready) setOpen(true);
        }}
        className={cn(
          "group relative outline-none transition focus-visible:ring-4 focus-visible:ring-slate-200",
          ready ? "cursor-zoom-in" : "cursor-default",
          className,
        )}
        title={ready ? `Preview ${title || alt}` : undefined}
        aria-label={ready ? `Preview ${title || alt}` : alt}
      >
        <img
          src={imageUrl}
          alt={alt}
          className={imgClassName}
          onLoad={() => setReady(true)}
          onError={() => {
            setReady(false);
            setBroken(true);
          }}
        />
        {ready ? (
          <>
            <span className="pointer-events-none absolute inset-0 rounded-[inherit] bg-slate-950/0 transition group-hover:bg-slate-950/10 group-focus-visible:bg-slate-950/10" />
          </>
        ) : null}
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-[140] flex items-center justify-center bg-slate-950/55 p-3 backdrop-blur-[2px] sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label={`Image preview for ${title || alt}`}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div className="flex max-h-[92vh] w-full max-w-[980px] flex-col overflow-hidden rounded-[22px] border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-4 py-4 sm:px-6">
              <div className="min-w-0">
                <div className="truncate text-[18px] font-black text-slate-950 sm:text-[20px]">
                  {title || alt}
                </div>
                {subtitle ? (
                  <div className="mt-1 truncate text-[12px] font-bold text-slate-500">
                    {subtitle}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <a
                  href={imageUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="hidden h-[42px] items-center justify-center gap-2 rounded-[13px] border border-slate-300 bg-white px-3 text-[12px] font-black text-slate-700 transition hover:bg-[#ECEFF3] sm:flex"
                >
                  <Icon name="open_in_new" sizePx={17} />
                  Open full size
                </a>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="flex h-[42px] w-[42px] items-center justify-center rounded-[14px] border border-slate-300 bg-white text-slate-600 transition hover:bg-[#ECEFF3]"
                  aria-label="Close image preview"
                >
                  <Icon name="close" sizePx={24} />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 bg-slate-50 p-3 sm:p-5">
              <div className="flex h-full min-h-[360px] max-h-[70vh] items-center justify-center overflow-hidden rounded-[18px] border border-slate-200 bg-white">
                <img
                  src={imageUrl}
                  alt={alt}
                  className="max-h-full max-w-full object-contain"
                />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
