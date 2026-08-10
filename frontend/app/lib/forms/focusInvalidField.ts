import type { RefObject } from "react";

type InvalidField = HTMLElement | null | undefined | RefObject<HTMLElement | null>;

function resolveField(field: InvalidField): HTMLElement | null {
  if (!field) return null;
  return "current" in field ? field.current : field;
}

/** Scrolls an invalid control into view before focusing it. */
export function focusInvalidField(field: InvalidField) {
  const element = resolveField(field);
  if (!element) return;

  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  element.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
  window.setTimeout(() => element.focus({ preventScroll: true }), reduceMotion ? 0 : 180);
}
