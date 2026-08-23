import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  createUserApi,
  getMeApi,
  getUserDeleteSafetyApi,
  listUsersApi,
  permanentlyDeleteUserApi,
  updateProfileApi,
  updateUserApi,
  uploadProfilePhotoApi,
  uploadUserPhotoApi,
  type UserDeleteSafety,
} from "~/lib/api/endpoints";
import { API_BASE_URL } from "~/lib/api/baseUrl";
import { ConfirmDialog, DialogButton, ModalFrame, StatusDialog } from "~/components/ui/Modal";
import Icon from "~/components/ui/Icon";
import PreviewableImage from "~/components/ui/PreviewableImage";
import ProjectSelect from "~/components/ui/ProjectSelect";
import {
  ActiveFilterChips,
  MobileFilterButton,
  MobileFilterSheet,
  type MobileFilterChip,
} from "~/components/ui/MobileFilters";
import ProfileWorkspaceNav from "~/components/profile/ProfileWorkspaceNav";
import { useBodyScrollLock } from "~/hooks/useBodyScrollLock";
import { setAuthUser } from "~/lib/auth";
import { useMemo } from "react";
import { isRateLimitError } from "~/lib/api/client";
import { useRateLimitRecovery } from "~/lib/api/useRateLimitRecovery";

// formats the "last login" date, falling back to "Never" if null
function formatLastLogin(value?: string | null) {
  return value ? new Date(value).toLocaleString() : "Never";
}

// resolves an API image path to a full URL, or passes it through directly if it's a browser blob
function resolveImageUrl(path?: string | null) {
  if (!path) return undefined;
  if (path.startsWith("blob:")) return path;
  return `${API_BASE_URL}${path}`;
}

// simple regex to check if a string looks like an email address
function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

// this lightweight icon helper keeps the older profile UI using one consistent material icon wrapper
function GIcon({
  name,
  sizePx = 20,
  className = "",
}: {
  name: string;
  sizePx?: number;
  className?: string;
}) {
  return (
    <span
      className={`material-symbols-rounded select-none leading-none ${className}`}
      style={{ fontSize: `${sizePx}px` }}
      aria-hidden="true"
    >
      {name}
    </span>
  );
}

// this is the shared card wrapper used throughout the admin profile workspace
function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex h-full flex-col">
      {children}
    </div>
  );
}

// this keeps section headings and small subtitles visually consistent
function SectionTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div>
      <h2 className="text-lg font-bold text-slate-800">{title}</h2>
      {sub ? (
        <p className="mt-1 text-sm text-slate-500">{sub}</p>
      ) : null}
    </div>
  );
}

// this is the shared text field used across the admin and cashier management forms
function TextField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  type = "text",
  error,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  type?: string;
  error?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-extrabold uppercase  text-[#8C8889]">
        {label}
      </div>
      <input
        type={type}
        value={value}
        aria-label={label}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(e) => onChange?.(e.target.value)}
        className={[
          "h-11 w-full rounded-[8px] border bg-white px-3",
          "text-[13px] font-semibold text-[#000000] outline-none",
          "placeholder:text-[#8C8889]",
          disabled
            ? "border-[#CFCFD3] bg-[#F3F4F6] text-[#8C8889]"
            : error
              ? "border-rose-300 focus:border-rose-400"
              : "border-[#CFCFD3] focus:border-[#11120d]",
        ].join(" ")}
      />
      {error ? (
        <div className="text-[12px] font-semibold text-rose-600">{error}</div>
      ) : null}
    </div>
  );
}

// this wraps select fields with the same label and error styling as the text fields
function SelectField({
  label,
  value,
  onChange,
  options,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  error?: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-extrabold uppercase  text-[#8C8889]">
        {label}
      </div>
      <ProjectSelect
        value={value}
        aria-label={label}
        onChange={(event) => onChange(event.target.value)}
        className={[
          "h-11 w-full rounded-[8px] border bg-white px-3",
          "text-[13px] font-semibold text-[#000000] outline-none",
          error
            ? "border-rose-300 focus:border-rose-400"
            : "border-[#CFCFD3] focus:border-[#11120d]",
        ].join(" ")}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </ProjectSelect>
      {error ? (
        <div className="text-[12px] font-semibold text-rose-600">{error}</div>
      ) : null}
    </div>
  );
}

// this is the shared button component used across profile actions and modal footers
function Button({
  variant = "secondary",
  icon,
  children,
  onClick,
  disabled,
  title,
  iconOnly = false,
}: {
  variant?: "primary" | "secondary" | "danger";
  icon?: string;
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  iconOnly?: boolean;
}) {
  const baseClasses =
    "inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-50";

  const variants = {
    primary: "bg-[#11120d] text-white hover:bg-black shadow-sm",
    secondary:
      "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
    danger: "bg-rose-600 text-white hover:bg-rose-700 shadow-sm",
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={iconOnly ? title : undefined}
      className={cn(
        baseClasses,
        variants[variant],
        iconOnly ? "w-10 h-10 p-0" : "",
      )}
    >
      {icon ? <GIcon name={icon} sizePx={18} className="opacity-90" /> : null}
      <span className={iconOnly ? "sr-only" : undefined}>{children}</span>
    </button>
  );
}

function ActionMenu({
  options,
}: {
  options: {
    label: string;
    icon: string;
    danger?: boolean;
    onClick: () => void;
    disabled?: boolean;
  }[];
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);

  const positionMenu = React.useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const triggerRect = trigger.getBoundingClientRect();
    const viewportPadding = 12;
    const menuGap = 6;
    const menuWidth = 192;
    const menuHeight = Math.max(48, options.length * 42 + 12);
    const roomBelow = window.innerHeight - triggerRect.bottom - viewportPadding;
    const roomAbove = triggerRect.top - viewportPadding;
    const openUpward = roomBelow < menuHeight && roomAbove > roomBelow;
    const preferredTop = openUpward
      ? triggerRect.top - menuHeight - menuGap
      : triggerRect.bottom + menuGap;

    setMenuPosition({
      left: Math.min(
        Math.max(viewportPadding, triggerRect.right - menuWidth),
        window.innerWidth - menuWidth - viewportPadding,
      ),
      top: Math.min(
        Math.max(viewportPadding, preferredTop),
        window.innerHeight - menuHeight - viewportPadding,
      ),
    });
  }, [options.length]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    if (!open) return;
    positionMenu();
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [open, positionMenu]);

  return (
    <div className="relative inline-block text-left">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Open user actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex items-center justify-center w-8 h-8 rounded-full border border-slate-300 bg-white text-slate-700 shadow-sm hover:bg-slate-50 transition-colors"
      >
        <GIcon name="more_vert" sizePx={20} />
      </button>
      {open && menuPosition
        ? createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-[200] w-48 origin-top-right overflow-hidden rounded-xl border border-slate-200 bg-white py-1.5 shadow-xl focus:outline-none"
          style={{ left: menuPosition.left, top: menuPosition.top }}
        >
          {options.map((option, idx) => (
            <button
              key={idx}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                option.onClick();
              }}
              disabled={option.disabled}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-2.5 text-[13px] font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                option.danger
                  ? "text-rose-600 hover:bg-rose-50"
                  : "text-slate-700 hover:bg-slate-50"
              )}
            >
              <GIcon name={option.icon} sizePx={18} />
              {option.label}
            </button>
          ))}
        </div>,
        document.body,
      )
        : null}
    </div>
  );
}


// this small badge component is used for role, status, and verification labels
function Badge({
  tone = "slate",
  children,
}: {
  tone?: "slate" | "green" | "blue";
  children: React.ReactNode;
}) {
  const cls =
    tone === "green"
      ? "bg-[#EAF8EF] text-[#179B4D] border-[#9DD8B2]"
      : tone === "blue"
        ? "bg-[#EAF2FF] text-[#2563EB] border-[#BFDBFE]"
        : "bg-[#F3F4F6] text-[#565449] border-[#CFCFD3]";

  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-1 text-[11px] font-extrabold uppercase  ${cls}`}
    >
      {children}
    </span>
  );
}

// this is the shared modal shell used for add/edit cashier dialogs
function Modal({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  useBodyScrollLock(open);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-2 sm:p-4">
      <button
        type="button"
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
        aria-label="Close modal overlay"
        onClick={onClose}
      />

      <div className="relative flex max-h-[calc(100dvh-16px)] w-full max-w-[580px] flex-col overflow-hidden rounded-[16px] border border-[#CFCFD3] bg-white sm:max-h-[calc(100dvh-32px)]">
        <div className="flex shrink-0 items-center justify-between border-b border-[#CFCFD3] px-4 py-3 sm:px-5 sm:py-4">
          <div className="text-[14px] font-extrabold text-[#000000]">
            {title}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center rounded-[12px] border border-[#CFCFD3] bg-white hover:bg-[#F3F4F6]"
            aria-label="Close modal"
          >
            <GIcon name="close" sizePx={18} className="text-[#565449]" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pb-[max(16px,env(safe-area-inset-bottom))] sm:p-5">{children}</div>
      </div>
    </div>
  );
}

// this handles image preview, upload, and removal controls for admin and cashier profile photos
function ImageUpload({
  label,
  previewUrl,
  onPick,
  onClear,
}: {
  label: string;
  previewUrl?: string;
  onPick: (file: File) => void;
  onClear: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="text-[11px] font-extrabold uppercase  text-[#8C8889]">
        {label}
      </div>

      <div className="flex items-center gap-3">
        <PreviewableImage
          src={previewUrl}
          alt="Preview"
          title="Profile photo preview"
          previewCue="always"
          className="flex h-[56px] w-[56px] shrink-0 items-center justify-center overflow-hidden rounded-[8px] border border-[#CFCFD3] bg-[#F3F4F6]"
          fallback={
            <GIcon name="person" sizePx={22} className="text-[#8C8889]" />
          }
        />

        <label className="inline-flex cursor-pointer items-center gap-2 rounded-[12px] border border-[#CFCFD3] bg-white px-3 py-2.5 text-[13px] font-bold text-[#565449] hover:bg-[#F3F4F6]">
          <GIcon name="upload" sizePx={18} className="text-[#8C8889]" />
          Upload
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onPick(file);
              e.currentTarget.value = "";
            }}
          />
        </label>

        <button
          type="button"
          onClick={onClear}
          className="inline-flex items-center gap-2 rounded-[12px] border border-[#CFCFD3] bg-white px-3 py-2.5 text-[13px] font-bold text-[#565449] hover:bg-[#F3F4F6]"
        >
          <GIcon name="delete" sizePx={18} className="text-[#8C8889]" />
          Remove
        </button>
      </div>
    </div>
  );
}

type AdminProfile = {
  firstName: string;
  lastName: string;
  gender: "Male" | "Female";
  email: string;
  emailVerified: boolean | null;
  address: string;
  phone: string;
  location: string;
  roleLabel: string;
  lastLogin?: string | null;
};

type Cashier = {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: "MANAGER" | "CASHIER" | "STAFF";
  gender?: string | null;
  address?: string | null;
  active: boolean;
  lastLogin: string;
  profileImage?: string | null;
};

type AdminTabKey = "personal" | "security" | "users";

const ADMIN_LOCATION_STORAGE_KEY = "khatasathi_admin_profile_location";

// we keep admin location in local storage for now because it is not persisted by the backend profile endpoint yet
function readStoredAdminLocation() {
  if (typeof window === "undefined") return "Nepal";
  return window.localStorage.getItem(ADMIN_LOCATION_STORAGE_KEY) || "Nepal";
}

// we use this because sometimes names come in as one single string, but forms need first/last
function splitName(name?: string | null) {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  return {
    firstName: parts[0] || "",
    lastName: parts.slice(1).join(" "),
  };
}

// humanizes the database role label
function formatRoleLabel(role?: string | null) {
  const normalized = String(role || "").toLowerCase();
  if (normalized === "admin") return "Admin";
  if (normalized === "manager") return "Manager";
  if (normalized === "cashier") return "Cashier";
  if (normalized === "staff") return "Staff";
  return "User";
}

function formatDateTime(value?: string | null) {
  if (!value) return "Not available";
  return new Date(value).toLocaleString();
}

// this maps the raw backend user object into the flatter profile state used by the admin page
function mapUserToAdminProfile(user: any): AdminProfile {
  const { firstName, lastName } = splitName(user?.name);

  return {
    firstName,
    lastName,
    gender: user?.gender === "Female" ? "Female" : "Male",
    email: user?.email || "",
    emailVerified:
      typeof user?.emailVerified === "boolean" ? user.emailVerified : null,
    address: user?.address || "",
    phone: user?.phone || "",
    location: readStoredAdminLocation(),
    roleLabel: formatRoleLabel(user?.role),
    lastLogin: user?.lastLogin || null,
  };
}

// this is the main panel wrapper used in the admin profile screen
function ProfilePanel({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex h-full flex-col">
      <div className="p-6 border-b border-slate-100 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h3 className="text-lg font-bold text-slate-800">
            {title}
          </h3>
          {subtitle ? (
            <p className="text-sm text-slate-500">
              {subtitle}
            </p>
          ) : null}
        </div>
        {actions}
      </div>
      <div className="flex-1">{children}</div>
    </div>
  );
}

// this keeps the admin profile action buttons visually consistent
function ProfileActionButton({
  icon,
  label,
  onClick,
  disabled,
  primary = false,
}: {
  icon: string;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-2 px-6 py-2.5 rounded-lg font-semibold text-sm transition-all",
        disabled ? "cursor-not-allowed opacity-50" : "",
        primary
          ? "bg-[#11120d] text-white hover:bg-black shadow-sm focus:ring-2 focus:ring-slate-900 focus:ring-offset-2"
          : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50 focus:ring-2 focus:ring-slate-200 focus:ring-offset-2",
      )}
    >
      {icon && <GIcon name={icon} sizePx={18} />}
      {label}
    </button>
  );
}

// this keeps form labels and right-side hints aligned across profile sections
function ProfileField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-2">
        <label className="block text-xs font-bold text-slate-500 uppercase">
          {label}
        </label>
        {hint ? (
          <span className="text-[10px] font-medium text-slate-400">
            {hint}
          </span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

// this is the shared text input used in the admin profile forms
function ProfileTextInput({
  value,
  onChange,
  placeholder,
  type = "text",
  disabled = false,
  right,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
  right?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border bg-white px-4 py-2.5 transition-all outline-none",
        disabled
          ? "border-slate-200 bg-slate-50 text-slate-500 cursor-not-allowed"
          : "border-slate-200 focus-within:ring-2 focus-within:ring-slate-900 focus-within:border-transparent"
      )}
    >
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder || "Text input"}
        disabled={disabled}
        className={cn(
          "w-full bg-transparent text-sm outline-none placeholder:text-slate-400",
          disabled ? "text-slate-500 cursor-not-allowed" : "text-slate-900",
        )}
      />
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

// this wraps select inputs so they match the admin profile text fields
function ProfileSelectInput({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  ariaLabel?: string;
}) {
  return (
    <ProjectSelect value={value} onChange={(event) => onChange(event.target.value)} aria-label={ariaLabel || "Select an option"}>
      {options.map((option) => <option key={option} value={option}>{option}</option>)}
    </ProjectSelect>
  );
}

// the master profile view
// this shows an admin's personal details alongside a full list of all cashier accounts
export default function ProfilePage() {
  const [rateLimitRecoveryKey, setRateLimitRecoveryKey] = useState(0);
  const requestRateLimitRecovery = useRateLimitRecovery(() => {
    setRateLimitRecoveryKey((current) => current + 1);
  });
  const [adminProfile, setAdminProfile] = useState<AdminProfile>({
    firstName: "",
    lastName: "",
    gender: "Male",
    email: "",
    emailVerified: null,
    address: "",
    phone: "",
    location: "Nepal",
    roleLabel: "Admin",
    lastLogin: null,
  });
  const [adminInitialProfile, setAdminInitialProfile] = useState<AdminProfile>({
    firstName: "",
    lastName: "",
    gender: "Male",
    email: "",
    emailVerified: null,
    address: "",
    phone: "",
    location: "Nepal",
    roleLabel: "Admin",
    lastLogin: null,
  });
  const [adminTab, setAdminTab] = useState<AdminTabKey>("personal"); // switches between personal info and password settings for the admin

  const [adminPhotoUrl, setAdminPhotoUrl] = useState<string | undefined>(
    undefined,
  );
  const [uploadingAdminPhoto, setUploadingAdminPhoto] = useState(false); // tracks admin photo upload separately from other saves
  const [adminSecurity, setAdminSecurity] = useState({
    current: "",
    next: "",
    confirm: "",
  });
  const [adminSecurityError, setAdminSecurityError] = useState(""); // validation or API error for admin password changes
  const [savingAdminProfile, setSavingAdminProfile] = useState(false); // blocks repeated admin profile saves
  const [savingAdminPassword, setSavingAdminPassword] = useState(false); // blocks repeated admin password saves

  const [cashiers, setCashiers] = useState<Cashier[]>([]); // all cashier accounts shown in the lower management section
  const [loadingCashiers, setLoadingCashiers] = useState(false); // cashier list loading state
  const [userQuery, setUserQuery] = useState("");
  const [userRoleFilter, setUserRoleFilter] = useState<"ALL" | Cashier["role"]>("ALL");
  const [userStatusFilter, setUserStatusFilter] = useState<"ALL" | "ACTIVE" | "INACTIVE">("ACTIVE");
  const [mobileUserFiltersOpen, setMobileUserFiltersOpen] = useState(false);
  const [draftUserRoleFilter, setDraftUserRoleFilter] = useState<"ALL" | Cashier["role"]>("ALL");
  const [draftUserStatusFilter, setDraftUserStatusFilter] = useState<"ALL" | "ACTIVE" | "INACTIVE">("ACTIVE");
  const [currentAdminId, setCurrentAdminId] = useState<string | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false); // controls the shared success/error dialog
  const [feedbackTitle, setFeedbackTitle] = useState(""); // dialog title
  const [feedbackMessage, setFeedbackMessage] = useState(""); // dialog message
  const [feedbackTone, setFeedbackTone] = useState<"success" | "error">(
    "success",
  );

  const [addOpen, setAddOpen] = useState(false); // controls the add cashier modal
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newGender, setNewGender] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [newRole, setNewRole] = useState<"MANAGER" | "CASHIER" | "STAFF">("CASHIER");
  const [newPassword, setNewPassword] = useState("");
  const [newConfirmPassword, setNewConfirmPassword] = useState("");
  const [newPhotoUrl, setNewPhotoUrl] = useState<string | undefined>(undefined);
  const [newPhotoFile, setNewPhotoFile] = useState<File | null>(null);
  const [addFormError, setAddFormError] = useState(""); // top-level add cashier error
  const [addFieldErrors, setAddFieldErrors] = useState({
    name: "",
    email: "",
    phone: "",
    password: "",
    confirmPassword: "",
  });

  const [editOpen, setEditOpen] = useState(false); // controls the edit cashier modal
  const [editId, setEditId] = useState<string | null>(null); // cashier currently being edited
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editGender, setEditGender] = useState("");
  const [editAddress, setEditAddress] = useState("");
  const [editRole, setEditRole] = useState<"MANAGER" | "CASHIER" | "STAFF">("CASHIER");
  const [editNewPassword, setEditNewPassword] = useState("");
  const [editConfirmPassword, setEditConfirmPassword] = useState("");
  const [editActive, setEditActive] = useState(true);
  const [editPhotoUrl, setEditPhotoUrl] = useState<string | undefined>(
    undefined,
  );
  const [editPhotoFile, setEditPhotoFile] = useState<File | null>(null);
  const [editPhotoRemoved, setEditPhotoRemoved] = useState(false);
  const [editWantsPasswordChange, setEditWantsPasswordChange] = useState(false);
  const [editFormError, setEditFormError] = useState(""); // top-level edit cashier error
  const [editFieldErrors, setEditFieldErrors] = useState({
    name: "",
    email: "",
    phone: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [pendingDeactivateCashier, setPendingDeactivateCashier] =
    useState<Cashier | null>(null);
  const [pendingDeleteCashier, setPendingDeleteCashier] =
    useState<Cashier | null>(null);
  const [deleteSafety, setDeleteSafety] = useState<UserDeleteSafety | null>(
    null,
  );
  const [deleteSafetyLoading, setDeleteSafetyLoading] = useState(false);
  const [deletingCashier, setDeletingCashier] = useState(false);

  function mapCashier(user: any): Cashier {
    return {
      id: user.id,
      name: user.name || "Unknown",
      email: user.email || "",
      phone: user.phone || "",
      role: user.role === "MANAGER" || user.role === "STAFF" ? user.role : "CASHIER",
      gender: user.gender || null,
      address: user.address || null,
      active: user.isActive !== false,
      lastLogin: formatLastLogin(user.lastLogin),
      profileImage: user.profileImage || null,
    };
  }

  // fetching the list of all cashiers currently in the system
  async function loadCashiers() {
    setLoadingCashiers(true);
    try {
      const users = await listUsersApi();
      const rows = Array.isArray(users) ? users : [];
      setCashiers(
        rows
          .filter((user: any) =>
            user.role === "CASHIER" || user.role === "MANAGER" || user.role === "STAFF"
          )
          .map(mapCashier),
      );
    } catch (error) {
      if (isRateLimitError(error)) requestRateLimitRecovery();
      throw error;
    } finally {
      setLoadingCashiers(false);
    }
  }

  // syncing auth after admin profile or photo updates keeps the rest of the app header in sync immediately
  async function syncAuth(user: any) {
    setAuthUser({
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      profileImage: user.profileImage,
    });
    window.dispatchEvent(new Event("auth_change"));
  }

  // this opens the shared feedback dialog with either a success or error tone
  function showFeedback(
    tone: "success" | "error",
    title: string,
    message: string,
  ) {
    setFeedbackTone(tone);
    setFeedbackTitle(title);
    setFeedbackMessage(message);
    setFeedbackOpen(true);
  }

  useEffect(() => {
    // loading the admin's own profile plus the cashier list when the page first opens
    const controller = new AbortController();
    async function load() {
      const [profileResult, usersResult] = await Promise.allSettled([
        getMeApi({ signal: controller.signal }),
        loadCashiers(),
      ]);

      if (profileResult.status === "fulfilled" && !controller.signal.aborted) {
        const data = profileResult.value;
        const user = data.user || data;
        setCurrentAdminId(user.id || null);
        const nextAdminProfile = mapUserToAdminProfile(user);
        setAdminProfile(nextAdminProfile);
        setAdminInitialProfile(nextAdminProfile);
        setAdminPhotoUrl(user.profileImage || undefined);
        await syncAuth(user);
      }

      const rejected = [profileResult, usersResult].find(
        (result) => result.status === "rejected" && isRateLimitError(result.reason),
      );
      if (rejected) requestRateLimitRecovery();
    }

    void load();
    return () => controller.abort();
  }, [rateLimitRecoveryKey]);

  useEffect(() => {
    // saving the temporary admin location choice locally until the backend supports this field
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        ADMIN_LOCATION_STORAGE_KEY,
        adminProfile.location,
      );
    }
  }, [adminProfile.location]);

  // opening the add cashier modal starts from a fully clean form state each time
  function resetAddForm() {
    setNewName("");
    setNewEmail("");
    setNewPhone("");
    setNewGender("");
    setNewAddress("");
    setNewRole("CASHIER");
    setNewPassword("");
    setNewConfirmPassword("");
    setNewPhotoUrl(undefined);
    setNewPhotoFile(null);
    setAddFormError("");
    setAddFieldErrors({
      name: "",
      email: "",
      phone: "",
      password: "",
      confirmPassword: "",
    });
  }

  // copying the selected cashier into edit state lets the modal work without mutating the original table data
  function openEdit(cashier: Cashier) {
    setEditId(cashier.id);
    setEditName(cashier.name);
    setEditEmail(cashier.email);
    setEditPhone(cashier.phone);
    setEditGender(cashier.gender || "");
    setEditAddress(cashier.address || "");
    setEditRole(cashier.role);
    setEditNewPassword("");
    setEditConfirmPassword("");
    setEditActive(cashier.active);
    setEditPhotoUrl(cashier.profileImage || undefined);
    setEditPhotoFile(null);
    setEditPhotoRemoved(false);
    setEditWantsPasswordChange(false);
    setEditFormError("");
    setEditFieldErrors({
      name: "",
      email: "",
      phone: "",
      newPassword: "",
      confirmPassword: "",
    });
    setEditOpen(true);
  }

  // closing edit clears every temporary field so the next cashier starts fresh
  function closeEdit() {
    setEditOpen(false);
    setEditId(null);
    setEditName("");
    setEditEmail("");
    setEditPhone("");
    setEditGender("");
    setEditAddress("");
    setEditRole("CASHIER");
    setEditNewPassword("");
    setEditConfirmPassword("");
    setEditActive(true);
    setEditPhotoUrl(undefined);
    setEditPhotoFile(null);
    setEditPhotoRemoved(false);
    setEditWantsPasswordChange(false);
    setEditFormError("");
    setEditFieldErrors({
      name: "",
      email: "",
      phone: "",
      newPassword: "",
      confirmPassword: "",
    });
  }

  // these checks keep invalid cashier creation data from being submitted to the backend
  function validateAddCashier() {
    const nextErrors = {
      name: "",
      email: "",
      phone: "",
      password: "",
      confirmPassword: "",
    };

    if (!newName.trim()) nextErrors.name = "Full name is required.";
    if (newEmail.trim() && !isValidEmail(newEmail.trim()))
      nextErrors.email = "Enter a valid email address.";
    if (!newPhone.trim()) nextErrors.phone = "Phone number is required.";
    if (!newPassword) nextErrors.password = "Password is required.";
    else if (newPassword.length < 8)
      nextErrors.password = "Password must be at least 8 characters.";
    if (!newConfirmPassword)
      nextErrors.confirmPassword = "Confirm the password.";
    else if (newPassword !== newConfirmPassword)
      nextErrors.confirmPassword = "Passwords do not match.";

    setAddFieldErrors(nextErrors);
    return !Object.values(nextErrors).some(Boolean);
  }

  // edit validation is slightly different because password change is optional here
  function validateEditCashier() {
    const nextErrors = {
      name: "",
      email: "",
      phone: "",
      newPassword: "",
      confirmPassword: "",
    };

    if (!editName.trim()) nextErrors.name = "Full name is required.";
    if (editEmail.trim() && !isValidEmail(editEmail.trim()))
      nextErrors.email = "Enter a valid email address.";
    if (!editPhone.trim()) nextErrors.phone = "Phone number is required.";

    const wantsPasswordChange = editWantsPasswordChange;

    if (wantsPasswordChange) {
      if (!editNewPassword) nextErrors.newPassword = "Enter the new password.";
      else if (editNewPassword.length < 8)
        nextErrors.newPassword = "Password must be at least 8 characters.";
      if (!editConfirmPassword)
        nextErrors.confirmPassword = "Confirm the new password.";
      else if (editNewPassword !== editConfirmPassword) {
        nextErrors.confirmPassword = "Passwords do not match.";
      }
    }

    setEditFieldErrors(nextErrors);
    return !Object.values(nextErrors).some(Boolean);
  }

  async function handleAddCashier() {
    if (!validateAddCashier()) return;

    try {
      setAddFormError("");
      let user = await createUserApi({
        name: newName.trim(),
        email: newEmail.trim() || null,
        phone: newPhone.trim(),
        gender: newGender || undefined,
        address: newAddress.trim() || undefined,
        password: newPassword,
        role: newRole,
        isActive: true,
      });

      if (newPhotoFile) {
        user = await uploadUserPhotoApi(user.id, newPhotoFile);
      }

      await loadCashiers();
      setAddOpen(false);
      resetAddForm();
      showFeedback(
        "success",
        `${formatRoleLabel(newRole)} added`,
        newPhotoFile
          ? "The staff account and photo were added. They must replace the temporary password at first sign-in."
          : "The staff account was added. They must replace the temporary password at first sign-in.",
      );
    } catch (error: any) {
      console.error(error);
      const message =
        error.response?.data?.error ||
        error?.message ||
        "Error adding cashier.";
      const field = error.response?.data?.field;
      if (field === "phone" || field === "email" || field === "name" || field === "password") {
        setAddFieldErrors((current) => ({ ...current, [field]: message }));
      }
      setAddFormError(message);
      showFeedback("error", "Could not add cashier", message);
    }
  }

  async function handleSaveEdit() {
    if (!editId || !validateEditCashier()) return;

    try {
      setEditFormError("");
      const wantsPasswordChange = editWantsPasswordChange;

      await updateUserApi(editId, {
        name: editName.trim(),
        email: editEmail.trim() || null,
        phone: editPhone.trim(),
        gender: editGender || null,
        address: editAddress.trim(),
        role: editRole,
        isActive: editActive,
        ...(wantsPasswordChange
          ? {
            newPassword: editNewPassword,
          }
          : {}),
      });

      if (editPhotoRemoved) {
        await updateUserApi(editId, { profileImage: null });
      } else if (editPhotoFile) {
        await uploadUserPhotoApi(editId, editPhotoFile);
      }

      await loadCashiers();
      closeEdit();
      showFeedback(
        "success",
        wantsPasswordChange ? "Password updated" : "Staff updated",
        wantsPasswordChange
          ? "A temporary password was set. The staff member must replace it at their next sign-in."
          : editPhotoRemoved
            ? "The staff profile has been updated and the photo has been removed."
            : editPhotoFile
              ? "The staff profile and photo have been updated successfully."
              : "The staff profile has been updated successfully.",
      );
    } catch (error: any) {
      console.error(error);
      const message =
        error.response?.data?.error ||
        error?.message ||
        "Error updating staff.";
      const field = error.response?.data?.field;
      if (field === "phone" || field === "email" || field === "name") {
        setEditFieldErrors((current) => ({ ...current, [field]: message }));
      }
      setEditFormError(message);
      showFeedback("error", "Could not update staff", message);
    }
  }

  async function toggleCashierActive(id: string) {
    const cashier = cashiers.find((item) => item.id === id);
    if (!cashier) return;

    if (cashier.active) {
      setPendingDeactivateCashier(cashier);
      return;
    }

    if (!cashier.phone) {
      openEdit(cashier);
      setEditActive(true);
      setEditFieldErrors((current) => ({
        ...current,
        phone: "Add a valid Nepali mobile number before activating this account.",
      }));
      setEditFormError(
        "This archived account has no verified phone. Add one and save to activate it safely.",
      );
      return;
    }

    try {
      if (cashier.active) {
        showFeedback(
          "success",
          "Already active",
          `${cashier.name} is already active. No changes were made.`,
        );
        return;
      }
      await updateUserApi(id, { isActive: true });
      await loadCashiers();
      showFeedback(
        "success",
        "Staff activated",
        "The staff account has been activated successfully.",
      );
    } catch (error: any) {
      showFeedback(
        "error",
        "Could not activate staff",
        error?.response?.data?.error ||
        error?.message ||
        "Failed to activate the staff account.",
      );
    }
  }

  async function confirmDeactivateCashier() {
    if (!pendingDeactivateCashier) return;

    try {
      if (!pendingDeactivateCashier.active) {
        showFeedback(
          "success",
          "Already inactive",
          `${pendingDeactivateCashier.name} is already inactive. No changes were made.`,
        );
        setPendingDeactivateCashier(null);
        return;
      }
      await updateUserApi(pendingDeactivateCashier.id, { isActive: false });
      await loadCashiers();
      showFeedback(
        "success",
        "Staff deactivated",
        "The staff account has been deactivated successfully.",
      );
      setPendingDeactivateCashier(null);
    } catch (error: any) {
      showFeedback(
        "error",
        "Could not deactivate staff",
        error?.response?.data?.error ||
        error?.message ||
        "Failed to deactivate the staff account.",
      );
    }
  }

  async function openDeleteCashier(cashier: Cashier) {
    setPendingDeleteCashier(cashier);
    setDeleteSafety(null);
    setDeleteSafetyLoading(true);

    try {
      const safety = await getUserDeleteSafetyApi(cashier.id);
      setDeleteSafety(safety);
    } catch (error: any) {
      setPendingDeleteCashier(null);
      showFeedback(
        "error",
        "Could not check delete safety",
        error?.response?.data?.error ||
        error?.message ||
        "The staff account could not be checked for permanent delete.",
      );
    } finally {
      setDeleteSafetyLoading(false);
    }
  }

  function closeDeleteCashier() {
    if (deletingCashier) return;
    setPendingDeleteCashier(null);
    setDeleteSafety(null);
    setDeleteSafetyLoading(false);
  }

  async function confirmPermanentDeleteCashier() {
    if (!pendingDeleteCashier || !deleteSafety?.canPermanentDelete) return;

    setDeletingCashier(true);
    try {
      const result = await permanentlyDeleteUserApi(pendingDeleteCashier.id);
      await loadCashiers();
      showFeedback(
        "success",
        "Staff deleted",
        result?.message ||
        `${pendingDeleteCashier.name} was permanently deleted because no history was found.`,
      );
      setPendingDeleteCashier(null);
      setDeleteSafety(null);
      setDeleteSafetyLoading(false);
    } catch (error: any) {
      const nextSafety = error?.response?.data?.safety;
      if (nextSafety) setDeleteSafety(nextSafety);
      showFeedback(
        "error",
        "Permanent delete blocked",
        error?.response?.data?.error ||
        error?.message ||
        "This staff account has history and should be deactivated instead.",
      );
    } finally {
      setDeletingCashier(false);
    }
  }

  const adminDisplayName =
    `${adminProfile.firstName} ${adminProfile.lastName}`.trim() || "Admin";
  const adminInitials = useMemo(
    () =>
      adminDisplayName
        .split(" ")
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() || "")
        .join(""),
    [adminDisplayName],
  );
  const adminHasProfileChanges =
    JSON.stringify(adminProfile) !== JSON.stringify(adminInitialProfile);
  const adminHasSecurityChanges = Boolean(
    adminSecurity.current || adminSecurity.next || adminSecurity.confirm,
  );
  const filteredCashiers = useMemo(() => {
    const query = userQuery.trim().toLowerCase();
    return cashiers.filter((cashier) => {
      const matchesQuery = !query || `${cashier.name} ${cashier.email} ${cashier.phone} ${cashier.id}`.toLowerCase().includes(query);
      const matchesRole = userRoleFilter === "ALL" || cashier.role === userRoleFilter;
      const matchesStatus = userStatusFilter === "ALL" || (userStatusFilter === "ACTIVE" ? cashier.active : !cashier.active);
      return matchesQuery && matchesRole && matchesStatus;
    });
  }, [cashiers, userQuery, userRoleFilter, userStatusFilter]);
  const userFilterCount = [userRoleFilter !== "ALL", userStatusFilter !== "ACTIVE"].filter(Boolean).length;
  const userFilterChips: MobileFilterChip[] = [
    ...(userRoleFilter !== "ALL" ? [{ id: "role", label: formatRoleLabel(userRoleFilter), onRemove: () => setUserRoleFilter("ALL") }] : []),
    ...(userStatusFilter !== "ACTIVE" ? [{ id: "status", label: userStatusFilter === "ALL" ? "All statuses" : "Inactive", onRemove: () => setUserStatusFilter("ACTIVE") }] : []),
  ];
  const adminPasswordMismatch =
    !!adminSecurity.next &&
    !!adminSecurity.confirm &&
    adminSecurity.next !== adminSecurity.confirm;

  function discardAdminChanges() {
    setAdminSecurityError("");

    if (adminTab === "personal") {
      setAdminProfile(adminInitialProfile);
      return;
    }

    setAdminSecurity({ current: "", next: "", confirm: "" });
  }

  async function handleAdminPhotoChange(file?: File | null) {
    if (!file) return;

    const previousPhotoUrl = adminPhotoUrl;
    const previewUrl = URL.createObjectURL(file);
    setAdminPhotoUrl(previewUrl);
    setUploadingAdminPhoto(true);

    try {
      const response = await uploadProfilePhotoApi(file);
      if (response.user) {
        const nextAdminProfile = {
          ...mapUserToAdminProfile(response.user),
          location: adminProfile.location,
          emailVerified: adminProfile.emailVerified,
        };
        setAdminProfile(nextAdminProfile);
        setAdminInitialProfile(nextAdminProfile);
        setAdminPhotoUrl(response.user.profileImage || undefined);
        await syncAuth(response.user);
      }

      showFeedback(
        "success",
        "Photo updated",
        "Your profile photo has been updated.",
      );
    } catch (error: any) {
      setAdminPhotoUrl(previousPhotoUrl);
      showFeedback(
        "error",
        "Could not update photo",
        error?.response?.data?.error || error?.message || "Upload failed.",
      );
    } finally {
      setUploadingAdminPhoto(false);
    }
  }

  async function handleSaveAdminProfile() {
    if (!adminProfile.phone.trim()) {
      showFeedback("error", "Phone required", "Enter the Admin's Nepali mobile number before saving.");
      return;
    }
    try {
      setSavingAdminProfile(true);
      const response = await updateProfileApi({
        name: `${adminProfile.firstName} ${adminProfile.lastName}`.trim(),
        phone: adminProfile.phone,
        gender: adminProfile.gender,
        address: adminProfile.address,
      });
      if (response.user) {
        const nextAdminProfile = {
          ...mapUserToAdminProfile(response.user),
          location: adminProfile.location,
          emailVerified: adminProfile.emailVerified,
        };
        setAdminProfile(nextAdminProfile);
        setAdminInitialProfile(nextAdminProfile);
        setAdminPhotoUrl(response.user.profileImage || adminPhotoUrl);
        await syncAuth(response.user);
        showFeedback(
          "success",
          "Profile updated",
          "Your profile details have been updated.",
        );
      }
    } catch (error: any) {
      showFeedback(
        "error",
        "Could not save profile",
        error?.response?.data?.error ||
        error?.message ||
        "Failed to save profile.",
      );
    } finally {
      setSavingAdminProfile(false);
    }
  }

  async function handleSaveAdminPassword() {
    if (!adminSecurity.current) {
      setAdminSecurityError("Enter your current password to continue.");
      return;
    }
    if (!adminSecurity.next) {
      setAdminSecurityError("Enter the new password.");
      return;
    }
    if (adminSecurity.next.length < 8) {
      setAdminSecurityError("Password must be at least 8 characters.");
      return;
    }
    if (adminSecurity.next !== adminSecurity.confirm) {
      setAdminSecurityError("New password and confirmation must match.");
      return;
    }

    try {
      setSavingAdminPassword(true);
      setAdminSecurityError("");
      await updateProfileApi({
        currentPassword: adminSecurity.current,
        newPassword: adminSecurity.next,
      });
      setAdminSecurity({ current: "", next: "", confirm: "" });
      showFeedback(
        "success",
        "Password updated",
        "Your password has been updated successfully.",
      );
    } catch (error: any) {
      setAdminSecurityError(
        error?.response?.data?.error ||
        error?.message ||
        "Failed to update password.",
      );
    } finally {
      setSavingAdminPassword(false);
    }
  }

  return (
    <div className="w-full pt-0 pb-4">
      <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-12">
        <div className="lg:sticky lg:top-0 lg:col-span-4 lg:self-start">
          <div className="mb-5">
            <h1 className="text-2xl font-bold text-slate-800">
              Account Settings
            </h1>
            <p className="text-slate-500 text-sm">
              Manage your profile, security, and cashier accounts.
            </p>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="space-y-5 px-5 py-6 sm:px-6">
              <div className="flex flex-col items-center text-center">
                <div className="relative inline-flex">
                  <PreviewableImage
                    src={adminPhotoUrl}
                    alt="Admin profile"
                    title={adminDisplayName}
                    subtitle={adminProfile.email || undefined}
                    previewCue="always"
                    className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-full border-4 border-slate-200 bg-slate-100 text-[28px] font-extrabold text-slate-700"
                    fallback={adminInitials || "AD"}
                  />
                  <label
                    className={cn(
                      "absolute bottom-0 right-0 inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border-2 border-white bg-[#11120d] text-white shadow-sm transition hover:bg-black focus-within:ring-2 focus-within:ring-slate-900 focus-within:ring-offset-2",
                      uploadingAdminPhoto && "pointer-events-none opacity-60",
                    )}
                    title="Change profile photo"
                    aria-label="Change profile photo"
                  >
                    <input
                      type="file"
                      className="sr-only"
                      accept="image/*"
                      disabled={uploadingAdminPhoto}
                      onChange={(event) => {
                        handleAdminPhotoChange(event.target.files?.[0]);
                        event.currentTarget.value = "";
                      }}
                    />
                    <Icon
                      name={uploadingAdminPhoto ? "progress_activity" : "photo_camera"}
                      className={cn("text-[17px]", uploadingAdminPhoto && "animate-spin")}
                    />
                  </label>
                </div>
                <div className="text-center mt-4">
                  <h2 className="text-xl font-bold text-slate-800">
                    {adminDisplayName}
                  </h2>
                  <p className="text-slate-500 text-sm">
                    {adminProfile.email || "No email available"}
                  </p>
                  <div className="mt-3 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-100 text-slate-700 text-xs font-semibold border border-slate-200">
                    <div className="w-1.5 h-1.5 rounded-full bg-slate-600"></div>
                    System Administrator
                  </div>
                </div>
              </div>

              <div className="border-t border-slate-100 p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 text-slate-500">
                    <GIcon name="phone" sizePx={16} />
                    <span className="text-sm font-medium">Phone</span>
                  </div>
                  <span className="text-sm font-medium text-slate-800">
                    {adminProfile.phone || "No phone added"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 text-slate-500">
                    <GIcon name="location_on" sizePx={16} />
                    <span className="text-sm font-medium">Region</span>
                  </div>
                  <span className="text-sm font-medium text-slate-800">
                    {adminProfile.location}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 text-slate-500">
                    <GIcon name="schedule" sizePx={16} />
                    <span className="text-sm font-medium">Last login</span>
                  </div>
                  <span className="text-sm font-medium text-slate-800">
                    {formatDateTime(adminProfile.lastLogin)}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <nav className="mt-6 bg-white rounded-xl border border-slate-200 p-2 space-y-1">
            <button
              onClick={() => {
                setAdminTab("personal");
                setAdminSecurityError("");
              }}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-semibold transition-all",
                adminTab === "personal"
                  ? "bg-slate-100 text-slate-900"
                  : "text-slate-600 hover:bg-slate-50"
              )}
            >
              <GIcon name="person" sizePx={16} />
              Personal Information
            </button>
            <button
              onClick={() => {
                setAdminTab("security");
                setAdminSecurityError("");
              }}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-semibold transition-all",
                adminTab === "security"
                  ? "bg-slate-100 text-slate-900"
                  : "text-slate-600 hover:bg-slate-50"
              )}
            >
              <GIcon name="lock" sizePx={16} />
              Login & Password
            </button>
            <button
              onClick={() => {
                setAdminTab("users");
                setAdminSecurityError("");
              }}
              className={cn(
                "w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-semibold transition-all",
                adminTab === "users"
                  ? "bg-slate-100 text-slate-900"
                  : "text-slate-600 hover:bg-slate-50"
              )}
            >
              <GIcon name="group" sizePx={16} />
              Cashier Management
            </button>
          </nav>
        </div>

        <div className="lg:col-span-8 lg:pt-[72px]">
          {adminTab !== "users" ? (
            <ProfilePanel
              title={
                adminTab === "personal" ? "Personal Details" : "Login & Password"
              }
              subtitle={
                adminTab === "personal"
                  ? "Update your contact and account information."
                  : "Change your password and review sign-in security."
              }
            >
              <div className="flex h-full flex-col justify-between p-6">
                <div className="space-y-6">
                  {adminTab === "personal" ? (
                    <>
                      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                        <ProfileField label="First Name">
                          <ProfileTextInput
                            value={adminProfile.firstName}
                            onChange={(value) =>
                              setAdminProfile((current) => ({
                                ...current,
                                firstName: value,
                              }))
                            }
                            placeholder="First name"
                          />
                        </ProfileField>

                        <ProfileField label="Last Name">
                          <ProfileTextInput
                            value={adminProfile.lastName}
                            onChange={(value) =>
                              setAdminProfile((current) => ({
                                ...current,
                                lastName: value,
                              }))
                            }
                            placeholder="Last name"
                          />
                        </ProfileField>

                        <div className="md:col-span-2">
                          <ProfileField label="Email Address" hint="Read-only here">
                            <ProfileTextInput
                              value={adminProfile.email}
                              onChange={() => { }}
                              disabled
                              right={
                                adminProfile.emailVerified ? (
                                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-[10px] font-extrabold uppercase text-emerald-700">
                                    <Icon
                                      name="verified"
                                      className="text-[14px]"
                                    />
                                    Verified
                                  </span>
                                ) : (
                                  <span className="inline-flex rounded-full border border-slate-200 bg-slate-100 px-2 py-1 text-[10px] font-extrabold uppercase text-slate-500">
                                    Sign-in Email
                                  </span>
                                )
                              }
                            />
                          </ProfileField>
                        </div>

                        <ProfileField label="Phone Number">
                          <ProfileTextInput
                            value={adminProfile.phone}
                            onChange={(value) =>
                              setAdminProfile((current) => ({
                                ...current,
                                phone: value,
                              }))
                            }
                            placeholder="+977 98XXXXXXXX"
                          />
                        </ProfileField>

                        <ProfileField label="Gender">
                          <div className="grid grid-cols-2 gap-4">
                            {(["Male", "Female"] as const).map((gender) => (
                              <button
                                key={gender}
                                type="button"
                                onClick={() =>
                                  setAdminProfile((current) => ({
                                    ...current,
                                    gender,
                                  }))
                                }
                                className={cn(
                                  "px-4 py-2.5 rounded-lg font-semibold text-sm transition-all",
                                  adminProfile.gender === gender
                                    ? "border-2 border-[#11120d] bg-[#11120d] text-white"
                                    : "border border-slate-200 text-slate-600 bg-white hover:bg-slate-50",
                                )}
                              >
                                {gender}
                              </button>
                            ))}
                          </div>
                        </ProfileField>

                        <ProfileField
                          label="Country / Region"
                          hint="Stored locally on this device"
                        >
                          <ProfileSelectInput
                            value={adminProfile.location}
                            onChange={(value) =>
                              setAdminProfile((current) => ({
                                ...current,
                                location: value,
                              }))
                            }
                            options={["Nepal", "India", "Other"]}
                          />
                        </ProfileField>

                        <ProfileField label="Home Address">
                          <ProfileTextInput
                            value={adminProfile.address}
                            onChange={(value) =>
                              setAdminProfile((current) => ({
                                ...current,
                                address: value,
                              }))
                            }
                            placeholder="e.g. Kathmandu, Nepal"
                          />
                        </ProfileField>
                      </div>
                    </>
                  ) : (
                    <>
                      {adminSecurityError ? (
                        <div className="rounded-[8px] border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] font-semibold text-rose-700">
                          {adminSecurityError}
                        </div>
                      ) : null}

                      <ProfileField label="Current Password">
                        <ProfileTextInput
                          value={adminSecurity.current}
                          onChange={(value) => {
                            setAdminSecurity((current) => ({
                              ...current,
                              current: value,
                            }));
                            setAdminSecurityError("");
                          }}
                          placeholder="Enter current password"
                          type="password"
                        />
                      </ProfileField>

                      <div className="max-w-xl space-y-6">
                        <ProfileField label="New Password">
                          <ProfileTextInput
                            value={adminSecurity.next}
                            onChange={(value) => {
                              setAdminSecurity((current) => ({
                                ...current,
                                next: value,
                              }));
                              setAdminSecurityError("");
                            }}
                            placeholder="New password"
                            type="password"
                          />
                        </ProfileField>

                        <ProfileField label="Confirm New Password">
                          <ProfileTextInput
                            value={adminSecurity.confirm}
                            onChange={(value) => {
                              setAdminSecurity((current) => ({
                                ...current,
                                confirm: value,
                              }));
                              setAdminSecurityError("");
                            }}
                            placeholder="Repeat new password"
                            type="password"
                          />
                        </ProfileField>
                      </div>

                      {adminPasswordMismatch ? (
                        <div className="rounded-[8px] border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] font-semibold text-rose-700">
                          Passwords do not match.
                        </div>
                      ) : null}

                      <div className="max-w-xl rounded-[8px] border border-slate-200 bg-slate-50/70 p-4">
                        <div className="text-[11px] font-extrabold uppercase text-slate-500">
                          Password Requirements
                        </div>
                        <div className="mt-2 text-[13px] font-medium leading-7 text-slate-600">
                          Use 6 or more characters, mixing letters, numbers, and
                          symbols. Avoid using dictionary words or easily
                          guessable personal information.
                        </div>
                      </div>
                    </>
                  )}
                </div>

                <div className="mt-8 flex flex-wrap items-center justify-end gap-3 border-t border-slate-100 pt-5">
                  <ProfileActionButton
                    icon="restart_alt"
                    label="Discard Changes"
                    onClick={discardAdminChanges}
                    disabled={
                      adminTab === "personal"
                        ? !adminHasProfileChanges || savingAdminProfile
                        : !adminHasSecurityChanges || savingAdminPassword
                    }
                  />
                  <ProfileActionButton
                    icon={adminTab === "security" ? "lock" : "save"}
                    label={
                      adminTab === "security"
                        ? savingAdminPassword
                          ? "Updating..."
                          : "Update Password"
                        : savingAdminProfile
                          ? "Saving..."
                          : "Save Profile"
                    }
                    onClick={
                      adminTab === "security"
                        ? handleSaveAdminPassword
                        : handleSaveAdminProfile
                    }
                    disabled={
                      adminTab === "security"
                        ? savingAdminPassword ||
                        adminPasswordMismatch ||
                        !adminHasSecurityChanges
                        : savingAdminProfile || !adminHasProfileChanges
                    }
                    primary
                  />
                </div>
              </div>
            </ProfilePanel>
          ) : (
            <CardShell>
              <div className="flex items-center justify-between gap-3 border-b border-[#CFCFD3] px-[16px] py-[14px]">
                <SectionTitle
                  title="User Management"
                  sub="Create and manage manager, cashier, and staff accounts."
                />

                <Button
                  variant="primary"
                  icon="person_add"
                  onClick={() => {
                    resetAddForm();
                    setAddOpen(true);
                  }}
                >
                  Add user
                </Button>
              </div>

              <div className="border-b border-[#E5E7EB] bg-[#FAFBFC] p-4">
                <div className="flex gap-2 lg:hidden">
                  <div className="relative min-w-0 flex-1"><Icon name="search" sizePx={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#8C8889]" /><input value={userQuery} onChange={(event) => setUserQuery(event.target.value)} placeholder="Search users..." className="h-[46px] w-full rounded-xl border border-[#CFCFD3] bg-white pl-10 pr-3 text-[13px] font-semibold outline-none focus:border-[#11120d]" /></div>
                  <MobileFilterButton activeCount={userFilterCount} onClick={() => { setDraftUserRoleFilter(userRoleFilter); setDraftUserStatusFilter(userStatusFilter); setMobileUserFiltersOpen(true); }} />
                </div>
                <ActiveFilterChips items={userFilterChips} className="mt-2 lg:hidden" />

                <div className="hidden grid-cols-[minmax(240px,1fr)_220px_220px_auto] items-end gap-3 lg:grid">
                  <label className="space-y-1.5"><span className="text-[10px] font-extrabold uppercase tracking-wide text-[#64748B]">Search users</span><div className="relative"><Icon name="search" sizePx={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#8C8889]" /><input value={userQuery} onChange={(event) => setUserQuery(event.target.value)} placeholder="Name, email, phone, or ID" className="h-11 w-full rounded-xl border border-[#CFCFD3] bg-white pl-10 pr-3 text-[13px] font-semibold outline-none focus:border-[#11120d]" /></div></label>
                  <label className="space-y-1.5"><span className="text-[10px] font-extrabold uppercase tracking-wide text-[#64748B]">Role</span><ProjectSelect value={userRoleFilter} onChange={(event) => setUserRoleFilter(event.target.value as "ALL" | Cashier["role"])}><option value="ALL">All roles</option><option value="MANAGER">Manager</option><option value="CASHIER">Cashier</option><option value="STAFF">Staff</option></ProjectSelect></label>
                  <label className="space-y-1.5"><span className="text-[10px] font-extrabold uppercase tracking-wide text-[#64748B]">Status</span><ProjectSelect value={userStatusFilter} onChange={(event) => setUserStatusFilter(event.target.value as "ALL" | "ACTIVE" | "INACTIVE")}><option value="ALL">All statuses</option><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></ProjectSelect></label>
                  <button type="button" disabled={!userQuery && userFilterCount === 0} onClick={() => { setUserQuery(""); setUserRoleFilter("ALL"); setUserStatusFilter("ACTIVE"); }} className="h-11 rounded-xl border border-[#CFCFD3] bg-white px-4 text-[12px] font-extrabold text-[#565449] disabled:cursor-not-allowed disabled:opacity-40">Clear</button>
                </div>
              </div>

              <div className="hidden lg:block">
                <table className="relative w-full min-w-[760px] border-collapse text-left">
                  <thead className="sticky top-0 z-10 bg-[#F8FAFC]">
                    <tr className="border-b border-[#DADDE3] text-[11px] font-extrabold uppercase tracking-[0.06em] text-[#64748B]">
                      <th className="px-4 py-3">User</th>
                      <th className="px-4 py-3">Contact</th>
                      <th className="px-4 py-3">Last login</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-[#E5E7EB]">
                    {loadingCashiers ? (
                      <tr>
                        <td
                          colSpan={5}
                          className="px-4 py-10 text-center text-[#8C8889]"
                        >
                          Loading user accounts...
                        </td>
                      </tr>
                    ) : filteredCashiers.length === 0 ? (
                      <tr>
                        <td
                          colSpan={5}
                          className="px-4 py-10 text-center text-[#8C8889]"
                        >
                          No user accounts match the current filters.
                        </td>
                      </tr>
                    ) : (
                      filteredCashiers.map((cashier) => (
                        <tr
                          key={cashier.id}
                          className="text-[13px] font-semibold text-[#565449] transition-colors hover:bg-[#ECEFF3]"
                        >
                          <td className="px-4 py-3.5 align-middle">
                            <div className="flex items-center gap-3">
                              <PreviewableImage
                                src={cashier.profileImage}
                                alt={cashier.name}
                                title={cashier.name}
                                subtitle={cashier.email || cashier.phone}
                                className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[8px] border border-[#CFCFD3] bg-[#F3F4F6]"
                                fallback={
                                  <GIcon
                                    name="person"
                                    sizePx={18}
                                    className="text-[#8C8889]"
                                  />
                                }
                              />

                              <div className="min-w-0">
                                <div className="truncate font-extrabold text-[#000000]">
                                  {cashier.name}
                                </div>
                                <div className="mt-1 flex items-center gap-2">
                                  <Badge tone={cashier.role === "MANAGER" ? "blue" : cashier.role === "STAFF" ? "green" : "slate"}>
                                    {formatRoleLabel(cashier.role)}
                                  </Badge>
                                  <span className="max-w-[105px] truncate text-[11px] text-[#8C8889]" title={cashier.id}>
                                    ID: {cashier.id}
                                  </span>
                                </div>
                              </div>
                            </div>
                          </td>

                          <td className="px-4 py-3.5 align-middle">
                            <div className="truncate font-bold text-[#11120d]" title={cashier.email || "No email added"}>
                              {cashier.email || "No email added"}
                            </div>
                            <div className="mt-1 text-[12px] text-[#8C8889]">
                              {cashier.phone || "Not added"}
                            </div>
                          </td>
                          <td className="px-4 py-3.5 align-middle text-[12px] text-[#6B7280]">
                            {cashier.lastLogin}
                          </td>

                          <td className="px-4 py-3.5 align-middle">
                            <Badge tone={cashier.active ? "green" : "slate"}>
                              {cashier.active ? "Active" : "Inactive"}
                            </Badge>
                          </td>

                          <td className="px-4 py-3.5 align-middle">
                            <div className="flex items-center justify-end">
                              <ActionMenu
                                options={[
                                  {
                                    label: "Edit",
                                    icon: "edit",
                                    onClick: () => openEdit(cashier),
                                  },
                                  {
                                    label: cashier.active
                                      ? "Deactivate"
                                      : cashier.phone
                                        ? "Activate"
                                        : "Add phone & activate",
                                    icon: cashier.active ? "block" : "check_circle",
                                    danger: cashier.active,
                                    onClick: () => toggleCashierActive(cashier.id),
                                  },
                                  {
                                    label: "Permanently delete",
                                    icon: "delete_forever",
                                    danger: true,
                                    disabled: cashier.id === currentAdminId,
                                    onClick: () => openDeleteCashier(cashier),
                                  },
                                ]}
                              />
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <div className="space-y-3 p-3 lg:hidden">
                {loadingCashiers ? (
                  <div className="rounded-[16px] border border-[#DADDE3] bg-white px-4 py-8 text-center text-[13px] font-semibold text-slate-500 shadow-sm">
                    Loading user accounts...
                  </div>
                ) : filteredCashiers.length === 0 ? (
                  <div className="rounded-[16px] border border-[#DADDE3] bg-white px-4 py-8 text-center text-[13px] font-semibold text-slate-500 shadow-sm">
                    No user accounts match the current filters.
                  </div>
                ) : (
                  filteredCashiers.map((cashier) => (
                    <article key={cashier.id} className="space-y-4 rounded-[16px] border border-[#DADDE3] bg-white p-4 shadow-sm">
                      <div className="flex min-w-0 items-start gap-3">
                        <PreviewableImage
                          src={cashier.profileImage}
                          alt={cashier.name}
                          title={cashier.name}
                          subtitle={cashier.email || cashier.phone}
                          className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-[8px] border border-slate-200 bg-slate-100"
                          fallback={
                            <GIcon name="person" sizePx={20} className="text-slate-500" />
                          }
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[14px] font-extrabold text-black">
                            {cashier.name}
                          </div>
                          <div className="mt-0.5 truncate text-[12px] font-medium text-slate-500">
                            {cashier.email || "No email added"}
                          </div>
                        </div>
                        <Badge tone={cashier.active ? "green" : "slate"}>
                          {cashier.active ? "Active" : "Inactive"}
                        </Badge>
                      </div>

                      <div className="flex items-center justify-between gap-2">
                        <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-[12px] flex-1">
                          <div>
                            <div className="font-extrabold uppercase text-slate-400">Role</div>
                            <div className="mt-1 font-bold text-slate-800">
                              {formatRoleLabel(cashier.role)}
                            </div>
                          </div>
                          <div>
                            <div className="font-extrabold uppercase text-slate-400">Phone</div>
                            <div className="mt-1 font-bold text-slate-800">
                              {cashier.phone || "Not added"}
                            </div>
                          </div>
                          <div className="col-span-2">
                            <div className="font-extrabold uppercase text-slate-400">Last login</div>
                            <div className="mt-1 font-bold text-slate-800">
                              {cashier.lastLogin}
                            </div>
                          </div>
                        </div>
                        <div className="shrink-0 pr-1">
                          <ActionMenu
                            options={[
                              {
                                label: "Edit",
                                icon: "edit",
                                onClick: () => openEdit(cashier),
                              },
                              {
                                label: cashier.active
                                  ? "Deactivate"
                                  : cashier.phone
                                    ? "Activate"
                                    : "Add phone & activate",
                                icon: cashier.active ? "block" : "check_circle",
                                danger: cashier.active,
                                onClick: () => toggleCashierActive(cashier.id),
                              },
                              {
                                label: "Permanently delete",
                                icon: "delete_forever",
                                danger: true,
                                disabled: cashier.id === currentAdminId,
                                onClick: () => openDeleteCashier(cashier),
                              },
                            ]}
                          />
                        </div>
                      </div>
                    </article>
                  ))
                )}
              </div>
              <MobileFilterSheet
                open={mobileUserFiltersOpen}
                onClose={() => setMobileUserFiltersOpen(false)}
                onClear={() => { setDraftUserRoleFilter("ALL"); setDraftUserStatusFilter("ACTIVE"); }}
                onApply={() => { setUserRoleFilter(draftUserRoleFilter); setUserStatusFilter(draftUserStatusFilter); setMobileUserFiltersOpen(false); }}
                title="User filters"
              >
                <div className="space-y-5">
                  <label className="block space-y-2"><span className="text-[13px] font-bold">Role</span><ProjectSelect value={draftUserRoleFilter} onChange={(event) => setDraftUserRoleFilter(event.target.value as "ALL" | Cashier["role"])}><option value="ALL">All roles</option><option value="MANAGER">Manager</option><option value="CASHIER">Cashier</option><option value="STAFF">Staff</option></ProjectSelect></label>
                  <fieldset className="space-y-2"><legend className="text-[13px] font-bold">Status</legend><div className="grid grid-cols-3 overflow-hidden rounded-xl border border-[#CFCFD3]">{([['ALL', 'All'], ['ACTIVE', 'Active'], ['INACTIVE', 'Inactive']] as const).map(([value, label]) => <button key={value} type="button" onClick={() => setDraftUserStatusFilter(value)} className={cn("min-h-[50px] border-r border-[#CFCFD3] px-2 text-[12px] font-extrabold last:border-r-0", draftUserStatusFilter === value ? "bg-[#11120d] text-white" : "bg-white text-[#565449]")}>{label}</button>)}</div></fieldset>
                </div>
              </MobileFilterSheet>
            </CardShell>
          )}
        </div>
      </div>

      <Modal
        open={addOpen}
        title="Add user"
        onClose={() => {
          setAddOpen(false);
          resetAddForm();
        }}
      >
        <div className="space-y-4">
          <ImageUpload
            label="Profile photo"
            previewUrl={resolveImageUrl(newPhotoUrl)}
            onPick={(file) => {
              setNewPhotoFile(file);
              setNewPhotoUrl(URL.createObjectURL(file));
            }}
            onClear={() => {
              setNewPhotoFile(null);
              setNewPhotoUrl(undefined);
            }}
          />

          <TextField
            label="Full name"
            value={newName}
            onChange={setNewName}
            placeholder="e.g., Sita K."
            error={addFieldErrors.name}
          />
          <TextField
            label="Email (optional)"
            value={newEmail}
            onChange={setNewEmail}
            placeholder="e.g., sita@khatasathi.local"
            error={addFieldErrors.email}
          />
          <TextField
            label="Phone"
            value={newPhone}
            onChange={setNewPhone}
            placeholder="e.g., +977 98XXXXXXXX"
            error={addFieldErrors.phone}
          />
          <SelectField
            label="Gender"
            value={newGender}
            onChange={setNewGender}
            options={[
              { value: "", label: "Select gender" },
              { value: "Male", label: "Male" },
              { value: "Female", label: "Female" },
            ]}
          />
          <TextField
            label="Address"
            value={newAddress}
            onChange={setNewAddress}
            placeholder="e.g., Baneshwor, Kathmandu"
          />
          <SelectField
            label="Role"
            value={newRole}
            onChange={(value) =>
              setNewRole(value === "MANAGER" || value === "STAFF" ? value : "CASHIER")
            }
            options={[
              { value: "CASHIER", label: "Cashier" },
              { value: "MANAGER", label: "Manager" },
              { value: "STAFF", label: "Staff" },
            ]}
          />
          <TextField
            label="Password"
            value={newPassword}
            onChange={setNewPassword}
            type="password"
            error={addFieldErrors.password}
          />
          <TextField
            label="Confirm Password"
            value={newConfirmPassword}
            onChange={setNewConfirmPassword}
            type="password"
            error={addFieldErrors.confirmPassword}
          />

          {addFormError ? (
            <div className="text-[13px] font-bold text-rose-600">
              {addFormError}
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setAddOpen(false);
                resetAddForm();
              }}
            >
              Cancel
            </Button>
            <Button variant="primary" icon="save" onClick={handleAddCashier}>
              Create
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={editOpen} title="Edit user" onClose={closeEdit}>
        <div className="space-y-4">
          <ImageUpload
            label="Profile photo"
            previewUrl={resolveImageUrl(editPhotoUrl)}
            onPick={(file) => {
              setEditPhotoFile(file);
              setEditPhotoRemoved(false);
              setEditPhotoUrl(URL.createObjectURL(file));
            }}
            onClear={() => {
              setEditPhotoFile(null);
              setEditPhotoRemoved(true);
              setEditPhotoUrl(undefined);
            }}
          />

          <TextField
            label="Full name"
            value={editName}
            onChange={setEditName}
            error={editFieldErrors.name}
          />
          <TextField
            label="Email (optional)"
            value={editEmail}
            onChange={setEditEmail}
            error={editFieldErrors.email}
          />
          <TextField
            label="Phone"
            value={editPhone}
            onChange={setEditPhone}
            error={editFieldErrors.phone}
            autoFocus={!editPhone && Boolean(editFieldErrors.phone)}
          />
          <SelectField
            label="Gender"
            value={editGender}
            onChange={setEditGender}
            options={[
              { value: "", label: "Select gender" },
              { value: "Male", label: "Male" },
              { value: "Female", label: "Female" },
            ]}
          />
          <TextField
            label="Address"
            value={editAddress}
            onChange={setEditAddress}
          />
          <SelectField
            label="Role"
            value={editRole}
            onChange={(value) =>
              setEditRole(value === "MANAGER" || value === "STAFF" ? value : "CASHIER")
            }
            options={[
              { value: "CASHIER", label: "Cashier" },
              { value: "MANAGER", label: "Manager" },
              { value: "STAFF", label: "Staff" },
            ]}
          />
          <div className="rounded-[8px] border border-[#CFCFD3] bg-[#F3F4F6] p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[12px] font-extrabold text-[#000000]">
                  Password
                </div>
                <div className="mt-1 text-[12px] font-medium text-[#8C8889]">
                  Only reset it if you want to change this cashier's login
                  password.
                </div>
              </div>
              <Button
                variant="secondary"
                icon="key"
                onClick={() => {
                  setEditWantsPasswordChange((value) => !value);
                  setEditNewPassword("");
                  setEditConfirmPassword("");
                  setEditFieldErrors((current) => ({
                    ...current,
                    newPassword: "",
                    confirmPassword: "",
                  }));
                }}
              >
                {editWantsPasswordChange ? "Cancel Reset" : "Change Password"}
              </Button>
            </div>

            {editWantsPasswordChange ? (
              <div className="mt-3 space-y-4">
                <TextField
                  label="New Password"
                  value={editNewPassword}
                  onChange={setEditNewPassword}
                  type="password"
                  error={editFieldErrors.newPassword}
                />
                <TextField
                  label="Confirm New Password"
                  value={editConfirmPassword}
                  onChange={setEditConfirmPassword}
                  type="password"
                  error={editFieldErrors.confirmPassword}
                />
              </div>
            ) : null}
          </div>

          <label className="inline-flex items-center gap-2 text-[13px] font-semibold text-slate-700 select-none">
            <input
              type="checkbox"
              checked={editActive}
              onChange={(e) => setEditActive(e.target.checked)}
              className="h-[16px] w-[16px]"
            />
            Active
          </label>

          {editFormError ? (
            <div className="text-[13px] font-bold text-rose-600">
              {editFormError}
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={closeEdit}>
              Cancel
            </Button>
            <Button variant="primary" icon="save" onClick={handleSaveEdit}>
              Save
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!pendingDeactivateCashier}
        title="Deactivate staff account?"
        message="This staff member will no longer be able to sign in until the account is reactivated."
        confirmLabel="Deactivate Account"
        onConfirm={confirmDeactivateCashier}
        onClose={() => setPendingDeactivateCashier(null)}
        details={
          pendingDeactivateCashier ? (
            <div className="space-y-1">
              <div className="font-semibold text-slate-700">
                {pendingDeactivateCashier.name}
              </div>
              <div>{pendingDeactivateCashier.email || pendingDeactivateCashier.phone}</div>
            </div>
          ) : null
        }
      />

      <ModalFrame
        open={!!pendingDeleteCashier}
        title="Delete staff account"
        description={
          pendingDeleteCashier
            ? `${pendingDeleteCashier.name} (${pendingDeleteCashier.email || pendingDeleteCashier.phone})`
            : undefined
        }
        onClose={closeDeleteCashier}
        maxWidthClass="max-w-[560px]"
        footer={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <DialogButton onClick={closeDeleteCashier} disabled={deletingCashier}>
              Cancel
            </DialogButton>

            {deleteSafety &&
              !deleteSafety.canPermanentDelete &&
              pendingDeleteCashier?.active ? (
              <DialogButton
                variant="secondary"
                icon="block"
                onClick={() => {
                  const cashier = pendingDeleteCashier;
                  closeDeleteCashier();
                  setPendingDeactivateCashier(cashier);
                }}
                disabled={deletingCashier}
              >
                Set Inactive
              </DialogButton>
            ) : null}

            {deleteSafety?.canPermanentDelete ? (
              <DialogButton
                variant="danger"
                icon="delete_forever"
                onClick={confirmPermanentDeleteCashier}
                disabled={deletingCashier}
              >
                {deletingCashier ? "Deleting..." : "Delete Forever"}
              </DialogButton>
            ) : null}
          </div>
        }
      >
        {deleteSafetyLoading ? (
          <div className="rounded-[8px] border border-[#CFCFD3] bg-[#F3F4F6] px-4 py-3 text-[13px] font-semibold text-[#565449]">
            Checking account history...
          </div>
        ) : deleteSafety?.canPermanentDelete ? (
          <div className="space-y-3">
            <div className="rounded-[8px] border border-emerald-200 bg-emerald-50 px-4 py-3">
              <div className="text-[12px] font-extrabold uppercase text-emerald-700">
                Safe to permanently delete
              </div>
              <div className="mt-1 text-[13px] font-semibold leading-6 text-emerald-800">
                {deleteSafety.safeReason}
              </div>
            </div>

            {deleteSafety.supportCleanup.length > 0 ? (
              <div className="rounded-[8px] border border-[#CFCFD3] bg-white px-4 py-3">
                <div className="text-[12px] font-extrabold uppercase text-[#8C8889]">
                  Also removed with this account
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {deleteSafety.supportCleanup.map((item) => (
                    <span
                      key={item.label}
                      className="rounded-full border border-[#CFCFD3] bg-[#F3F4F6] px-3 py-1 text-[12px] font-bold text-[#565449]"
                    >
                      {item.count} {item.label}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="text-[13px] font-medium leading-6 text-[#565449]">
              This action is only for demo or mistakenly created staff accounts
              with no business history. It cannot be undone.
            </div>
          </div>
        ) : deleteSafety ? (
          <div className="space-y-3">
            <div className="rounded-[8px] border border-amber-200 bg-amber-50 px-4 py-3">
              <div className="text-[12px] font-extrabold uppercase text-amber-700">
                Permanent delete is blocked
              </div>
              <div className="mt-1 text-[13px] font-semibold leading-6 text-amber-800">
                This account has history that should stay attached to reports,
                invoices, documents, or security records.
              </div>
            </div>

            <div className="max-h-[220px] overflow-auto rounded-[8px] border border-[#CFCFD3] bg-white">
              {deleteSafety.references.map((item) => (
                <div
                  key={item.label}
                  className="flex items-center justify-between gap-3 border-b border-[#E5E7EB] px-4 py-3 last:border-b-0"
                >
                  <span className="text-[13px] font-semibold text-[#565449]">
                    {item.label}
                  </span>
                  <span className="rounded-full bg-[#F3F4F6] px-2 py-1 text-[12px] font-extrabold text-[#000000]">
                    {item.count}
                  </span>
                </div>
              ))}
            </div>

            <div className="text-[13px] font-medium leading-6 text-[#565449]">
              Use Set Inactive to remove this staff member from login and daily
              work while preserving history.
            </div>
          </div>
        ) : (
          <div className="rounded-[8px] border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] font-semibold text-rose-700">
            The account history could not be loaded. Try again before deleting.
          </div>
        )}
      </ModalFrame>

      <StatusDialog
        open={feedbackOpen}
        tone={feedbackTone}
        title={feedbackTitle}
        message={feedbackMessage}
        onClose={() => setFeedbackOpen(false)}
        actionLabel="Continue"
      />
    </div>
  );
}
