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
import UserAvatar from "~/components/ui/UserAvatar";
import { setAuthUser } from "~/lib/auth";
import { Link } from "react-router";

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

  const adminInitials =
    me.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || "")
      .join("") || "AD";

  return (
    <div className="space-y-[18px] pb-10">
      <div className="space-y-5 xl:flex xl:items-start xl:gap-5 xl:space-y-0">
        <div className="xl:w-[440px] xl:flex-none">
          <CardShell>
            <div className="border-b border-[#CFCFD3] px-[16px] py-[14px]">
              <SectionTitle
                title="Account overview"
                sub="Photo, role, and sign-in status for this admin account."
              />
            </div>
            <div className="space-y-5 px-[16px] py-[16px]">
              <div className="flex flex-col items-center text-center xl:h-69">
                <UserAvatar
                  src={resolveImageUrl(adminPhotoUrl)}
                  alt="Admin"
                  className="flex h-28 w-28 items-center justify-center overflow-hidden rounded-full border-4 border-[#CFCFD3] bg-[#F3F4F6] text-[30px] font-extrabold text-[#565449]"
                  fallback={adminInitials}
                />

                <div>
                  <div className="mt-4 text-[20px] font-extrabold text-[#000000]">
                    {me.name}
                  </div>
                  <div className="hidden mt-1 text-[13px] font-semibold text-[#8C8889]">
                    Role: <span className="text-slate-700">{me.role}</span> |
                    Last login:{" "}
                    <span className="text-slate-700">{me.lastLogin}</span>
                  </div>
                  <div className="mt-1 text-[13px] font-semibold text-[#8C8889]">
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
                              showFeedback(
                                "success",
                                "Photo updated",
                                "Your profile photo has been updated.",
                              );
                            }
                          } catch (error: any) {
                            showFeedback(
                              "error",
                              "Could not update photo",
                              error?.message || "Upload failed.",
                            );
                          }
                        }}
                      />
                      <span className="inline-flex items-center gap-2 rounded-[12px] border border-[#CFCFD3] bg-white px-3 py-2.5 text-[13px] font-bold text-[#565449] hover:bg-[#F3F4F6]">
                        <GIcon
                          name="photo_camera"
                          sizePx={18}
                          className="text-[#8C8889]"
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
                            showFeedback(
                              "success",
                              "Photo removed",
                              "Your profile photo has been removed.",
                            );
                          }
                        } catch (error: any) {
                          showFeedback(
                            "error",
                            "Could not remove photo",
                            error?.response?.data?.error ||
                              error?.message ||
                              "Failed to clear photo.",
                          );
                        }
                      }}
                    >
                      Remove Photo
                    </Button>
                  </div>
                </div>
              </div>

              <div className="space-y-3 rounded-[18px] border border-[#CFCFD3] bg-[#F3F4F6]/80 p-4 text-[13px] font-semibold text-[#565449]">
                <div className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-2">
                    <GIcon name="badge" sizePx={18} className="text-inherit" />
                    Role
                  </span>
                  <span className="text-right text-[#000000]">{me.role}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-2">
                    <GIcon name="phone" sizePx={18} className="text-inherit" />
                    Phone
                  </span>
                  <span className="text-right text-[#000000]">
                    {me.phone || "No phone added"}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-2">
                    <GIcon
                      name="schedule"
                      sizePx={18}
                      className="text-inherit"
                    />
                    Last login
                  </span>
                  <span className="text-right text-[#000000]">
                    {me.lastLogin}
                  </span>
                </div>
              </div>
            </div>
          </CardShell>
        </div>

        <div className="space-y-[16px] xl:min-w-0 xl:flex-1">
          <CardShell>
            <div className="border-b border-[#CFCFD3] px-[16px] py-[14px]">
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

              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-[#CFCFD3] pt-5">
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
