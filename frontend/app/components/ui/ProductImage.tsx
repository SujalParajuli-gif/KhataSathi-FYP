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
          onError={() => setBroken(true)}
        />
      ) : (
        <Icon name="inventory_2" sizePx={iconSizePx} className={iconClassName} />
      )}
    </div>
  );
}
