import navData from "~/config/ui.nav.json";

type Props = {
  variant?: "full" | "icon";
  className?: string;
  imageClassName?: string;
  alt?: string;
};

const BRAND_LOGO_SRC = "/assets/icons/khatashati%20logo.png";

function joinClasses(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export default function BrandLogo({
  variant = "full",
  className,
  imageClassName,
  alt,
}: Props) {
  return (
    <div
      className={joinClasses(
        "shrink-0 overflow-hidden",
        variant === "icon" && "rounded-[14px]",
        className,
      )}
    >
      <img
        src={BRAND_LOGO_SRC}
        alt={alt || `${navData.brand.name} logo`}
        className={joinClasses(
          "block h-full w-full",
          variant === "icon" ? "object-cover object-left" : "object-contain object-left",
          imageClassName,
        )}
      />
    </div>
  );
}
