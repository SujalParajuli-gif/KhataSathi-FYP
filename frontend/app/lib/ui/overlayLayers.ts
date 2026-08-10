/**
 * Shared overlay layers. Keep transient feedback above dialogs so a toast can
 * never be hidden by the surface that triggered it.
 */
export const overlayLayers = {
  modal: "z-[100]",
  popover: "z-[240]",
  toast: "z-[300]",
  critical: "z-[320]",
} as const;
