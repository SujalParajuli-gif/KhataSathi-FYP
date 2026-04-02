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
            "relative w-full overflow-hidden rounded-[24px] border border-[#CFCFD3] bg-[#FFFFFF] ",
            maxWidthClass,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-[#CFCFD3] px-[24px] py-[20px]">
            <div className="min-w-0">
              <div className="text-[18px] font-extrabold  text-[#000000]">
                {title}
              </div>
              {description ? (
                <div className="mt-[4px] text-[13px] font-medium leading-[24px] text-[#8C8889]">
                  {description}
                </div>
              ) : null}
            </div>

            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-[14px] border border-[#CFCFD3] bg-[#FFFFFF] text-[#8C8889] transition hover:bg-[#F3F4F6] hover:text-[#000000]"
              aria-label="Close dialog"
            >
              <Icon name="close" />
            </button>
          </div>

          <div className="px-[24px] py-[20px]">{children}</div>

          {footer ? (
            <div className="flex items-center justify-end gap-3 border-t border-[#CFCFD3] bg-[rgba(243,244,246,0.85)] px-[24px] py-[16px]">
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
        ? "border-[#FECDD3] bg-[#FFF1F2] text-[#BE123C] hover:border-rose-300 hover:bg-rose-100"
        : "border-[#CFCFD3] bg-[#FFFFFF] text-[#565449] hover:bg-[#F3F4F6]";

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
      ? "border-[#FECDD3] bg-[#FFF1F2] text-[#BE123C]"
      : "border-[#F6D28B] bg-[#FFF7E8] text-[#B7791F]";

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

          <div className="pt-[4px] text-[14px] font-medium leading-[28px] text-[#565449]">
            {message}
          </div>
        </div>

        {details ? (
          <div className="rounded-[18px] border border-[#CFCFD3] bg-[rgba(243,244,246,0.9)] p-[16px] text-[13px] text-[#565449]">
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

          <div className="pt-[4px] text-[14px] font-medium leading-[28px] text-[#565449]">
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

type StatusDialogProps = {
  open: boolean;
  title: string;
  message: string;
  onClose: () => void;
  actionLabel?: string;
  tone?: "success" | "error";
};

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
    <ModalFrame open={open} onClose={onClose} title={title}>
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

      <div className="mt-5 flex items-center justify-end gap-3">
        <DialogButton onClick={onClose} variant={actionTone} icon={iconName}>
          {actionLabel}
        </DialogButton>
      </div>
    </ModalFrame>
  );
}

