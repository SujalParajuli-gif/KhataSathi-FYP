import { useEffect, useState, type ReactNode } from "react";
import { ModalFrame } from "./Modal";
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
  const [modalLoading, setModalLoading] = useState(true);
  const [modalFailed, setModalFailed] = useState(false);
  const [desktopViewport, setDesktopViewport] = useState(false);
  const previewEnabled = enablePreview === true || (enablePreview === "desktop" && desktopViewport);

  useEffect(() => {
    setOpen(false);
    setModalLoading(true);
    setModalFailed(false);
  }, [image.originalUrl, previewUrl]);

  useEffect(() => {
    if (open) {
      setModalLoading(true);
      setModalFailed(false);
    }
  }, [open]);

  useEffect(() => {
    if (enablePreview !== "desktop") return undefined;
    const media = window.matchMedia("(min-width: 1024px)");
    const syncViewport = () => setDesktopViewport(media.matches);
    syncViewport();
    media.addEventListener("change", syncViewport);
    return () => media.removeEventListener("change", syncViewport);
  }, [enablePreview]);



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

      <ModalFrame
        open={open}
        title={`Image preview for ${title || alt}`}
        description={subtitle}
        onClose={() => setOpen(false)}
        maxWidthClass="max-w-[980px]"
        layer="critical"
        headerActions={
          <a
            href={previewUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm font-medium hover:bg-slate-50"
          >
            <Icon name="open_in_new" sizePx={17} />
            Full size
          </a>
        }
      >
        <div className="relative flex max-h-[70dvh] min-h-[260px] w-full items-center justify-center overflow-auto rounded-xl bg-slate-100/60 p-3">
          {modalLoading && !modalFailed ? (
            <div
              className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-slate-100/80 p-6 backdrop-blur-[2px]"
              role="status"
              aria-label="Loading high-resolution image"
            >
              <div className="h-10 w-10 animate-spin rounded-full border-[3px] border-slate-200 border-t-[#11120D]" />
              <p className="animate-pulse text-[12px] font-semibold text-slate-600">Loading high-resolution image…</p>
            </div>
          ) : null}

          {!modalFailed ? (
            <img
              key={previewUrl}
              src={previewUrl}
              alt={alt}
              className={cn(
                "max-h-[65dvh] max-w-full object-contain transition-opacity duration-200",
                modalLoading ? "opacity-0" : "opacity-100",
              )}
              decoding="async"
              onLoad={() => {
                setModalLoading(false);
                setModalFailed(false);
              }}
              onError={() => {
                setModalLoading(false);
                setModalFailed(true);
              }}
            />
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-slate-500">
              <Icon name="broken_image" sizePx={38} className="text-slate-400" />
              <p className="text-[13px] font-semibold text-slate-700">Unable to load full-size image</p>
              <button
                type="button"
                onClick={() => {
                  setModalLoading(true);
                  setModalFailed(false);
                }}
                className="mt-2 inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
              >
                <Icon name="refresh" sizePx={16} />
                Retry
              </button>
            </div>
          )}
        </div>
      </ModalFrame>
    </>
  );
}
