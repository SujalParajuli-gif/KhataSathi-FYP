import { useResilientImage } from "~/hooks/useResilientImage";
import Icon from "./Icon";

type Props = {
  src?: string | null;
  alt: string;
  className?: string;
  imgClassName?: string;
  iconSizePx?: number;
  iconClassName?: string;
  loading?: "eager" | "lazy";
  showRetryOnFailure?: boolean;
};

export default function ProductImage({
  src,
  alt,
  className = "",
  imgClassName = "h-full w-full object-contain",
  iconSizePx = 24,
  iconClassName = "text-[#8C8889]",
  loading = "lazy",
  showRetryOnFailure = false,
}: Props) {
  const image = useResilientImage(src);

  return (
    <div className={`relative ${className}`}>
      {image.requestUrl && !image.failed ? (
        <img
          src={image.requestUrl}
          alt={alt}
          className={`${imgClassName} transition-opacity duration-200 ${image.ready ? "opacity-100" : "opacity-0"}`}
          loading={loading}
          decoding="async"
          onLoad={image.markLoaded}
          onError={image.markFailed}
        />
      ) : null}
      {!image.ready ? (
        <div className="absolute inset-0 flex items-center justify-center bg-inherit">
          {image.failed && showRetryOnFailure ? (
            <button
              type="button"
              onClick={image.retryNow}
              className="inline-flex min-h-11 items-center gap-2 rounded-[12px] border border-[#CFCFD3] bg-white px-3 text-[12px] font-extrabold text-[#565449]"
            >
              <Icon name="refresh" sizePx={17} />
              Retry image
            </button>
          ) : (
            <Icon name="inventory_2" sizePx={iconSizePx} className={iconClassName} />
          )}
        </div>
      ) : null}
    </div>
  );
}
