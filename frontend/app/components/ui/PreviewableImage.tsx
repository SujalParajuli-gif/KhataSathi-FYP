import { useEffect, useState, type ReactNode } from "react";
import { resolveMediaUrl, useResilientImage } from "~/hooks/useResilientImage";
import Icon from "./Icon";

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

type Props = {
  src?: string | null;
  fallbackSrc?: string | null;
  previewSrc?: string | null;
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
  fallbackSrc,
  previewSrc,
  alt,
  title,
  subtitle,
  className = "",
  imgClassName = "h-full w-full object-contain",
  fallback = null,
  previewCue = "hover",
  enablePreview = true,
}: Props) {
  const image = useResilientImage(src, fallbackSrc);
  const previewUrl = resolveMediaUrl(previewSrc || src);
  const [open, setOpen] = useState(false);
  const [desktopViewport, setDesktopViewport] = useState(false);
  const previewEnabled = enablePreview === true || (enablePreview === "desktop" && desktopViewport);

  useEffect(() => setOpen(false), [image.originalUrl, previewUrl]);

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

  if (!image.originalUrl) return <div className={className}>{fallback}</div>;

  const imageElement = (
    <img
      key={image.requestUrl}
      ref={image.imageRef}
      src={image.requestUrl}
      alt={alt}
      className={cn(imgClassName, "transition-opacity duration-200", image.ready ? "opacity-100" : "opacity-0")}
      loading="lazy"
      decoding="async"
      onLoad={image.markLoaded}
      onError={image.markFailed}
    />
  );

  if (!previewEnabled) {
    return (
      <div className={cn("relative", className)}>
        {!image.failed ? imageElement : null}
        {!image.ready ? (
          <div className="absolute inset-0 flex items-center justify-center bg-inherit">
            {image.loading ? (
              <div className="h-full w-full animate-pulse rounded-[inherit] bg-slate-100" aria-label={`Loading image for ${alt}`} />
            ) : fallback}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        disabled={!image.ready}
        onClick={() => image.ready && setOpen(true)}
        className={cn(
          "group relative outline-none transition focus-visible:ring-4 focus-visible:ring-slate-200",
          image.ready ? "cursor-zoom-in" : "cursor-default",
          className,
        )}
        title={image.ready ? `Preview ${title || alt}` : undefined}
        aria-label={image.ready ? `Preview ${title || alt}` : alt}
      >
        {!image.failed ? imageElement : null}
        {!image.ready ? (
          <span className="absolute inset-0 flex items-center justify-center bg-inherit">
            {image.loading ? (
              <span className="h-full w-full animate-pulse rounded-[inherit] bg-slate-100" aria-label={`Loading image for ${alt}`} />
            ) : fallback}
          </span>
        ) : null}
        {image.ready ? (
          <span className={cn(
            "pointer-events-none absolute inset-0 rounded-[inherit] transition",
            previewCue === "always" ? "bg-slate-950/5" : "bg-slate-950/0 group-hover:bg-slate-950/10 group-focus-visible:bg-slate-950/10",
          )} />
        ) : null}
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-[140] flex items-center justify-center bg-slate-950/55 p-2 backdrop-blur-[2px] sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-label={`Image preview for ${title || alt}`}
          onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}
        >
          <div className="flex max-h-[calc(100dvh-16px)] w-full max-w-[980px] flex-col overflow-hidden rounded-[18px] border border-slate-200 bg-white shadow-2xl sm:max-h-[calc(100dvh-48px)] sm:rounded-[22px]">
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-4 py-4 sm:px-6">
              <div className="min-w-0">
                <div className="truncate text-[18px] font-black text-slate-950 sm:text-[20px]">{title || alt}</div>
                {subtitle ? <div className="mt-1 truncate text-[12px] font-bold text-slate-500">{subtitle}</div> : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <a href={previewUrl} target="_blank" rel="noreferrer" className="hidden h-[42px] items-center justify-center gap-2 rounded-[13px] border border-slate-300 bg-white px-3 text-[12px] font-black text-slate-700 transition hover:bg-[#ECEFF3] sm:flex">
                  <Icon name="open_in_new" sizePx={17} />
                  Open full size
                </a>
                <button type="button" onClick={() => setOpen(false)} className="flex h-[42px] w-[42px] items-center justify-center rounded-[14px] border border-slate-300 bg-white text-slate-600 transition hover:bg-[#ECEFF3]" aria-label="Close image preview">
                  <Icon name="close" sizePx={24} />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 bg-slate-50 p-3 sm:p-5">
              <div className="flex h-full min-h-[200px] max-h-[70dvh] items-center justify-center overflow-hidden rounded-[18px] border border-slate-200 bg-white sm:min-h-[360px]">
                <img src={previewUrl} alt={alt} className="max-h-full max-w-full object-contain" decoding="async" />
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
