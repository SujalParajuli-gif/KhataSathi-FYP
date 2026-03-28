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
import { ConfirmDialog, SuccessDialog } from "~/components/ui/Modal";
import { setAuthUser } from "~/lib/auth";
import { Link } from "react-router";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";

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
    <div className="overflow-hidden rounded-[22px] border border-[var(--app-border)] bg-white shadow-[0_18px_45px_-38px_rgba(17,18,13,0.45)]">
      {children}
    </div>
  );
}

function SectionTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div>
      <h2 className="text-[15px] font-extrabold tracking-tight text-[var(--app-text)]">
        {title}
      </h2>
      {sub ? (
        <p className="mt-[3px] text-[12px] font-medium text-[var(--app-text-muted)]">{sub}</p>
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
      <div className="text-[11px] font-extrabold uppercase tracking-wider text-[var(--app-text-muted)]">{label}</div>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.value)}
        className={[
          "w-full rounded-[12px] border bg-white px-3 py-2.5",
          "text-[13px] font-semibold text-[var(--app-text)] outline-none",
          "placeholder:text-[var(--app-text-muted)]",
          disabled
            ? "border-[var(--app-border)] bg-[var(--app-surface-muted)] text-[var(--app-text-muted)]"
            : error
              ? "border-rose-300 focus:border-rose-400"
              : "border-[var(--app-border)] focus:border-[#11120d]",
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
      <div className="text-[11px] font-extrabold uppercase tracking-wider text-[var(--app-text-muted)]">{label}</div>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={[
          "w-full rounded-[12px] border bg-white px-3 py-2.5",
          "text-[13px] font-semibold text-[var(--app-text)] outline-none",
          error
            ? "border-rose-300 focus:border-rose-400"
            : "border-[var(--app-border)] focus:border-[#11120d]",
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
        ? "border-[var(--app-danger-border)] bg-[var(--app-danger-bg)] text-[var(--app-danger-text)] hover:bg-rose-100"
        : "border-[var(--app-border)] bg-white text-[var(--app-text-soft)] hover:bg-[var(--app-surface-muted)]";

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
      ? "bg-[var(--app-success-bg)] text-[var(--app-success-text)] border-[var(--app-success-border)]"
      : "bg-[var(--app-surface-muted)] text-[var(--app-text-soft)] border-[var(--app-border)]";

  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-1 text-[11px] font-extrabold uppercase tracking-wide ${cls}`}
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

      <div className="relative w-full max-w-[580px] rounded-[16px] border border-[var(--app-border)] bg-white shadow-[0_30px_90px_-45px_rgba(17,18,13,0.65)]">
        <div className="flex items-center justify-between border-b border-[var(--app-border)] px-5 py-4">
          <div className="text-[14px] font-extrabold text-[var(--app-text)]">
            {title}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 items-center justify-center rounded-[12px] border border-[var(--app-border)] bg-white hover:bg-[var(--app-surface-muted)]"
            aria-label="Close modal"
          >
            <GIcon name="close" sizePx={18} className="text-[var(--app-text-soft)]" />
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
      <div className="text-[11px] font-extrabold uppercase tracking-wider text-[var(--app-text-muted)]">{label}</div>

      <div className="flex items-center gap-3">
        <div className="flex h-[56px] w-[56px] shrink-0 items-center justify-center overflow-hidden rounded-[16px] border border-[var(--app-border)] bg-[var(--app-surface-muted)]">
          {previewUrl ? (
            <img
              src={previewUrl}
              alt="Preview"
              className="h-full w-full object-cover"
            />
          ) : (
            <GIcon name="person" sizePx={22} className="text-[var(--app-text-muted)]" />
          )}
        </div>

        <label className="inline-flex cursor-pointer items-center gap-2 rounded-[12px] border border-[var(--app-border)] bg-white px-3 py-2.5 text-[13px] font-bold text-[var(--app-text-soft)] hover:bg-[var(--app-surface-muted)]">
          <GIcon name="upload" sizePx={18} className="text-[var(--app-text-muted)]" />
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
          className="inline-flex items-center gap-2 rounded-[12px] border border-[var(--app-border)] bg-white px-3 py-2.5 text-[13px] font-bold text-[var(--app-text-soft)] hover:bg-[var(--app-surface-muted)]"
        >
          <GIcon name="delete" sizePx={18} className="text-[var(--app-text-muted)]" />
          Remove
        </button>
      </div>
    </div>
  );
}

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

export default function ProfilePage() {
  const [me, setMe] = useState({
    name: "Admin User",
    role: "admin",
    lastLogin: "Never",
    email: "admin@khatasathi.local",
    phone: "+977 98XXXXXXXX",
  });

  const [adminPhotoUrl, setAdminPhotoUrl] = useState<string | undefined>(
    undefined,
  );

  const [cashiers, setCashiers] = useState<Cashier[]>([]);
  const [loadingCashiers, setLoadingCashiers] = useState(false);
  const [profileSuccessOpen, setProfileSuccessOpen] = useState(false);
  const [profileSuccessMessage, setProfileSuccessMessage] = useState("");

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
  const [editCurrentPassword, setEditCurrentPassword] = useState("");
  const [editNewPassword, setEditNewPassword] = useState("");
  const [editConfirmPassword, setEditConfirmPassword] = useState("");
  const [editActive, setEditActive] = useState(true);
  const [editPhotoUrl, setEditPhotoUrl] = useState<string | undefined>(
    undefined,
  );
  const [editPhotoFile, setEditPhotoFile] = useState<File | null>(null);
  const [editPhotoRemoved, setEditPhotoRemoved] = useState(false);
  const [editFormError, setEditFormError] = useState("");
  const [editFieldErrors, setEditFieldErrors] = useState({
    name: "",
    email: "",
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [pendingDeactivateCashier, setPendingDeactivateCashier] = useState<Cashier | null>(null);

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

  useEffect(() => {
    async function load() {
      try {
        const data = await getMeApi();
        const user = data.user || data;
        setMe({
          name: user.name || "Admin User",
          role: user.role || "admin",
          lastLogin: formatLastLogin(user.lastLogin),
          email: user.email || "",
          phone: user.phone || "",
        });
        setAdminPhotoUrl(user.profileImage || undefined);
      } catch {}

      try {
        await loadCashiers();
      } catch {}
    }

    load();
  }, []);

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
    setEditCurrentPassword("");
    setEditNewPassword("");
    setEditConfirmPassword("");
    setEditActive(cashier.active);
    setEditPhotoUrl(cashier.profileImage || undefined);
    setEditPhotoFile(null);
    setEditPhotoRemoved(false);
    setEditFormError("");
    setEditFieldErrors({
      name: "",
      email: "",
      currentPassword: "",
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
    setEditCurrentPassword("");
    setEditNewPassword("");
    setEditConfirmPassword("");
    setEditActive(true);
    setEditPhotoUrl(undefined);
    setEditPhotoFile(null);
    setEditPhotoRemoved(false);
    setEditFormError("");
    setEditFieldErrors({
      name: "",
      email: "",
      currentPassword: "",
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
      currentPassword: "",
      newPassword: "",
      confirmPassword: "",
    };

    if (!editName.trim()) nextErrors.name = "Full name is required.";
    if (!editEmail.trim()) nextErrors.email = "Email is required.";
    else if (!isValidEmail(editEmail.trim()))
      nextErrors.email = "Enter a valid email address.";

    const wantsPasswordChange =
      !!editCurrentPassword || !!editNewPassword || !!editConfirmPassword;

    if (wantsPasswordChange) {
      if (!editCurrentPassword)
        nextErrors.currentPassword = "Enter the current password.";
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
    } catch (error: any) {
      console.error(error);
      setAddFormError(
        error.response?.data?.error ||
          error?.message ||
          "Error adding cashier.",
      );
    }
  }

  async function handleSaveEdit() {
    if (!editId || !validateEditCashier()) return;

    try {
      setEditFormError("");
      const wantsPasswordChange =
        !!editCurrentPassword || !!editNewPassword || !!editConfirmPassword;

      await updateUserApi(editId, {
        name: editName.trim(),
        email: editEmail.trim(),
        phone: editPhone.trim(),
        gender: editGender || null,
        address: editAddress.trim(),
        isActive: editActive,
        ...(wantsPasswordChange
          ? {
              currentPassword: editCurrentPassword,
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
    } catch (error: any) {
      console.error(error);
      setEditFormError(
        error.response?.data?.error ||
          error?.message ||
          "Error updating cashier.",
      );
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
    } catch {
      alert("Failed to toggle status");
    }
  }

  async function confirmDeactivateCashier() {
    if (!pendingDeactivateCashier) return;

    try {
      await updateUserApi(pendingDeactivateCashier.id, { isActive: false });
      await loadCashiers();
      setPendingDeactivateCashier(null);
    } catch {
      alert("Failed to toggle status");
    }
  }

  const adminInitials =
    me.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || "")
      .join("") || "AD";

  return (
    <div className="space-y-[18px] pb-10">
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[340px_1fr]">
        <CardShell>
          <div className="border-b border-[var(--app-border)] px-[16px] py-[14px]">
            <SectionTitle
              title="Account overview"
              sub="Photo, role, and sign-in status for this admin account."
            />
          </div>
          <div className="space-y-5 px-[16px] py-[16px]">
            <div className="flex flex-col items-center text-center">
            <div className="flex h-28 w-28 items-center justify-center overflow-hidden rounded-full border-4 border-[var(--app-border)] bg-[var(--app-surface-muted)] text-[30px] font-extrabold text-[var(--app-text-soft)]">
              {adminPhotoUrl ? (
                <img
                  src={resolveImageUrl(adminPhotoUrl)}
                  alt="Admin"
                  className="h-full w-full object-cover"
                />
              ) : (
                adminInitials
              )}
            </div>

            <div>
              <div className="mt-4 text-[20px] font-extrabold text-[var(--app-text)]">
                {me.name}
              </div>
              <div className="hidden mt-1 text-[13px] font-semibold text-[var(--app-text-muted)]">
                Role: <span className="text-slate-700">{me.role}</span> · Last
                login: <span className="text-slate-700">{me.lastLogin}</span>
              </div>
              <div className="mt-1 text-[13px] font-semibold text-[var(--app-text-muted)]">
                {me.email || "No email available"}
              </div>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                <label className="cursor-pointer">
                  <input
                    type="file"
                    className="hidden"
                    accept="image/*"
                    onChange={async (event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      const previewUrl = URL.createObjectURL(file);
                      setAdminPhotoUrl(previewUrl);
                      try {
                        const response = await uploadProfilePhotoApi(file);
                        if (response.user) {
                          setAdminPhotoUrl(
                            response.user.profileImage || undefined,
                          );
                          await syncAuth(response.user);
                          setProfileSuccessMessage(
                            "Your profile photo has been updated.",
                          );
                          setProfileSuccessOpen(true);
                        }
                      } catch {
                        alert("Upload failed");
                      }
                    }}
                  />
                  <span className="inline-flex items-center gap-2 rounded-[12px] border border-[var(--app-border)] bg-white px-3 py-2.5 text-[13px] font-bold text-[var(--app-text-soft)] hover:bg-[var(--app-surface-muted)]">
                    <GIcon
                      name="photo_camera"
                      sizePx={18}
                      className="text-[var(--app-text-muted)]"
                    />
                    Change Photo
                  </span>
                </label>
                <Button
                  variant="secondary"
                  icon="delete"
                  onClick={async () => {
                    try {
                      const response = await updateProfileApi({
                        profileImage: null,
                      });
                      if (response.user) {
                        setAdminPhotoUrl(undefined);
                        await syncAuth(response.user);
                        setProfileSuccessMessage(
                          "Your profile photo has been removed.",
                        );
                        setProfileSuccessOpen(true);
                      }
                    } catch {
                      alert("Failed to clear photo");
                    }
                  }}
                >
                  Remove Photo
                </Button>
              </div>
            </div>
          </div>

          <div className="space-y-3 rounded-[18px] border border-[var(--app-border)] bg-[var(--app-surface-muted)]/80 p-4 text-[13px] font-semibold text-[var(--app-text-soft)]">
            <div className="flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-2">
                <GIcon name="badge" sizePx={18} className="text-inherit" />
                Role
              </span>
              <span className="text-right text-[var(--app-text)]">{me.role}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-2">
                <GIcon name="phone" sizePx={18} className="text-inherit" />
                Phone
              </span>
              <span className="text-right text-[var(--app-text)]">
                {me.phone || "No phone added"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-2">
                <GIcon name="schedule" sizePx={18} className="text-inherit" />
                Last login
              </span>
              <span className="text-right text-[var(--app-text)]">
                {me.lastLogin}
              </span>
            </div>
          </div>
        </div>
      </CardShell>

      <div className="space-y-[16px]">
        <CardShell>
          <div className="border-b border-[var(--app-border)] px-[16px] py-[14px]">
            <SectionTitle
              title="Personal details"
              sub="Update the same admin profile fields already supported in this workspace."
            />
          </div>

          <div className="flex h-full flex-col justify-between gap-6 p-[16px]">
            <TextField label="Email" value={me.email} disabled />
            <TextField
              label="Name"
              value={me.name}
              onChange={(value) =>
                setMe((current) => ({ ...current, name: value }))
              }
            />
            <TextField
              label="Phone"
              value={me.phone}
              onChange={(value) =>
                setMe((current) => ({ ...current, phone: value }))
              }
            />
            <TextField label="Role" value={me.role} disabled />

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--app-border)] pt-5">
              <Button variant="secondary" icon="key" disabled>
                Change password
              </Button>
              <Link to="/logout">
                <Button variant="danger" icon="logout">
                  Logout
                </Button>
              </Link>
              <Button
                variant="primary"
                icon="save"
                onClick={async () => {
                  try {
                    const response = await updateProfileApi({
                      name: me.name,
                      phone: me.phone,
                    });
                    if (response.user) {
                      setAdminPhotoUrl(
                        response.user.profileImage || adminPhotoUrl,
                      );
                      await syncAuth(response.user);
                      setProfileSuccessMessage(
                        "Your profile details have been updated.",
                      );
                      setProfileSuccessOpen(true);
                    }
                  } catch {
                    alert("Failed to save profile");
                  }
                }}
              >
                Save Profile
              </Button>
            </div>
          </div>
        </CardShell>
      </div>
      </div>

      <CardShell>
        <div className="flex items-center justify-between gap-3 border-b border-[var(--app-border)] px-[16px] py-[14px]">
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
              <tr className="text-[11px] font-extrabold uppercase tracking-wider text-[var(--app-text-muted)]">
                <th className="px-3 py-3">Cashier</th>
                <th className="px-3 py-3">Email</th>
                <th className="px-3 py-3">Phone</th>
                <th className="px-3 py-3">Last login</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3 text-right">Action</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-[var(--app-border)]">
              {loadingCashiers ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-8 text-center text-[var(--app-text-muted)]"
                  >
                    Loading cashier accounts...
                  </td>
                </tr>
              ) : cashiers.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-8 text-center text-[var(--app-text-muted)]"
                  >
                    No cashier accounts found.
                  </td>
                </tr>
              ) : (
                cashiers.map((cashier) => (
                  <tr
                    key={cashier.id}
                    className="text-[13px] font-semibold text-[var(--app-text-soft)]"
                  >
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-[12px] border border-[var(--app-border)] bg-[var(--app-surface-muted)]">
                          {cashier.profileImage ? (
                            <img
                              src={resolveImageUrl(cashier.profileImage)}
                              alt={cashier.name}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <GIcon
                              name="person"
                              sizePx={18}
                              className="text-[var(--app-text-muted)]"
                            />
                          )}
                        </div>

                        <div className="min-w-0">
                          <div className="truncate font-extrabold text-[var(--app-text)]">
                            {cashier.name}
                          </div>
                          <div className="text-[12px] text-[var(--app-text-muted)]">
                            ID: {cashier.id}
                          </div>
                        </div>
                      </div>
                    </td>

                    <td className="px-3 py-3">{cashier.email}</td>
                    <td className="px-3 py-3">{cashier.phone || "—"}</td>
                    <td className="px-3 py-3 text-[var(--app-text-muted)]">
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
          <TextField
            label="Previous Password"
            value={editCurrentPassword}
            onChange={setEditCurrentPassword}
            type="password"
            error={editFieldErrors.currentPassword}
          />
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
              <div className="font-semibold text-slate-700">{pendingDeactivateCashier.name}</div>
              <div>{pendingDeactivateCashier.email}</div>
            </div>
          ) : null
        }
      />

      <SuccessDialog
        open={profileSuccessOpen}
        title="Profile updated"
        message={profileSuccessMessage}
        onClose={() => setProfileSuccessOpen(false)}
        actionLabel="Continue"
      />
    </div>
  );
}
