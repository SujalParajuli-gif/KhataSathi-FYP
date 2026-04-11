import React, { useEffect, useState } from "react";
import {
  createUserApi,
  getMeApi,
  listUsersApi,
  updateProfileApi,
  updateUserApi,
  uploadProfilePhotoApi,
  uploadUserPhotoApi,
} from "~/lib/api/endpoints";
import { API_BASE_URL } from "~/lib/api/baseUrl";
import { ConfirmDialog, StatusDialog } from "~/components/ui/Modal";
import Icon from "~/components/ui/Icon";
import UserAvatar from "~/components/ui/UserAvatar";
import { setAuthUser } from "~/lib/auth";
import { useMemo } from "react";

function formatLastLogin(value?: string | null) {
  return value ? new Date(value).toLocaleString() : "Never";
}

function resolveImageUrl(path?: string | null) {
  if (!path) return undefined;
  if (path.startsWith("blob:")) return path;
  return `${API_BASE_URL}${path}`;
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

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

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[22px] border border-[#CFCFD3] bg-white">
      {children}
    </div>
  );
}

function SectionTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div>
      <h2 className="text-[15px] font-extrabold  text-[#000000]">{title}</h2>
      {sub ? (
        <p className="mt-[3px] text-[12px] font-medium text-[#8C8889]">{sub}</p>
      ) : null}
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  type = "text",
  error,
}: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  type?: string;
  error?: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-extrabold uppercase  text-[#8C8889]">
        {label}
      </div>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.value)}
        className={[
          "w-full rounded-[12px] border bg-white px-3 py-2.5",
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
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={[
          "w-full rounded-[12px] border bg-white px-3 py-2.5",
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
      </select>
      {error ? (
        <div className="text-[12px] font-semibold text-rose-600">{error}</div>
      ) : null}
    </div>
  );
}

function Button({
  variant = "secondary",
  icon,
  children,
  onClick,
  disabled,
}: {
  variant?: "primary" | "secondary" | "danger";
  icon?: string;
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const cls =
    variant === "primary"
      ? "border-[#11120d] bg-[#11120d] text-white hover:bg-[#2a2c27]"
      : variant === "danger"
        ? "border-[#FECDD3] bg-[#FFF1F2] text-[#BE123C] hover:bg-rose-100"
        : "border-[#CFCFD3] bg-white text-[#565449] hover:bg-[#F3F4F6]";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={[
        "inline-flex items-center gap-2 rounded-[12px] border px-3 py-2.5",
        "text-[13px] font-bold transition-all active:scale-[0.98]",
        cls,
        disabled ? "pointer-events-none opacity-50" : "",
      ].join(" ")}
    >
      {icon ? <GIcon name={icon} sizePx={18} className="opacity-90" /> : null}
      {children}
    </button>
  );
}

function Badge({
  tone = "slate",
  children,
}: {
  tone?: "slate" | "green";
  children: React.ReactNode;
}) {
  const cls =
    tone === "green"
      ? "bg-[#EAF8EF] text-[#179B4D] border-[#9DD8B2]"
      : "bg-[#F3F4F6] text-[#565449] border-[#CFCFD3]";

  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-1 text-[11px] font-extrabold uppercase  ${cls}`}
    >
      {children}
    </span>
  );
}

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
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <button
        type="button"
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
        aria-label="Close modal overlay"
        onClick={onClose}
      />

      <div className="relative w-full max-w-[580px] rounded-[16px] border border-[#CFCFD3] bg-white">
        <div className="flex items-center justify-between border-b border-[#CFCFD3] px-5 py-4">
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

        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

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
        <UserAvatar
          src={previewUrl}
          alt="Preview"
          className="flex h-[56px] w-[56px] shrink-0 items-center justify-center overflow-hidden rounded-[16px] border border-[#CFCFD3] bg-[#F3F4F6]"
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
  gender?: string | null;
  address?: string | null;
  active: boolean;
  lastLogin: string;
  profileImage?: string | null;
};

type AdminTabKey = "personal" | "security";

const ADMIN_LOCATION_STORAGE_KEY = "khatasathi_admin_profile_location";

function readStoredAdminLocation() {
  if (typeof window === "undefined") return "Nepal";
  return window.localStorage.getItem(ADMIN_LOCATION_STORAGE_KEY) || "Nepal";
}

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

function formatRoleLabel(role?: string | null) {
  return String(role || "").toLowerCase() === "admin" ? "Admin" : "User";
}

function formatDateTime(value?: string | null) {
  if (!value) return "Not available";
  return new Date(value).toLocaleString();
}

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
    <section className="flex h-full flex-col overflow-hidden rounded-[22px] border border-slate-200 bg-white">
      <div className="flex flex-col gap-3 border-b border-slate-200 px-5 py-4 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="text-[15px] font-extrabold text-slate-900">
            {title}
          </div>
          {subtitle ? (
            <div className="mt-1 text-[12px] font-medium text-slate-500">
              {subtitle}
            </div>
          ) : null}
        </div>
        {actions}
      </div>
      <div className="flex-1">{children}</div>
    </section>
  );
}

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
        "inline-flex h-[42px] items-center justify-center gap-2 rounded-[14px] border px-4 text-[13px] font-extrabold transition disabled:cursor-not-allowed disabled:opacity-50",
        primary
          ? "border-slate-900 bg-slate-900 text-white hover:bg-slate-800"
          : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
      )}
    >
      <Icon name={icon} className="text-[18px]" />
      {label}
    </button>
  );
}

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
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <label className="text-[11px] font-extrabold uppercase text-slate-500">
          {label}
        </label>
        {hint ? (
          <span className="text-[11px] font-semibold text-slate-400">
            {hint}
          </span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

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
        "flex items-center gap-3 rounded-[14px] border bg-white px-4 py-3 transition",
        disabled
          ? "border-slate-200 bg-slate-50 text-slate-400"
          : "border-slate-200 focus-within:border-slate-900",
      )}
    >
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className={cn(
          "w-full bg-transparent text-[14px] font-semibold outline-none placeholder:text-slate-400",
          disabled ? "text-slate-500" : "text-slate-900",
        )}
      />
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

function ProfileSelectInput({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
}) {
  return (
    <div className="rounded-[14px] border border-slate-200 bg-white px-4 py-3 transition focus-within:border-slate-900">
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full appearance-none bg-transparent text-[14px] font-semibold text-slate-900 outline-none"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function ProfilePage() {
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
  const [adminTab, setAdminTab] = useState<AdminTabKey>("personal");

  const [adminPhotoUrl, setAdminPhotoUrl] = useState<string | undefined>(
    undefined,
  );
  const [uploadingAdminPhoto, setUploadingAdminPhoto] = useState(false);
  const [adminSecurity, setAdminSecurity] = useState({
    current: "",
    next: "",
    confirm: "",
  });
  const [adminSecurityError, setAdminSecurityError] = useState("");
  const [savingAdminProfile, setSavingAdminProfile] = useState(false);
  const [savingAdminPassword, setSavingAdminPassword] = useState(false);

  const [cashiers, setCashiers] = useState<Cashier[]>([]);
  const [loadingCashiers, setLoadingCashiers] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackTitle, setFeedbackTitle] = useState("");
  const [feedbackMessage, setFeedbackMessage] = useState("");
  const [feedbackTone, setFeedbackTone] = useState<"success" | "error">(
    "success",
  );

  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newGender, setNewGender] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newConfirmPassword, setNewConfirmPassword] = useState("");
  const [newPhotoUrl, setNewPhotoUrl] = useState<string | undefined>(undefined);
  const [newPhotoFile, setNewPhotoFile] = useState<File | null>(null);
  const [addFormError, setAddFormError] = useState("");
  const [addFieldErrors, setAddFieldErrors] = useState({
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
  });

  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editGender, setEditGender] = useState("");
  const [editAddress, setEditAddress] = useState("");
  const [editNewPassword, setEditNewPassword] = useState("");
  const [editConfirmPassword, setEditConfirmPassword] = useState("");
  const [editActive, setEditActive] = useState(true);
  const [editPhotoUrl, setEditPhotoUrl] = useState<string | undefined>(
    undefined,
  );
  const [editPhotoFile, setEditPhotoFile] = useState<File | null>(null);
  const [editPhotoRemoved, setEditPhotoRemoved] = useState(false);
  const [editWantsPasswordChange, setEditWantsPasswordChange] = useState(false);
  const [editFormError, setEditFormError] = useState("");
  const [editFieldErrors, setEditFieldErrors] = useState({
    name: "",
    email: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [pendingDeactivateCashier, setPendingDeactivateCashier] =
    useState<Cashier | null>(null);

  function mapCashier(user: any): Cashier {
    return {
      id: user.id,
      name: user.name || "Unknown",
      email: user.email || "",
      phone: user.phone || "",
      gender: user.gender || null,
      address: user.address || null,
      active: user.isActive !== false,
      lastLogin: formatLastLogin(user.lastLogin),
      profileImage: user.profileImage || null,
    };
  }

  async function loadCashiers() {
    setLoadingCashiers(true);
    try {
      const users = await listUsersApi({ role: "CASHIER" });
      const rows = Array.isArray(users) ? users : users?.users || [];
      setCashiers(rows.map(mapCashier));
    } finally {
      setLoadingCashiers(false);
    }
  }

  async function syncAuth(user: any) {
    setAuthUser({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      profileImage: user.profileImage,
    });
    window.dispatchEvent(new Event("auth_change"));
  }

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
    async function load() {
      try {
        const data = await getMeApi();
        const user = data.user || data;
        const nextAdminProfile = mapUserToAdminProfile(user);
        setAdminProfile(nextAdminProfile);
        setAdminInitialProfile(nextAdminProfile);
        setAdminPhotoUrl(user.profileImage || undefined);
      } catch {}

      try {
        await loadCashiers();
      } catch {}
    }

    load();
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        ADMIN_LOCATION_STORAGE_KEY,
        adminProfile.location,
      );
    }
  }, [adminProfile.location]);

  function resetAddForm() {
    setNewName("");
    setNewEmail("");
    setNewPhone("");
    setNewGender("");
    setNewAddress("");
    setNewPassword("");
    setNewConfirmPassword("");
    setNewPhotoUrl(undefined);
    setNewPhotoFile(null);
    setAddFormError("");
    setAddFieldErrors({
      name: "",
      email: "",
      password: "",
      confirmPassword: "",
    });
  }

  function openEdit(cashier: Cashier) {
    setEditId(cashier.id);
    setEditName(cashier.name);
    setEditEmail(cashier.email);
    setEditPhone(cashier.phone);
    setEditGender(cashier.gender || "");
    setEditAddress(cashier.address || "");
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
      newPassword: "",
      confirmPassword: "",
    });
    setEditOpen(true);
  }

  function closeEdit() {
    setEditOpen(false);
    setEditId(null);
    setEditName("");
    setEditEmail("");
    setEditPhone("");
    setEditGender("");
    setEditAddress("");
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
      newPassword: "",
      confirmPassword: "",
    });
  }

  function validateAddCashier() {
    const nextErrors = {
      name: "",
      email: "",
      password: "",
      confirmPassword: "",
    };

    if (!newName.trim()) nextErrors.name = "Full name is required.";
    if (!newEmail.trim()) nextErrors.email = "Email is required.";
    else if (!isValidEmail(newEmail.trim()))
      nextErrors.email = "Enter a valid email address.";
    if (!newPassword) nextErrors.password = "Password is required.";
    else if (newPassword.length < 6)
      nextErrors.password = "Password must be at least 6 characters.";
    if (!newConfirmPassword)
      nextErrors.confirmPassword = "Confirm the password.";
    else if (newPassword !== newConfirmPassword)
      nextErrors.confirmPassword = "Passwords do not match.";

    setAddFieldErrors(nextErrors);
    return !Object.values(nextErrors).some(Boolean);
  }

  function validateEditCashier() {
    const nextErrors = {
      name: "",
      email: "",
      newPassword: "",
      confirmPassword: "",
    };

    if (!editName.trim()) nextErrors.name = "Full name is required.";
    if (!editEmail.trim()) nextErrors.email = "Email is required.";
    else if (!isValidEmail(editEmail.trim()))
      nextErrors.email = "Enter a valid email address.";

    const wantsPasswordChange = editWantsPasswordChange;

    if (wantsPasswordChange) {
      if (!editNewPassword) nextErrors.newPassword = "Enter the new password.";
      else if (editNewPassword.length < 6)
        nextErrors.newPassword = "Password must be at least 6 characters.";
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
        email: newEmail.trim(),
        phone: newPhone.trim(),
        gender: newGender || undefined,
        address: newAddress.trim() || undefined,
        password: newPassword,
        role: "CASHIER",
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
        "Cashier added",
        newPhotoFile
          ? "The cashier account and profile photo have been added successfully."
          : "The cashier account has been added successfully.",
      );
    } catch (error: any) {
      console.error(error);
      const message =
        error.response?.data?.error ||
        error?.message ||
        "Error adding cashier.";
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
        email: editEmail.trim(),
        phone: editPhone.trim(),
        gender: editGender || null,
        address: editAddress.trim(),
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
        wantsPasswordChange ? "Password updated" : "Cashier updated",
        wantsPasswordChange
          ? "The cashier password has been updated successfully."
          : editPhotoRemoved
            ? "The cashier profile has been updated and the photo has been removed."
            : editPhotoFile
              ? "The cashier profile and photo have been updated successfully."
              : "The cashier profile has been updated successfully.",
      );
    } catch (error: any) {
      console.error(error);
      const message =
        error.response?.data?.error ||
        error?.message ||
        "Error updating cashier.";
      setEditFormError(message);
      showFeedback("error", "Could not update cashier", message);
    }
  }

  async function toggleCashierActive(id: string) {
    const cashier = cashiers.find((item) => item.id === id);
    if (!cashier) return;

    if (cashier.active) {
      setPendingDeactivateCashier(cashier);
      return;
    }

    try {
      await updateUserApi(id, { isActive: true });
      await loadCashiers();
      showFeedback(
        "success",
        "Cashier activated",
        "The cashier account has been activated successfully.",
      );
    } catch (error: any) {
      showFeedback(
        "error",
        "Could not activate cashier",
        error?.response?.data?.error ||
          error?.message ||
          "Failed to activate the cashier account.",
      );
    }
  }

  async function confirmDeactivateCashier() {
    if (!pendingDeactivateCashier) return;

    try {
      await updateUserApi(pendingDeactivateCashier.id, { isActive: false });
      await loadCashiers();
      showFeedback(
        "success",
        "Cashier deactivated",
        "The cashier account has been deactivated successfully.",
      );
      setPendingDeactivateCashier(null);
    } catch (error: any) {
      showFeedback(
        "error",
        "Could not deactivate cashier",
        error?.response?.data?.error ||
          error?.message ||
          "Failed to deactivate the cashier account.",
      );
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
    if (adminSecurity.next.length < 6) {
      setAdminSecurityError("Password must be at least 6 characters.");
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
    <div className="space-y-5 pb-10 text-slate-900">
      <div className="space-y-5 xl:flex xl:items-start xl:gap-5 xl:space-y-0">
        <div className="xl:w-[450px] xl:h-[700px] xl:flex-none">
          <ProfilePanel
            title="Account Overview"
            subtitle="Photo, contact, and sign-in for this admin account."
          >
            <div className="space-y-5 px-5 py-5">
              <div className="flex flex-col items-center text-center">
                <UserAvatar
                  src={resolveImageUrl(adminPhotoUrl)}
                  alt="Admin profile"
                  className="flex h-28 w-28 items-center justify-center overflow-hidden rounded-full border-4 border-slate-200 bg-slate-100 text-[30px] font-extrabold text-slate-700"
                  fallback={adminInitials || "AD"}
                />
                <div className="mt-4 text-[20px] font-extrabold text-slate-900">
                  {adminDisplayName}
                </div>
                <div className="mt-1 text-[13px] font-semibold text-slate-500">
                  {adminProfile.email || "No email available"}
                </div>
                <div className="mt-3">
                  <label className="cursor-pointer">
                    <input
                      type="file"
                      className="hidden"
                      accept="image/*"
                      onChange={(event) =>
                        handleAdminPhotoChange(event.target.files?.[0])
                      }
                    />
                    <span
                      className={cn(
                        "inline-flex h-[42px] items-center justify-center gap-2 rounded-[14px] border px-4 text-[13px] font-extrabold transition",
                        uploadingAdminPhoto
                          ? "border-slate-200 bg-slate-100 text-slate-400"
                          : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
                      )}
                    >
                      <Icon name="photo_camera" className="text-[18px]" />
                      {uploadingAdminPhoto ? "Uploading..." : "Change Photo"}
                    </span>
                  </label>
                </div>
              </div>

              <div className="space-y-5 rounded-[18px] border border-slate-200 bg-slate-50/70 p-10 text-[13px] font-semibold text-slate-600 xl:h-[200px] xl:mt-20">
                <div className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-2">
                    <Icon name="phone" className="text-[18px]" /> Phone
                  </span>
                  <span className="text-right text-slate-900">
                    {adminProfile.phone || "No phone added"}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-2">
                    <Icon name="location_on" className="text-[18px]" /> Region
                  </span>
                  <span className="text-right text-slate-900">
                    {adminProfile.location}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-2">
                    <Icon name="schedule" className="text-[18px]" /> Last
                    login
                  </span>
                  <span className="text-right text-slate-900">
                    {formatDateTime(adminProfile.lastLogin)}
                  </span>
                </div>
              </div>
            </div>
          </ProfilePanel>
        </div>

        <div className="xl:min-w-0 xl:flex-1">
          <ProfilePanel
            title={
              adminTab === "personal" ? "Personal Details" : "Login & Password"
            }
            subtitle={
              adminTab === "personal"
                ? "Update the same profile fields already available on this page."
                : "Keep the current password fields, password guidance, and save flow."
            }
            actions={
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setAdminTab("personal");
                    setAdminSecurityError("");
                  }}
                  className={cn(
                    "rounded-full border px-4 py-2 text-[12px] font-extrabold transition",
                    adminTab === "personal"
                      ? "border-slate-900 bg-slate-900 text-white"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
                  )}
                >
                  Personal Information
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAdminTab("security");
                    setAdminSecurityError("");
                  }}
                  className={cn(
                    "rounded-full border px-4 py-2 text-[12px] font-extrabold transition",
                    adminTab === "security"
                      ? "border-slate-900 bg-slate-900 text-white"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
                  )}
                >
                  Login & Password
                </button>
              </div>
            }
          >
            <div className="flex h-full flex-col justify-between space-y-6 px-5 py-5">
              <div className="space-y-6">
                {adminTab === "personal" ? (
                  <>
                    <ProfileField label="Gender">
                      <div className="flex flex-wrap gap-3">
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
                              "rounded-[14px] border px-6 py-3 text-[13px] font-extrabold transition",
                              adminProfile.gender === gender
                                ? "border-slate-900 bg-slate-900 text-white"
                                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
                            )}
                          >
                            {gender}
                          </button>
                        ))}
                      </div>
                    </ProfileField>

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
                            onChange={() => {}}
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

                      <div className="md:col-span-2">
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
                    </div>
                  </>
                ) : (
                  <>
                    {adminSecurityError ? (
                      <div className="rounded-[16px] border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] font-semibold text-rose-700">
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

                    <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
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
                      <div className="rounded-[16px] border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] font-semibold text-rose-700">
                        Passwords do not match.
                      </div>
                    ) : null}

                    <div className="rounded-[18px] border border-slate-200 bg-slate-50/70 p-5">
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
        </div>
      </div>

      <CardShell>
        <div className="flex items-center justify-between gap-3 border-b border-[#CFCFD3] px-[16px] py-[14px]">
          <SectionTitle
            title="Manage cashiers"
            sub="Create, edit, activate/deactivate, and review cashier accounts."
          />

          <Button
            variant="primary"
            icon="person_add"
            onClick={() => {
              resetAddForm();
              setAddOpen(true);
            }}
          >
            Add cashier
          </Button>
        </div>

        <div className="p-[12px] overflow-x-auto">
          <table className="w-full min-w-[860px] text-left">
            <thead>
              <tr className="text-[11px] font-extrabold uppercase  text-[#8C8889]">
                <th className="px-3 py-3">Cashier</th>
                <th className="px-3 py-3">Email</th>
                <th className="px-3 py-3">Phone</th>
                <th className="px-3 py-3">Last login</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3 text-right">Action</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-[#CFCFD3]">
              {loadingCashiers ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-8 text-center text-[#8C8889]"
                  >
                    Loading cashier accounts...
                  </td>
                </tr>
              ) : cashiers.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-8 text-center text-[#8C8889]"
                  >
                    No cashier accounts found.
                  </td>
                </tr>
              ) : (
                cashiers.map((cashier) => (
                  <tr
                    key={cashier.id}
                    className="text-[13px] font-semibold text-[#565449]"
                  >
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-3">
                        <UserAvatar
                          src={resolveImageUrl(cashier.profileImage)}
                          alt={cashier.name}
                          className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-[12px] border border-[#CFCFD3] bg-[#F3F4F6]"
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
                          <div className="text-[12px] text-[#8C8889]">
                            ID: {cashier.id}
                          </div>
                        </div>
                      </div>
                    </td>

                    <td className="px-3 py-3">{cashier.email}</td>
                    <td className="px-3 py-3">{cashier.phone || "—"}</td>
                    <td className="px-3 py-3 text-[#8C8889]">
                      {cashier.lastLogin}
                    </td>

                    <td className="px-3 py-3">
                      <Badge tone={cashier.active ? "green" : "slate"}>
                        {cashier.active ? "Active" : "Inactive"}
                      </Badge>
                    </td>

                    <td className="px-3 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="secondary"
                          icon="edit"
                          onClick={() => openEdit(cashier)}
                        >
                          Edit
                        </Button>

                        <Button
                          variant={cashier.active ? "danger" : "secondary"}
                          icon={cashier.active ? "block" : "check_circle"}
                          onClick={() => toggleCashierActive(cashier.id)}
                        >
                          {cashier.active ? "Deactivate" : "Activate"}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </CardShell>

      <Modal
        open={addOpen}
        title="Add cashier"
        onClose={() => {
          setAddOpen(false);
          resetAddForm();
        }}
      >
        <div className="space-y-4">
          <ImageUpload
            label="Cashier photo"
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
            label="Email"
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

      <Modal open={editOpen} title="Edit cashier" onClose={closeEdit}>
        <div className="space-y-4">
          <ImageUpload
            label="Cashier photo"
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
            label="Email"
            value={editEmail}
            onChange={setEditEmail}
            error={editFieldErrors.email}
          />
          <TextField label="Phone" value={editPhone} onChange={setEditPhone} />
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
          <div className="rounded-[14px] border border-[#CFCFD3] bg-[#F3F4F6] p-3">
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
        title="Deactivate cashier account?"
        message="This cashier will no longer be able to sign in or access billing features until the account is reactivated."
        confirmLabel="Deactivate Account"
        onConfirm={confirmDeactivateCashier}
        onClose={() => setPendingDeactivateCashier(null)}
        details={
          pendingDeactivateCashier ? (
            <div className="space-y-1">
              <div className="font-semibold text-slate-700">
                {pendingDeactivateCashier.name}
              </div>
              <div>{pendingDeactivateCashier.email}</div>
            </div>
          ) : null
        }
      />

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
