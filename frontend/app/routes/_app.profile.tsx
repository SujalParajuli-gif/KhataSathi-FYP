import React, { useEffect, useMemo, useState } from "react";
import { getMeApi, listAuditLogsApi, listUsersApi, createUserApi, updateUserApi, updateProfileApi, uploadProfilePhotoApi } from "~/lib/api/endpoints";
import { setAuthUser } from "~/lib/auth";
import { Link } from "react-router";

/* Material Symbols helper */
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

/* Basic card */
function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[16px] bg-white border border-slate-200/60 shadow-sm">
      {children}
    </div>
  );
}

/* Section heading */
function SectionTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div>
      <h2 className="text-[14px] font-bold text-slate-900 tracking-tight">
        {title}
      </h2>
      {sub ? (
        <p className="mt-[3px] text-[12px] font-medium text-slate-500">{sub}</p>
      ) : null}
    </div>
  );
}

/* Text input */
function TextField({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  type = "text",
}: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  type?: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-[12px] font-semibold text-slate-500">{label}</div>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.value)}
        className={[
          "w-full rounded-[12px] border border-slate-200 bg-white px-3 py-2.5",
          "text-[13px] font-semibold text-slate-800 outline-none",
          "placeholder:text-slate-400",
          disabled ? "bg-slate-50 text-slate-500" : "focus:border-slate-300",
        ].join(" ")}
      />
    </div>
  );
}

/* Buttons */
function Button({
  variant = "secondary",
  icon,
  children,
  onClick,
}: {
  variant?: "primary" | "secondary" | "danger";
  icon?: string;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  const cls =
    variant === "primary"
      ? "bg-orange-600 text-white hover:bg-orange-700 border-orange-600 shadow-sm shadow-orange-200"
      : variant === "danger"
        ? "bg-white text-rose-600 border-rose-200 hover:bg-rose-50"
        : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50";

  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "inline-flex items-center gap-2 rounded-[12px] border px-3 py-2.5",
        "text-[13px] font-bold transition-all active:scale-[0.98]",
        cls,
      ].join(" ")}
    >
      {icon ? <GIcon name={icon} sizePx={18} className="opacity-90" /> : null}
      {children}
    </button>
  );
}

/* Small badge */
function Badge({
  tone = "slate",
  children,
}: {
  tone?: "slate" | "green";
  children: React.ReactNode;
}) {
  const cls =
    tone === "green"
      ? "bg-emerald-50 text-emerald-700 border-emerald-100"
      : "bg-slate-100 text-slate-700 border-slate-200";

  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-1 text-[11px] font-extrabold uppercase tracking-wide ${cls}`}
    >
      {children}
    </span>
  );
}

/* Simple modal */
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
      {/* Overlay click closes */}
      <button
        type="button"
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
        aria-label="Close modal overlay"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="relative w-full max-w-[580px] rounded-[16px] bg-white border border-slate-200 shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="text-[14px] font-extrabold text-slate-900">
            {title}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-9 w-9 rounded-[12px] border border-slate-200 bg-white hover:bg-slate-50 inline-flex items-center justify-center"
            aria-label="Close modal"
          >
            <GIcon name="close" sizePx={18} className="text-slate-600" />
          </button>
        </div>

        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

/* Upload control with preview */
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
      <div className="text-[12px] font-semibold text-slate-500">{label}</div>

      <div className="flex items-center gap-3">
        {/* Preview circle */}
        <div className="h-[56px] w-[56px] rounded-[16px] border border-slate-200 bg-slate-50 overflow-hidden flex items-center justify-center shrink-0">
          {previewUrl ? (
            <img
              src={previewUrl}
              alt="Preview"
              className="h-full w-full object-cover"
            />
          ) : (
            <GIcon name="person" sizePx={22} className="text-slate-400" />
          )}
        </div>

        {/* File input */}
        <label className="inline-flex items-center gap-2 rounded-[12px] border border-slate-200 bg-white px-3 py-2.5 text-[13px] font-bold text-slate-700 hover:bg-slate-50 cursor-pointer">
          <GIcon name="upload" sizePx={18} className="text-slate-500" />
          Upload
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onPick(f);
              // Reset value so selecting same file again still triggers change
              e.currentTarget.value = "";
            }}
          />
        </label>

        <button
          type="button"
          onClick={onClear}
          className="inline-flex items-center gap-2 rounded-[12px] border border-slate-200 bg-white px-3 py-2.5 text-[13px] font-bold text-slate-700 hover:bg-slate-50"
        >
          <GIcon name="delete" sizePx={18} className="text-slate-500" />
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
  active: boolean;
  lastLogin: string;
  photoUrl?: string; // local preview for now
};

export default function ProfilePage() {
  const [me, setMe] = useState({
    name: "Admin User",
    role: "admin",
    lastLogin: "—",
    email: "admin@khatasathi.local",
    phone: "+977 98XXXXXXXX",
  });

  const [adminPhotoUrl, setAdminPhotoUrl] = useState<string | undefined>(undefined);

  const [cashiers, setCashiers] = useState<Cashier[]>([]);
  const [loadingCashiers, setLoadingCashiers] = useState(false);

  const [activity, setActivity] = useState<Array<{ icon: string; title: string; meta: string; tone: "slate" | "green" }>>([
    { icon: "login", title: "Logged in successfully", meta: "—", tone: "slate" },
  ]);

  useEffect(() => {
    async function load() {
      try {
        const data = await getMeApi();
        const u = data.user || data;
        setMe({
          name: u.name || "Admin User",
          role: u.role || "admin",
          lastLogin: u.lastLogin
            ? new Date(u.lastLogin).toLocaleString()
            : "—",
          email: u.email || "",
          phone: u.phone || "",
        });
        setAdminPhotoUrl(u.profileImage);
      } catch {}

      try {
        const data = await listAuditLogsApi({ pageSize: 5 });
        const logs = data.logs || [];
        setActivity(
          logs.map((l: any) => ({
            icon: "history",
            title: l.action || "Activity",
            meta: new Date(l.createdAt).toLocaleString(),
            tone: "slate" as const,
          })),
        );
      } catch {}

      try {
        setLoadingCashiers(true);
        const users = await listUsersApi({ role: "CASHIER" });
        setCashiers(
          users.map((u: any) => ({
            id: u.id,
            name: u.name || "Unknown",
            email: u.email || "",
            phone: u.phone || "",
            active: u.isActive,
            // Last login might not be on the User payload yet.
            lastLogin: "—",
          }))
        );
      } catch {} finally {
        setLoadingCashiers(false);
      }
    }
    load();
  }, []);

  // Add cashier modal state
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newConfirmPassword, setNewConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [newPhotoUrl, setNewPhotoUrl] = useState<string | undefined>(undefined);

  // Edit cashier modal state
  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editActive, setEditActive] = useState(true);
  const [editPhotoUrl, setEditPhotoUrl] = useState<string | undefined>(undefined);

  function resetAddForm() {
    setNewName("");
    setNewEmail("");
    setNewPhone("");
    setNewPassword("");
    setNewConfirmPassword("");
    setPasswordError("");
    setNewPhotoUrl(undefined);
  }

  function openEdit(c: Cashier) {
    // Fill modal with selected cashier
    setEditId(c.id);
    setEditName(c.name);
    setEditEmail(c.email);
    setEditPhone(c.phone);
    setEditActive(c.active);
    setEditPhotoUrl(c.photoUrl);
    setEditOpen(true);
  }

  function closeEdit() {
    setEditOpen(false);
    setEditId(null);
    setEditName("");
    setEditEmail("");
    setEditPhone("");
    setEditActive(true);
    setEditPhotoUrl(undefined);
  }

  async function handleAddCashier() {
    try {
      if (!newName.trim() || !newEmail.trim() || !newPassword) return;
      if (newPassword.length < 6) return setPasswordError("Password must be at least 6 characters.");
      if (newPassword !== newConfirmPassword) return setPasswordError("Passwords do not match.");
      setPasswordError("");

      const user = await createUserApi({
        name: newName.trim(),
        email: newEmail.trim(),
        phone: newPhone.trim(),
        password: newPassword,
        role: "CASHIER",

        isActive: true,
      });

      setCashiers((prev) => [
        {
          id: user.id,
          name: user.name,
          email: user.email,
          phone: user.phone || "",
          active: user.isActive,
          lastLogin: "—",
        },
        ...prev,
      ]);

      setAddOpen(false);
      resetAddForm();
    } catch (e: any) {
      console.error(e);
      alert(e.response?.data?.error || "Error adding cashier");
    }
  }

  async function handleSaveEdit() {
    if (!editId) return;
    try {
      await updateUserApi(editId, {
        name: editName.trim(),
        email: editEmail.trim(),
        phone: editPhone.trim(),
        isActive: editActive,
      });

      setCashiers((prev) =>
        prev.map((c) =>
          c.id === editId
            ? {
                ...c,
                name: editName.trim() || c.name,
                email: editEmail.trim() || c.email,
                phone: editPhone.trim() || c.phone,
                active: editActive,
                photoUrl: editPhotoUrl,
              }
            : c,
        ),
      );

      closeEdit();
    } catch (e: any) {
      console.error(e);
      alert("Error updating cashier");
    }
  }

  async function toggleCashierActive(id: string) {
    const c = cashiers.find((x) => x.id === id);
    if (!c) return;
    try {
      await updateUserApi(id, { isActive: !c.active });
      setCashiers((prev) =>
        prev.map((c) => (c.id === id ? { ...c, active: !c.active } : c)),
      );
    } catch {
      alert("Failed to toggle status");
    }
  }

  return (
    <div className="space-y-[18px] pb-10">
      {/* Profile header */}
      <CardShell>
        <div className="p-[16px] flex flex-col md:flex-row md:items-center md:justify-between gap-[12px]">
          {/* Identity */}
          <div className="flex items-center gap-3">
            <div className="h-[44px] w-[44px] rounded-[14px] border border-orange-100 bg-orange-50 overflow-hidden flex items-center justify-center">
              {/* Admin photo preview */}
              {adminPhotoUrl ? (
                <img
                  src={adminPhotoUrl.startsWith("blob:") ? adminPhotoUrl : `${import.meta.env.VITE_API_BASE_URL || "http://localhost:4000"}${adminPhotoUrl}`}
                  alt="Admin"
                  className="h-full w-full object-cover"
                />
              ) : (
                <GIcon name="person" sizePx={22} className="text-orange-700" />
              )}
            </div>

            <div>
              <div className="text-[14px] font-extrabold text-slate-900">
                {me.name}
              </div>
              <div className="text-[12px] font-semibold text-slate-500">
                Role: <span className="text-slate-700">{me.role}</span> · Last
                login: <span className="text-slate-700">{me.lastLogin}</span>
              </div>
            </div>
          </div>

          {/* Buttons */}
          <div className="flex items-center gap-2">
            <Button variant="secondary" icon="key" onClick={() => {}}>
              Change password
            </Button>
            <Link to="/logout">
              <Button variant="danger" icon="logout">
                Logout
              </Button>
            </Link>
          </div>
        </div>
      </CardShell>

      {/* Account details + activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-[16px]">
        <CardShell>
          <div className="px-[16px] py-[14px] border-b border-slate-100">
            <SectionTitle
              title="Account details"
            />
          </div>

          <div className="p-[16px] space-y-4">
            {/* Admin image upload */}
            <ImageUpload
              label="Profile photo"
              previewUrl={adminPhotoUrl ? (adminPhotoUrl.startsWith("blob:") ? adminPhotoUrl : `${import.meta.env.VITE_API_BASE_URL || "http://localhost:4000"}${adminPhotoUrl}`) : undefined}
              onPick={async (file) => {
                const url = URL.createObjectURL(file);
                setAdminPhotoUrl(url);
                try {
                  const res = await uploadProfilePhotoApi(file);
                  if (res.user) {
                    setAuthUser(res.user);
                    window.dispatchEvent(new Event("auth_change"));
                  }
                } catch {
                  alert("Upload failed");
                }
              }}
              onClear={async () => {
                try {
                  const res = await updateProfileApi({ profileImage: null });
                  if (res.user) {
                    setAuthUser(res.user);
                    setAdminPhotoUrl(undefined);
                    window.dispatchEvent(new Event("auth_change"));
                  }
                } catch { alert("Failed to clear photo"); }
              }}
            />

            <TextField label="Email" value={me.email} disabled />
            <TextField label="Name" value={me.name} onChange={(v) => setMe(m => ({...m, name: v}))} />
            <TextField label="Phone" value={me.phone} onChange={(v) => setMe(m => ({...m, phone: v}))} />
            <TextField label="Role" value={me.role} disabled />

            <div className="pt-2">
              <Button variant="primary" icon="save" onClick={async () => {
                try {
                  const res = await updateProfileApi({ name: me.name, phone: me.phone });
                  if (res.user) {
                    setAuthUser(res.user);
                    window.dispatchEvent(new Event("auth_change"));
                    alert("Profile updated successfully!");
                  }
                } catch { alert("Failed to save profile"); }
              }}>Save Profile</Button>
            </div>
          </div>
        </CardShell>

        <CardShell>
          <div className="px-[16px] py-[14px] border-b border-slate-100">
            <SectionTitle
              title="Recent activity"
            />
          </div>

          <div className="p-[10px] space-y-2">
            {activity.map((a, idx) => (
              <div
                key={idx}
                className="rounded-[14px] border border-slate-200/60 bg-white px-3 py-3 flex items-start gap-3"
              >
                {/* Activity icon */}
                <div className="h-9 w-9 rounded-[12px] bg-slate-50 border border-slate-200/60 flex items-center justify-center shrink-0">
                  <GIcon name={a.icon} sizePx={18} className="text-slate-600" />
                </div>

                {/* Text */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-[13px] font-extrabold text-slate-900 truncate">
                      {a.title}
                    </div>

                    {/* Badge tone */}
                    <Badge tone={a.tone}>
                      {a.tone === "green" ? "INFO" : "SYSTEM"}
                    </Badge>
                  </div>
                  <div className="mt-0.5 text-[12px] font-semibold text-slate-500">
                    {a.meta}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardShell>
      </div>

      {/* Manage cashiers */}
      <CardShell>
        <div className="px-[16px] py-[14px] border-b border-slate-100 flex items-center justify-between gap-3">
          <SectionTitle
            title="Manage cashiers"
            sub="Create, edit, activate/deactivate, and review cashier accounts."
          />

          {/* Opens modal */}
          <Button
            variant="primary"
            icon="person_add"
            onClick={() => setAddOpen(true)}
          >
            Add cashier
          </Button>
        </div>

        <div className="p-[12px] overflow-x-auto">
          <table className="w-full min-w-[860px] text-left">
            <thead>
              <tr className="text-[11px] font-extrabold text-slate-400 uppercase tracking-wider">
                <th className="px-3 py-3">Cashier</th>
                <th className="px-3 py-3">Email</th>
                <th className="px-3 py-3">Phone</th>
                <th className="px-3 py-3">Last login</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3 text-right">Action</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-slate-100">
              {cashiers.map((c) => (
                <tr
                  key={c.id}
                  className="text-[13px] font-semibold text-slate-700"
                >
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-3">
                      {/* Small avatar preview */}
                      <div className="h-9 w-9 rounded-[12px] border border-slate-200 bg-slate-50 overflow-hidden flex items-center justify-center">
                        {c.photoUrl ? (
                          <img
                            src={c.photoUrl}
                            alt={c.name}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <GIcon
                            name="person"
                            sizePx={18}
                            className="text-slate-400"
                          />
                        )}
                      </div>

                      <div className="min-w-0">
                        <div className="text-slate-900 font-extrabold truncate">
                          {c.name}
                        </div>
                        <div className="text-[12px] text-slate-500">
                          ID: {c.id}
                        </div>
                      </div>
                    </div>
                  </td>

                  <td className="px-3 py-3">{c.email}</td>
                  <td className="px-3 py-3">{c.phone}</td>
                  <td className="px-3 py-3 text-slate-500">{c.lastLogin}</td>

                  <td className="px-3 py-3">
                    <Badge tone={c.active ? "green" : "slate"}>
                      {c.active ? "Active" : "Inactive"}
                    </Badge>
                  </td>

                  <td className="px-3 py-3">
                    <div className="flex items-center justify-end gap-2">
                      {/* Now opens edit modal */}
                      <Button
                        variant="secondary"
                        icon="edit"
                        onClick={() => openEdit(c)}
                      >
                        Edit
                      </Button>

                      {/* Quick toggle */}
                      <Button
                        variant={c.active ? "danger" : "secondary"}
                        icon={c.active ? "block" : "check_circle"}
                        onClick={() => toggleCashierActive(c.id)}
                      >
                        {c.active ? "Deactivate" : "Activate"}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>


        </div>
      </CardShell>

      {/* Add cashier modal */}
      <Modal
        open={addOpen}
        title="Add cashier"
        onClose={() => {
          setAddOpen(false);
          resetAddForm();
        }}
      >
        <div className="space-y-4">
          {/* Cashier photo */}
          <ImageUpload
            label="Cashier photo"
            previewUrl={newPhotoUrl}
            onPick={(file) => {
              const url = URL.createObjectURL(file);
              setNewPhotoUrl(url);
            }}
            onClear={() => setNewPhotoUrl(undefined)}
          />

          <TextField
            label="Full name"
            value={newName}
            onChange={setNewName}
            placeholder="e.g., Sita K."
          />
          <TextField
            label="Email"
            value={newEmail}
            onChange={setNewEmail}
            placeholder="e.g., sita@khatasathi.local"
          />
          <TextField
            label="Phone"
            value={newPhone}
            onChange={setNewPhone}
            placeholder="e.g., +977 98XXXXXXXX"
          />
          <TextField
            label="Password"
            value={newPassword}
            onChange={setNewPassword}
            type="password"
          />
          <TextField
            label="Confirm Password"
            value={newConfirmPassword}
            onChange={setNewConfirmPassword}
            type="password"
          />
          {passwordError && <div className="text-[13px] font-bold text-rose-500">{passwordError}</div>}

          {/* Simple action row */}
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

      {/* Edit cashier modal */}
      <Modal open={editOpen} title="Edit cashier" onClose={closeEdit}>
        <div className="space-y-4">
          {/* Cashier photo */}
          <ImageUpload
            label="Cashier photo"
            previewUrl={editPhotoUrl}
            onPick={(file) => {
              const url = URL.createObjectURL(file);
              setEditPhotoUrl(url);
            }}
            onClear={() => setEditPhotoUrl(undefined)}
          />

          <TextField
            label="Full name"
            value={editName}
            onChange={setEditName}
          />
          <TextField label="Email" value={editEmail} onChange={setEditEmail} />
          <TextField label="Phone" value={editPhone} onChange={setEditPhone} />

          {/* Active toggle */}
          <label className="inline-flex items-center gap-2 text-[13px] font-semibold text-slate-700 select-none">
            <input
              type="checkbox"
              checked={editActive}
              onChange={(e) => setEditActive(e.target.checked)}
              className="h-[16px] w-[16px]"
            />
            Active
          </label>

          {/* Save / cancel */}
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
    </div>
  );
}
