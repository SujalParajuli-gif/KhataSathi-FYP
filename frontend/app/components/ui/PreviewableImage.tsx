import { useEffect, useRef, useState, type ReactNode } from "react";
import { ModalFrame } from "./Modal";
import { resolveMediaUrl, useResilientImage } from "~/hooks/useResilientImage";
import Icon from "./Icon";

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

type ZoomLevel = "fit" | "100" | "200";

type Props = {
  presentation?: "default" | "billing";
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
  enableZoom?: boolean;
  onRetryPreview?: () => void;
};

export default function PreviewableImage({
  presentation = "default",
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
  enableZoom = false,
  onRetryPreview,
}: Props) {
  const image = useResilientImage(src, fallbackSrc);
  const previewUrl = resolveMediaUrl(previewSrc || src);
  const [open, setOpen] = useState(false);
  const [modalLoading, setModalLoading] = useState(true);
  const [modalFailed, setModalFailed] = useState(false);
  const [desktopViewport, setDesktopViewport] = useState(false);
  const [zoomLevel, setZoomLevel] = useState<ZoomLevel>("fit");
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const previewEnabled = enablePreview === true || (enablePreview === "desktop" && desktopViewport);

  useEffect(() => {
    setOpen(false);
    setModalLoading(true);
    setModalFailed(false);
    setZoomLevel("fit");
    setNaturalSize(null);
  }, [image.originalUrl, previewUrl]);

  useEffect(() => {
    if (open) {
      setModalLoading(true);
      setModalFailed(false);
      setZoomLevel("fit");
    }
  }, [open]);

  useEffect(() => {
    if (viewportRef.current) {
      viewportRef.current.scrollLeft = 0;
      viewportRef.current.scrollTop = 0;
    }
  }, [zoomLevel, previewUrl, open]);

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
              <div className="flex h-full w-full items-center justify-center rounded-[inherit] bg-slate-100/70 p-1" aria-label={`Loading image for ${alt}`}>
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-[#11120d]" />
              </div>
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
              <span className="flex h-full w-full items-center justify-center rounded-[inherit] bg-slate-100/70 p-1" aria-label={`Loading image for ${alt}`}>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-[#11120d]" />
              </span>
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

      <ModalFrame presentation={presentation} dialogClassName={presentation==="billing"?"billing-preview-dialog":undefined}
        open={open}
        title={`Image preview for ${title || alt}`}
        description={subtitle}
        onClose={() => setOpen(false)}
        maxWidthClass="max-w-[980px]"
        layer="critical"
      >
        <div className="space-y-3">
          {enableZoom && !modalFailed && !modalLoading ? (
            <div className="flex items-center justify-between border-b border-slate-200/80 pb-2 px-1 text-xs">
              <span className="font-medium text-slate-500">Zoom:</span>
              <div className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5" role="group" aria-label="Image zoom levels">
                <button
                  type="button"
                  aria-pressed={zoomLevel === "fit"}
                  onClick={() => setZoomLevel("fit")}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400",
                    zoomLevel === "fit" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900",
                  )}
                >
                  Fit
                </button>
                <button
                  type="button"
                  aria-pressed={zoomLevel === "100"}
                  onClick={() => setZoomLevel("100")}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400",
                    zoomLevel === "100" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900",
                  )}
                >
                  100%
                </button>
                <button
                  type="button"
                  aria-pressed={zoomLevel === "200"}
                  onClick={() => setZoomLevel("200")}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400",
                    zoomLevel === "200" ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900",
                  )}
                >
                  200%
                </button>
              </div>
            </div>
          ) : null}

          <div
            ref={viewportRef}
            tabIndex={enableZoom ? 0 : undefined}
            role={enableZoom ? "region" : undefined}
            aria-label={enableZoom ? `${title || alt} preview viewport` : undefined}
            className={cn(
              "relative max-h-[70dvh] min-h-[260px] w-full overflow-auto rounded-xl",
              enableZoom
                ? "bg-white p-4 border border-slate-200 shadow-inner touch-pan-x touch-pan-y overscroll-contain focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                : "flex items-center justify-center bg-slate-100/60 p-3",
            )}
          >
            {modalLoading && !modalFailed ? (
              <div
                className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white/90 p-6 backdrop-blur-[2px]"
                role="status"
                aria-label="Loading high-resolution image"
              >
                <div className="h-10 w-10 animate-spin rounded-full border-[3px] border-slate-200 border-t-[#11120D]" />
                <p className="animate-pulse text-[12px] font-semibold text-slate-600">Loading high-resolution image…</p>
              </div>
            ) : null}

            {!modalFailed ? (
              <div
                className={cn(
                  "min-w-full min-h-full",
                  enableZoom
                    ? zoomLevel === "fit"
                      ? "flex items-center justify-center"
                      : "inline-block shrink-0 min-w-min min-h-min"
                    : "flex items-center justify-center",
                )}
              >
                <img
                  key={`${previewUrl}:${attempt}`}
                  src={previewUrl}
                  alt={alt}
                  style={
                    enableZoom
                      ? zoomLevel === "100" && naturalSize
                        ? {
                            width: `${naturalSize.width}px`,
                            height: `${naturalSize.height}px`,
                            minWidth: `${naturalSize.width}px`,
                            minHeight: `${naturalSize.height}px`,
                            maxWidth: "none",
                            maxHeight: "none",
                          }
                        : zoomLevel === "200" && naturalSize
                          ? {
                              width: `${naturalSize.width * 2}px`,
                              height: `${naturalSize.height * 2}px`,
                              minWidth: `${naturalSize.width * 2}px`,
                              minHeight: `${naturalSize.height * 2}px`,
                              maxWidth: "none",
                              maxHeight: "none",
                            }
                          : undefined
                      : undefined
                  }
                  className={cn(
                    "transition-all duration-200",
                    enableZoom
                      ? zoomLevel === "fit"
                        ? "max-h-[60dvh] max-w-full object-contain"
                        : "object-none cursor-grab"
                      : "max-h-[65dvh] max-w-full object-contain",
                    modalLoading ? "opacity-0" : "opacity-100",
                  )}
                  decoding="async"
                  onLoad={(e) => {
                    const img = e.currentTarget;
                    setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
                    setModalLoading(false);
                    setModalFailed(false);
                  }}
                  onError={() => {
                    setModalLoading(false);
                    setModalFailed(true);
                  }}
                />
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center gap-2 p-8 text-center text-slate-500">
                <Icon name="broken_image" sizePx={38} className="text-slate-400" />
                <p className="text-[13px] font-semibold text-slate-700">Unable to load full-size image</p>
                <button
                  type="button"
                  onClick={() => {
                    setAttempt((prev) => prev + 1);
                    setModalLoading(true);
                    setModalFailed(false);
                    onRetryPreview?.();
                  }}
                  className="mt-2 inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                >
                  <Icon name="refresh" sizePx={16} />
                  Retry
                </button>
              </div>
            )}
          </div>
        </div>
      </ModalFrame>
    </>
  );
}
