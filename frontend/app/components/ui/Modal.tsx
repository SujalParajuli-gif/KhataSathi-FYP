import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Icon from "~/components/ui/Icon";
import { useBodyScrollLock } from "~/hooks/useBodyScrollLock";
import { overlayLayers } from "~/lib/ui/overlayLayers";

// helper to join CSS class names — filters out falsy values like false, null, undefined
function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

// --

type ModalFrameProps = {
  open: boolean;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  headerActions?: ReactNode;
  maxWidthClass?: string;
  compact?: boolean;
  mobileFullScreen?: boolean;
  mobileBottomSheet?: boolean;
  layer?: "modal" | "critical";
};

// the base modal frame — provides the overlay, centered positioning, header with title, and close button
// all other dialog components (ConfirmDialog, SuccessDialog, StatusDialog) build on top of this
export function ModalFrame({
  open,
  title,
  description,
  children,
  footer,
  onClose,
  headerActions,
  maxWidthClass = "max-w-[560px]",
  compact = false,
  mobileFullScreen = false,
  mobileBottomSheet = false,
  layer = "modal",
}: ModalFrameProps) {
  useBodyScrollLock(open);
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return undefined;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusableSelector = [
      "[data-modal-initial-focus]",
      "button:not([disabled])",
      "input:not([disabled]):not([type='hidden'])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "a[href]",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");

    function isTopDialog() {
      const dialogs = document.querySelectorAll<HTMLElement>(
        "[data-modal-frame='true'][aria-modal='true']",
      );
      return dialogs[dialogs.length - 1] === dialogRef.current;
    }

    function handleDialogKeys(event: KeyboardEvent) {
      if (!isTopDialog()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;

      const controls = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector),
      ).filter((element) => element.offsetParent !== null);
      if (controls.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    const animationFrame = window.requestAnimationFrame(() => {
      const initialControl =
        dialogRef.current?.querySelector<HTMLElement>("[data-modal-initial-focus]") ||
        dialogRef.current?.querySelector<HTMLElement>(focusableSelector);
      (initialControl || dialogRef.current)?.focus();
    });
    window.addEventListener("keydown", handleDialogKeys);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("keydown", handleDialogKeys);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className={`fixed inset-0 ${overlayLayers[layer]}`}>
      {/* semi-transparent backdrop — clicking it closes the modal */}
      <button
        type="button"
        aria-label="Close dialog overlay"
        onClick={onClose}
        className="absolute inset-0 bg-slate-950/45 backdrop-blur-sm"
      />

      <div className={cn(
        "absolute inset-0 flex justify-center",
        mobileFullScreen || mobileBottomSheet
          ? "items-end p-0 lg:items-center lg:p-4"
          : "items-center p-2 sm:p-4",
      )}>
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          data-modal-frame="true"
          tabIndex={-1}
          className={cn(
            "relative flex max-h-[calc(100dvh-16px)] w-full flex-col overflow-hidden border border-[#CFCFD3] bg-[#FFFFFF] sm:max-h-[calc(100dvh-32px)]",
            mobileFullScreen
              ? "flex h-dvh max-h-dvh flex-col rounded-none border-0 lg:h-auto lg:max-h-[calc(100vh-32px)] lg:rounded-[24px] lg:border"
              : mobileBottomSheet
                ? "flex max-h-[88dvh] flex-col rounded-t-[26px] border-x-0 border-b-0 lg:max-h-[calc(100vh-32px)] lg:rounded-[24px] lg:border"
              : compact ? "rounded-[18px]" : "rounded-[20px] sm:rounded-[24px]",
            maxWidthClass,
          )}
        >
          {mobileBottomSheet ? (
            <div
              aria-hidden="true"
              className="absolute left-1/2 top-2 z-10 h-1 w-11 -translate-x-1/2 rounded-full bg-slate-300 lg:hidden"
            />
          ) : null}
          {/* modal header with title, optional description, and close button */}
          <div
            className={cn(
              "flex items-start justify-between gap-4 border-b border-[#CFCFD3]",
              compact ? "px-[16px] py-[14px] sm:px-[18px]" : "px-[16px] py-[16px] sm:px-[24px] sm:py-[20px]",
              mobileBottomSheet && "pt-[22px]",
            )}
          >
            <div className="min-w-0">
              <div
                id={titleId}
                className={cn(
                  "font-extrabold text-[#000000]",
                  compact ? "text-[16px]" : "text-[18px]",
                )}
              >
                {title}
              </div>
              {description ? (
                <div
                  id={descriptionId}
                  className={cn(
                    "mt-[3px] font-medium text-[#8C8889]",
                    compact
                      ? "text-[12px] leading-[18px]"
                      : "text-[13px] leading-[24px]",
                  )}
                >
                  {description}
                </div>
              ) : null}
            </div>

            <div className="flex items-center gap-3">
              {headerActions}
              <button
                type="button"
                onClick={onClose}
                className={cn(
                  "inline-flex shrink-0 items-center justify-center border border-[#CFCFD3] bg-[#FFFFFF] text-[#8C8889] transition hover:bg-[#F3F4F6] hover:text-[#000000]",
                  compact ? "h-10 w-10 rounded-[12px]" : "h-11 w-11 rounded-[14px]",
                )}
                aria-label="Close dialog"
              >
                <Icon name="close" />
              </button>
            </div>
          </div>

          {/* modal body content */}
          <div className={cn(
            compact ? "px-[18px] py-[14px]" : "px-[16px] py-[14px] lg:px-[24px] lg:py-[20px]",
            "min-h-0 flex-1 overflow-y-auto overscroll-contain",
          )}>
            {children}
          </div>

          {/* optional footer — typically contains action buttons */}
          {footer ? (
            <div className="flex shrink-0 items-center justify-end gap-3 border-t border-[#CFCFD3] bg-[rgba(243,244,246,0.85)] px-[16px] pb-[max(16px,env(safe-area-inset-bottom))] pt-[16px] lg:px-[24px] lg:py-[16px]">
              {footer}
            </div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// --

type DialogButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "danger";
  icon?: string;
  disabled?: boolean;
};

// reusable button used inside dialogs — supports primary (dark), secondary (outline), and danger (red) variants
export function DialogButton({
  children,
  onClick,
  variant = "secondary",
  icon,
  disabled,
}: DialogButtonProps) {
  // choosing the color scheme based on the variant
  const toneClass =
    variant === "primary"
      ? "border-[#11120d] bg-[#11120d] text-white hover:border-[#2a2c27] hover:bg-[#2a2c27]"
      : variant === "danger"
        ? "border-[#FECDD3] bg-[#FFF1F2] text-[#BE123C] hover:border-rose-300 hover:bg-rose-100"
        : "border-[#CFCFD3] bg-[#FFFFFF] text-[#565449] hover:bg-[#F3F4F6]";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex min-h-11 items-center justify-center gap-2 rounded-[14px] border px-4 py-2.5 text-[13px] font-extrabold transition active:scale-[0.98]",
        toneClass,
        disabled && "pointer-events-none opacity-50",
      )}
    >
      {icon ? <Icon name={icon} className="text-inherit" /> : null}
      {children}
    </button>
  );
}

// --

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
  tone?: "danger" | "primary";
  icon?: string;
  details?: ReactNode;
  busy?: boolean;
};

// confirmation dialog — used for destructive actions like cancelling invoices, deactivating products, etc.
// shows a warning icon, the message, and confirm/cancel buttons
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  onClose,
  tone = "danger",
  icon = tone === "danger" ? "warning" : "help",
  details,
  busy,
}: ConfirmDialogProps) {
  const iconTone =
    tone === "danger"
      ? "border-[#FECDD3] bg-[#FFF1F2] text-[#BE123C]"
      : "border-[#F6D28B] bg-[#FFF7E8] text-[#B7791F]";

  return (
    <ModalFrame
      open={open}
      onClose={onClose}
      title={title}
      mobileBottomSheet
      footer={(
        <div className="grid w-full grid-cols-2 gap-3">
          <DialogButton onClick={onClose}>{cancelLabel}</DialogButton>
          <DialogButton
            onClick={onConfirm}
            variant={tone === "danger" ? "danger" : "primary"}
            icon={tone === "danger" ? "block" : "check_circle"}
            disabled={busy}
          >
            {busy ? "Please wait..." : confirmLabel}
          </DialogButton>
        </div>
      )}
    >
      <div className="space-y-5">
        <div className="flex items-start gap-4">
          <div
            className={cn(
              "inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-[18px] border",
              iconTone,
            )}
          >
            <Icon name={icon} sizePx={28} className="text-inherit" />
          </div>

          <div className="pt-[4px] text-[14px] font-medium leading-[28px] text-[#565449]">
            {message}
          </div>
        </div>

        {/* optional details section — used to show additional context before confirming */}
        {details ? (
          <div className="rounded-[18px] border border-[#CFCFD3] bg-[rgba(243,244,246,0.9)] p-[16px] text-[13px] text-[#565449]">
            {details}
          </div>
        ) : null}
      </div>

    </ModalFrame>
  );
}

// --

type SuccessDialogProps = {
  open: boolean;
  title: string;
  message: string;
  onClose: () => void;
  actionLabel?: string;
  secondaryAction?: ReactNode;
};

// success dialog — shown after a successful operation like invoice finalization or payment confirmation
export function SuccessDialog({
  open,
  title,
  message,
  onClose,
  actionLabel = "Done",
  secondaryAction,
}: SuccessDialogProps) {
  return (
    <ModalFrame
      open={open}
      onClose={onClose}
      title={title}
      mobileBottomSheet
      footer={(
        <div className="flex w-full items-center justify-end gap-3">
          {secondaryAction}
          <DialogButton onClick={onClose} variant="primary" icon="check_circle">
            {actionLabel}
          </DialogButton>
        </div>
      )}
    >
      <div className="space-y-5">
        <div className="flex items-start gap-4">
          <div className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-[18px] border border-emerald-200 bg-emerald-50 text-emerald-600">
            <Icon name="check_circle" sizePx={30} className="text-inherit" />
          </div>

          <div className="pt-[4px] text-[14px] font-medium leading-[28px] text-[#565449]">
            {message}
          </div>
        </div>
      </div>

    </ModalFrame>
  );
}

// --

type StatusDialogProps = {
  open: boolean;
  title: string;
  message: string;
  onClose: () => void;
  actionLabel?: string;
  tone?: "success" | "error";
};

// generic status dialog — can show either a success (green) or error (red) status
// used for showing the result of operations like eSewa payment verification
export function StatusDialog({
  open,
  title,
  message,
  onClose,
  actionLabel = "Continue",
  tone = "success",
}: StatusDialogProps) {
  const panelTone =
    tone === "error"
      ? "border-rose-200 bg-rose-50 text-rose-600"
      : "border-emerald-200 bg-emerald-50 text-emerald-600";
  const actionTone = tone === "error" ? "danger" : "primary";
  const iconName = tone === "error" ? "error" : "check_circle";

  return (
    <ModalFrame
      open={open}
      onClose={onClose}
      title={title}
      mobileBottomSheet
      footer={(
        <DialogButton onClick={onClose} variant={actionTone} icon={iconName}>
          {actionLabel}
        </DialogButton>
      )}
    >
      <div className="space-y-5">
        <div className="flex items-start gap-4">
          <div
            className={cn(
              "inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-[18px] border",
              panelTone,
            )}
          >
            <Icon name={iconName} sizePx={30} className="text-inherit" />
          </div>

          <div className="pt-[4px] text-[14px] font-medium leading-[28px] text-[#565449]">
            {message}
          </div>
        </div>
      </div>

    </ModalFrame>
  );
}
