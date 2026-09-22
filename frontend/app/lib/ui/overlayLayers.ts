/**
 * Shared overlay layers. Keep transient feedback above dialogs so a toast can
 * never be hidden by the surface that triggered it.
 */
export const overlayLayers = {
  modal: "z-[100]",
  popover: "z-[240]",
  critical: "z-[320]",
  toast: "z-[350]",
} as const;
