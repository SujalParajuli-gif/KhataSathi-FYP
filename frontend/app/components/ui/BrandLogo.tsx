import navData from "~/config/ui.nav.json";

type Props = {
  variant?: "full" | "icon"; // "full" shows the full logo, "icon" shows just the icon portion
  className?: string;
  imageClassName?: string;
  alt?: string;
};

// the path to our brand logo image in the public assets folder
const BRAND_LOGO_SRC = "/assets/icons/khatashati%20logo.png";

// helper to join CSS class names — filters out falsy values
function joinClasses(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

// brand logo component — used in the sidebar header and login page
// in "full" mode it shows the entire logo, in "icon" mode it crops to just the icon
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

