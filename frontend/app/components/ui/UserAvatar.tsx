import { useEffect, useState, type ReactNode } from "react";

type Props = {
  src?: string | null;
  alt: string;
  className?: string;
  imgClassName?: string;
  fallback?: ReactNode;
};

export default function UserAvatar({
  src,
  alt,
  className = "",
  imgClassName = "h-full w-full object-cover",
  fallback = null,
}: Props) {
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    setBroken(false);
  }, [src]);

  return (
    <div className={className}>
      {src && !broken ? (
        <img
          src={src}
          alt={alt}
          className={imgClassName}
          onError={() => setBroken(true)}
        />
      ) : (
        fallback
      )}
    </div>
  );
}
