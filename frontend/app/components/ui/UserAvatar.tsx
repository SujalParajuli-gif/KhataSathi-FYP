import { useEffect, useState, type ReactNode } from "react";

type Props = {
  src?: string | null;
  alt: string;
  className?: string;
  imgClassName?: string;
  fallback?: ReactNode; // what to show when the image is missing or fails to load
};

// user avatar component — shows the user's profile image or a fallback (like a person icon)
// we track whether the image failed to load using the "broken" state
// if the src changes (e.g., user uploads a new photo), we reset the broken state to try loading again
export default function UserAvatar({
  src,
  alt,
  className = "",
  imgClassName = "h-full w-full object-cover",
  fallback = null,
}: Props) {
  const [broken, setBroken] = useState(false);

  // resetting the broken state whenever the source URL changes
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
          onError={() => setBroken(true)} // if the image fails to load, show the fallback instead
        />
      ) : (
        fallback
      )}
    </div>
  );
}
