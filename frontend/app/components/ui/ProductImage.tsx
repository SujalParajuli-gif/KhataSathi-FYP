import { useEffect, useState } from "react";
import { API_BASE_URL } from "~/lib/api/baseUrl";
import Icon from "./Icon";

type Props = {
  src?: string | null;
  alt: string;
  className?: string;
  imgClassName?: string;
  iconSizePx?: number;
  iconClassName?: string;
};

// resolving the image URL — if it is a relative path (like "/uploads/products/abc.jpg"),
// we prepend the API base URL so the browser can fetch it from the backend's static file server
function resolveImageUrl(src?: string | null) {
  if (!src) return "";
  if (
    src.startsWith("blob:") ||
    src.startsWith("http://") ||
    src.startsWith("https://")
  ) {
    return src; // already a full URL, no need to prepend
  }
  return `${API_BASE_URL}${src}`;
}

// product image component — shows the product's image or a placeholder icon if no image exists
// works the same way as UserAvatar — tracks broken state and resets when the source changes
export default function ProductImage({
  src,
  alt,
  className = "",
  imgClassName = "h-full w-full object-cover",
  iconSizePx = 24,
  iconClassName = "text-[#8C8889]",
}: Props) {
  const imageUrl = resolveImageUrl(src);
  const [broken, setBroken] = useState(false);

  // resetting broken state when the image URL changes (e.g., after uploading a new image)
  useEffect(() => {
    setBroken(false);
  }, [imageUrl]);

  return (
    <div className={className}>
      {imageUrl && !broken ? (
        <img
          src={imageUrl}
          alt={alt}
          className={imgClassName}
          onError={() => setBroken(true)} // falling back to the icon if the image fails to load
        />
      ) : (
        <Icon name="inventory_2" sizePx={iconSizePx} className={iconClassName} />
      )}
    </div>
  );
}
