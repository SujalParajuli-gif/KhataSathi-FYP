import type { ReactNode } from "react";
import Icon from "~/components/ui/Icon";

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

type ModalFrameProps = {
  open: boolean;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  maxWidthClass?: string;
};

export function ModalFrame({
  open,
  title,
  description,
  children,
  footer,
  onClose,
  maxWidthClass = "max-w-[560px]",
}: ModalFrameProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90]">
      <button
        type="button"
        aria-label="Close dialog overlay"
        onClick={onClose}
        className="absolute inset-0 bg-slate-950/45 backdrop-blur-sm"
      />

      <div className="absolute inset-0 flex items-center justify-center p-4">
        <div
          className={cn(
            "relative w-full overflow-hidden rounded-[24px] border border-[var(--app-border)] bg-white shadow-[0_30px_90px_-45px_rgba(17,18,13,0.65)]",
            maxWidthClass,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-[var(--app-border)] px-6 py-5">
            <div className="min-w-0">
              <div className="text-[18px] font-extrabold tracking-tight text-[var(--app-text)]">
                {title}
              </div>
              {description ? (
                <div className="mt-1 text-[13px] font-medium leading-6 text-[var(--app-text-muted)]">
                  {description}
                </div>
              ) : null}
            </div>

            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[14px] border border-[var(--app-border)] bg-white text-[var(--app-text-muted)] transition hover:bg-[var(--app-surface-muted)] hover:text-[var(--app-text)]"
              aria-label="Close dialog"
            >
              <Icon name="close" />
            </button>
          </div>

          <div className="px-6 py-5">{children}</div>

          {footer ? (
            <div className="flex items-center justify-end gap-3 border-t border-[var(--app-border)] bg-[var(--app-surface-muted)]/85 px-6 py-4">
              {footer}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type DialogButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "danger";
  icon?: string;
  disabled?: boolean;
};

export function DialogButton({
  children,
  onClick,
  variant = "secondary",
  icon,
  disabled,
}: DialogButtonProps) {
  const toneClass =
    variant === "primary"
      ? "border-[#11120d] bg-[#11120d] text-white hover:border-[#2a2c27] hover:bg-[#2a2c27]"
      : variant === "danger"
        ? "border-[var(--app-danger-border)] bg-[var(--app-danger-bg)] text-[var(--app-danger-text)] hover:bg-rose-100 hover:border-rose-300"
        : "border-[var(--app-border)] bg-white text-[var(--app-text-soft)] hover:bg-[var(--app-surface-muted)]";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-[14px] border px-4 py-2.5 text-[13px] font-extrabold transition active:scale-[0.98]",
        toneClass,
        disabled && "pointer-events-none opacity-50",
      )}
    >
      {icon ? <Icon name={icon} className="text-inherit" /> : null}
      {children}
    </button>
  );
}

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
      ? "border-[var(--app-danger-border)] bg-[var(--app-danger-bg)] text-[var(--app-danger-text)]"
      : "border-[var(--app-warning-border)] bg-[var(--app-warning-bg)] text-[var(--app-warning-text)]";

  return (
    <ModalFrame open={open} onClose={onClose} title={title}>
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

          <div className="pt-1 text-[14px] font-medium leading-7 text-[var(--app-text-soft)]">
            {message}
          </div>
        </div>

        {details ? (
          <div className="rounded-[18px] border border-[var(--app-border)] bg-[var(--app-surface-muted)]/90 p-4 text-[13px] text-[var(--app-text-soft)]">
            {details}
          </div>
        ) : null}
      </div>

      <div className="mt-5 flex items-center justify-end gap-3">
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
    </ModalFrame>
  );
}

type SuccessDialogProps = {
  open: boolean;
  title: string;
  message: string;
  onClose: () => void;
  actionLabel?: string;
  secondaryAction?: ReactNode;
};

export function SuccessDialog({
  open,
  title,
  message,
  onClose,
  actionLabel = "Done",
  secondaryAction,
}: SuccessDialogProps) {
  return (
    <ModalFrame open={open} onClose={onClose} title={title}>
      <div className="space-y-5">
        <div className="flex items-start gap-4">
          <div className="inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-[18px] border border-emerald-200 bg-emerald-50 text-emerald-600">
            <Icon name="check_circle" sizePx={30} className="text-inherit" />
          </div>

          <div className="pt-1 text-[14px] font-medium leading-7 text-[var(--app-text-soft)]">
            {message}
          </div>
        </div>
      </div>

      <div className="mt-5 flex items-center justify-end gap-3">
        {secondaryAction}
        <DialogButton onClick={onClose} variant="primary" icon="check_circle">
          {actionLabel}
        </DialogButton>
      </div>
    </ModalFrame>
  );
}
