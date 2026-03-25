import React, { useEffect, useMemo, useState } from "react";
import { getMeApi, updateProfileApi, uploadProfilePhotoApi } from "~/lib/api/endpoints";
import { setAuthUser } from "~/lib/auth";

type TabKey = "personal" | "security";

type CashierProfile = {
  firstName: string;
  lastName: string;
  gender: "Male" | "Female";
  email: string;
  emailVerified: boolean;
  address: string;
  phone: string;
  dob: string; // yyyy-mm-dd
  location: string;
  nagariktaNo: string;
  roleLabel: string;
  profileImage?: string | null;
};

function Icon({
  name,
  className = "h-5 w-5",
}: {
  name:
  | "user"
  | "lock"
  | "badge"
  | "edit"
  | "mail"
  | "phone"
  | "pin"
  | "check"
  | "alert"
  | "chevDown"
  | "verified"
  | "calendar";
  className?: string;
}) {
  switch (name) {
    case "user":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <path
            d="M12 12a4.5 4.5 0 1 0-4.5-4.5A4.5 4.5 0 0 0 12 12Zm0 2c-4.2 0-7.5 2.2-7.5 5v1h15v-1c0-2.8-3.3-5-7.5-5Z"
            className="fill-current"
          />
        </svg>
      );
    case "lock":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <path
            d="M17 10V8a5 5 0 0 0-10 0v2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1Zm-8 0V8a3 3 0 0 1 6 0v2H9Z"
            className="fill-current"
          />
        </svg>
      );
    case "badge":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <path
            d="M12 2a6 6 0 0 0-4 10.5V22l4-2 4 2v-9.5A6 6 0 0 0 12 2Z"
            className="fill-current"
          />
        </svg>
      );
    case "edit":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <path
            d="M4 20h4l10.5-10.5-4-4L4 16v4Zm15.7-11.3a1 1 0 0 0 0-1.4l-2-2a1 1 0 0 0-1.4 0l-1.3 1.3 4 4 1.7-1.9Z"
            className="fill-current"
          />
        </svg>
      );
    case "mail":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <path
            d="M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Zm0 4-8 5L4 8V6l8 5 8-5v2Z"
            className="fill-current"
          />
        </svg>
      );
    case "phone":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <path
            d="M6.6 10.8a15.7 15.7 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.2 11.6 11.6 0 0 0 3.6.6 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A18 18 0 0 1 4 5a1 1 0 0 1 1-1h3.6a1 1 0 0 1 1 1 11.6 11.6 0 0 0 .6 3.6 1 1 0 0 1-.2 1l-2.4 2.2Z"
            className="fill-current"
          />
        </svg>
      );
    case "pin":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <path
            d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7Zm0 10a3 3 0 1 1 3-3 3 3 0 0 1-3 3Z"
            className="fill-current"
          />
        </svg>
      );
    case "check":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <path
            d="M9.2 16.2 4.8 11.8 3.4 13.2l5.8 5.8L21 7.2 19.6 5.8 9.2 16.2Z"
            className="fill-current"
          />
        </svg>
      );
    case "alert":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <path
            d="M12 2 1 21h22L12 2Zm1 14h-2V10h2v6Zm0 4h-2v-2h2v2Z"
            className="fill-current"
          />
        </svg>
      );
    case "chevDown":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <path
            d="M7 10l5 5 5-5"
            className="stroke-current"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "verified":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <path
            d="M12 2l2.2 2.8 3.6.6-1.9 3.1.4 3.6-3.3-1.3L12 14l-3 2.8-3.3 1.3.4-3.6-1.9-3.1 3.6-.6L12 2Zm-1 10 1.4 1.4L16 9.8l1.4 1.4-5 5-2.8-2.8L11 12Z"
            className="fill-current"
          />
        </svg>
      );
    case "calendar":
      return (
        <svg viewBox="0 0 24 24" className={className} fill="none">
          <path
            d="M7 2a1 1 0 0 1 1 1v1h8V3a1 1 0 1 1 2 0v1h1a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1V3a1 1 0 0 1 1-1Zm13 8H4v10h16V10Z"
            className="fill-current"
          />
        </svg>
      );
  }
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 text-[10.5px] font-extrabold uppercase tracking-[0.12em] text-zinc-400">
        {label}
      </div>
      {children}
    </div>
  );
}

function UnderlineInput({
  value,
  onChange,
  placeholder,
  type = "text",
  right,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-zinc-200 py-2.5 focus-within:border-orange-500">
      <input
        className="w-full bg-transparent text-sm font-medium text-zinc-900 placeholder:text-zinc-300 outline-none"
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {right}
    </div>
  );
}

function UnderlineSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <div className="flex items-center gap-2 border-b border-zinc-200 py-2.5 focus-within:border-orange-500">
      <select
        className="w-full bg-transparent text-sm font-medium text-zinc-900 outline-none"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      <span className="text-zinc-400">
        <Icon name="chevDown" className="h-4 w-4" />
      </span>
    </div>
  );
}

/**
 * Changes made to match your "1st image":
 * - Constrained the card width (prevents ultra-wide stretching)
 * - Centered the card in the available content area
 * - Increased internal spacing slightly
 * - Action buttons are centered and max-width constrained (not full-bleed wide)
 */
export default function CashierProfileSection() {
  const [tab, setTab] = useState<TabKey>("personal");

  const [profile, setProfile] = useState<CashierProfile>({
    firstName: "",
    lastName: "",
    gender: "Male",
    email: "",
    emailVerified: false,
    address: "",
    phone: "",
    dob: "",
    location: "Nepal",
    nagariktaNo: "",
    roleLabel: "Cashier",
    profileImage: null,
  });

  useEffect(() => {
    async function load() {
      try {
        const data = await getMeApi();
        const u = data.user || data;
        const parts = (u.name || "").split(" ");
        setProfile((prev) => ({
          ...prev,
          firstName: parts[0] || "",
          lastName: parts.slice(1).join(" ") || "",
          email: u.email || "",
          phone: u.phone || "",
          roleLabel: u.role || "Cashier",
          profileImage: u.profileImage || null,
        }));
      } catch {}
    }
    load();
  }, []);

  const [pwd, setPwd] = useState({ current: "", next: "", confirm: "" });

  const isPwdMismatch = useMemo(() => {
    if (!pwd.next || !pwd.confirm) return false;
    return pwd.next !== pwd.confirm;
  }, [pwd.next, pwd.confirm]);

  function discard() {
    // No-op for now
  }
  async function save() {
    if (tab === "security" && isPwdMismatch) return;
    try {
      const data: any = { name: `${profile.firstName} ${profile.lastName}`.trim(), phone: profile.phone };
      if (tab === "security" && pwd.next) data.password = pwd.next;
      const res = await updateProfileApi(data);
      if (res.user) {
         setAuthUser(res.user);
         window.dispatchEvent(new Event("auth_change"));
         alert("Profile updated successfully");
      }
    } catch (e: any) {
      alert("Error updating profile");
    }
  }

  const emailShort = profile.email.includes("@")
    ? profile.email.split("@")[0] + "…"
    : profile.email;

  return (
    // Outer wrapper is ONLY for layout (so the section "fills" nicely like your 1st image)
    <div className="w-full">
      {/* Constrain width so it looks like a focused section, not stretched */}
      <div className="mx-auto w-full max-w-[1200px]">
        <div className="w-full overflow-hidden rounded-xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.06),0_14px_40px_rgba(0,0,0,0.08)]">
          <div className="grid grid-cols-1 md:grid-cols-[320px_1fr]">
            {/* LEFT PANEL */}
            <aside className="relative bg-zinc-50/70 px-7 py-8 md:border-r md:border-zinc-100">
              {/* subtle decorations */}
              <div className="pointer-events-none absolute -top-16 -right-16 h-44 w-44 rounded-full bg-gradient-to-br from-orange-500 via-orange-400 to-orange-300 opacity-10" />
              <div className="pointer-events-none absolute -top-8 -right-8 h-24 w-24 rounded-full bg-orange-500 opacity-[0.06]" />

              <div className="relative z-10 flex flex-col items-center">
                <div className="relative">
                  <div className="flex h-[90px] w-[90px] items-center justify-center overflow-hidden rounded-full border-4 border-white bg-gradient-to-br from-orange-50 to-orange-100 shadow-[0_0_0_2px_rgba(251,146,60,0.35),0_10px_26px_rgba(249,115,22,0.18)]">
                    {profile.profileImage ? (
                      <img src={`${import.meta.env.VITE_API_BASE_URL || "http://localhost:4000"}${profile.profileImage}`} className="h-full w-full object-cover" />
                    ) : (
                      <span className="text-orange-500">
                        <Icon name="user" className="h-12 w-12" />
                      </span>
                    )}
                  </div>

                  <label
                    className="absolute bottom-0 right-0 grid h-7 w-7 place-items-center rounded-full border-2 border-white bg-orange-500 text-white shadow-md transition hover:bg-orange-600 active:scale-95 cursor-pointer"
                    aria-label="Edit avatar"
                  >
                    <Icon name="edit" className="h-3.5 w-3.5" />
                    <input type="file" className="hidden" accept="image/*" onChange={async (e) => {
                       const f = e.target.files?.[0];
                       if (!f) return;
                       try {
                         const res = await uploadProfilePhotoApi(f);
                         if (res.user) {
                           setAuthUser(res.user);
                           setProfile(p => ({ ...p, profileImage: res.user.profileImage }));
                         }
                       } catch { alert("Upload failed"); }
                    }} />
                  </label>
                </div>

                <div className="mt-5 text-center font-serif text-xl text-zinc-900">
                  {profile.firstName} {profile.lastName}
                </div>

                <div className="mt-2.5 inline-flex items-center gap-1.5 rounded-full border border-orange-200 bg-orange-50 px-3 py-1 text-[11px] font-extrabold uppercase tracking-wider text-orange-700">
                  <span className="text-orange-500">
                    <Icon name="badge" className="h-4 w-4" />
                  </span>
                  {profile.roleLabel}
                </div>
              </div>

              <div className="relative z-10 my-7 h-px bg-zinc-100" />

              <nav className="relative z-10 flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => setTab("personal")}
                  className={[
                    "relative flex h-11 w-full items-center gap-3 rounded-xl px-4 text-left text-[13px] font-semibold transition",
                    tab === "personal"
                      ? "bg-orange-50 text-orange-700"
                      : "text-zinc-500 hover:bg-zinc-100/70 hover:text-zinc-700",
                  ].join(" ")}
                >
                  {tab === "personal" && (
                    <span className="absolute left-0 top-2.5 bottom-2.5 w-[3px] rounded-r bg-orange-500" />
                  )}
                  <span
                    className={
                      tab === "personal" ? "text-orange-500" : "text-zinc-400"
                    }
                  >
                    <Icon name="user" className="h-[18px] w-[18px]" />
                  </span>
                  Personal Information
                </button>

                <button
                  type="button"
                  onClick={() => setTab("security")}
                  className={[
                    "relative flex h-11 w-full items-center gap-3 rounded-xl px-4 text-left text-[13px] font-semibold transition",
                    tab === "security"
                      ? "bg-orange-50 text-orange-700"
                      : "text-zinc-500 hover:bg-zinc-100/70 hover:text-zinc-700",
                  ].join(" ")}
                >
                  {tab === "security" && (
                    <span className="absolute left-0 top-2.5 bottom-2.5 w-[3px] rounded-r bg-orange-500" />
                  )}
                  <span
                    className={
                      tab === "security" ? "text-orange-500" : "text-zinc-400"
                    }
                  >
                    <Icon name="lock" className="h-[18px] w-[18px]" />
                  </span>
                  Login &amp; Password
                </button>
              </nav>

              <div className="relative z-10 my-7 h-px bg-zinc-100" />

              <div className="relative z-10 flex flex-col gap-3 text-xs text-zinc-500">
                <div className="flex items-center gap-2">
                  <span className="text-zinc-300">
                    <Icon name="mail" className="h-4 w-4" />
                  </span>
                  <span className="truncate">{emailShort}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-zinc-300">
                    <Icon name="phone" className="h-4 w-4" />
                  </span>
                  <span className="truncate">{profile.phone}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-zinc-300">
                    <Icon name="pin" className="h-4 w-4" />
                  </span>
                  <span className="truncate">{profile.location}</span>
                </div>
              </div>
            </aside>

            {/* RIGHT PANEL */}
            <section className="flex flex-col">
              {/* Constrain content width so it feels “full” and balanced (like image 1) */}
              <div className="w-full px-8 pt-8">
                <div className="mx-auto w-full max-w-[860px]">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="font-serif text-2xl text-zinc-900">
                        {tab === "personal"
                          ? "Personal Information"
                          : "Login & Password"}
                      </h2>
                      <div className="mt-2 h-[3px] w-9 rounded bg-orange-500" />
                      {tab === "security" && (
                        <p className="mt-2 text-sm font-medium text-zinc-400">
                          Manage your login credentials.
                        </p>
                      )}
                    </div>

                    <div className="pt-1 text-[11.5px] font-semibold text-zinc-300">
                      Last saved: Today
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex-1 px-8 pb-8 pt-6">
                <div className="mx-auto w-full max-w-[860px]">
                  {tab === "personal" ? (
                    <>
                      <div className="mb-7 flex flex-wrap items-center gap-3">
                        <div className="text-[10.5px] font-extrabold uppercase tracking-[0.12em] text-zinc-400">
                          Gender
                        </div>

                        <div className="flex items-center gap-2">
                          {(["Male", "Female"] as const).map((g) => {
                            const active = profile.gender === g;
                            return (
                              <button
                                key={g}
                                type="button"
                                onClick={() =>
                                  setProfile((p) => ({ ...p, gender: g }))
                                }
                                className={[
                                  "inline-flex h-9 items-center gap-2 rounded-full border px-4 text-[13px] font-semibold transition",
                                  active
                                    ? "border-orange-300 bg-orange-50 text-orange-700"
                                    : "border-zinc-200 bg-white text-zinc-400 hover:border-zinc-300 hover:text-zinc-700",
                                ].join(" ")}
                              >
                                <span
                                  className={[
                                    "h-2.5 w-2.5 rounded-full transition",
                                    active
                                      ? "bg-orange-500"
                                      : "border border-zinc-300 bg-transparent",
                                  ].join(" ")}
                                />
                                {g}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div className="grid grid-cols-1 gap-x-12 gap-y-6 md:grid-cols-2">
                        <Field label="First Name">
                          <UnderlineInput
                            value={profile.firstName}
                            onChange={(v) =>
                              setProfile((p) => ({ ...p, firstName: v }))
                            }
                            placeholder="First name"
                          />
                        </Field>

                        <Field label="Last Name">
                          <UnderlineInput
                            value={profile.lastName}
                            onChange={(v) =>
                              setProfile((p) => ({ ...p, lastName: v }))
                            }
                            placeholder="Last name"
                          />
                        </Field>

                        <div className="md:col-span-2">
                          <Field label="Email">
                            <UnderlineInput
                              value={profile.email}
                              onChange={(v) =>
                                setProfile((p) => ({ ...p, email: v }))
                              }
                              placeholder="Email address"
                              right={
                                profile.emailVerified ? (
                                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-extrabold text-emerald-700">
                                    <span className="text-emerald-600">
                                      <Icon
                                        name="verified"
                                        className="h-3.5 w-3.5"
                                      />
                                    </span>
                                    Verified
                                  </span>
                                ) : null
                              }
                            />
                          </Field>
                        </div>

                        <div className="md:col-span-2">
                          <Field label="Address">
                            <UnderlineInput
                              value={profile.address}
                              onChange={(v) =>
                                setProfile((p) => ({ ...p, address: v }))
                              }
                              placeholder="Home address"
                            />
                          </Field>
                        </div>

                        <Field label="Phone Number">
                          <UnderlineInput
                            value={profile.phone}
                            onChange={(v) =>
                              setProfile((p) => ({ ...p, phone: v }))
                            }
                            placeholder="Phone number"
                          />
                        </Field>

                        <div>
                          <Field label="Date of Birth">
                            <div className="flex items-center justify-between border-b border-zinc-200 py-2.5 focus-within:border-orange-500">
                              <input
                                className="w-full bg-transparent text-sm font-medium text-zinc-900 outline-none"
                                type="date"
                                value={profile.dob}
                                onChange={(e) =>
                                  setProfile((p) => ({
                                    ...p,
                                    dob: e.target.value,
                                  }))
                                }
                              />
                              <span className="text-zinc-400">
                                <Icon name="calendar" className="h-4 w-4" />
                              </span>
                            </div>
                          </Field>
                        </div>

                        <Field label="Location">
                          <UnderlineSelect
                            value={profile.location}
                            onChange={(v) =>
                              setProfile((p) => ({ ...p, location: v }))
                            }
                            options={["Nepal", "India", "Other"]}
                          />
                        </Field>

                        <Field label="Nagarikta Number">
                          <UnderlineInput
                            value={profile.nagariktaNo}
                            onChange={(v) =>
                              setProfile((p) => ({ ...p, nagariktaNo: v }))
                            }
                            placeholder="Citizenship no."
                          />
                        </Field>
                      </div>
                    </>
                  ) : (
                    <div className="grid grid-cols-1 gap-x-12 gap-y-6 md:grid-cols-2">
                      <div className="md:col-span-2">
                        <Field label="Current Password">
                          <UnderlineInput
                            value={pwd.current}
                            onChange={(v) =>
                              setPwd((p) => ({ ...p, current: v }))
                            }
                            placeholder="Enter current password"
                            type="password"
                          />
                        </Field>
                      </div>

                      <Field label="New Password">
                        <UnderlineInput
                          value={pwd.next}
                          onChange={(v) => setPwd((p) => ({ ...p, next: v }))}
                          placeholder="New password"
                          type="password"
                        />
                      </Field>

                      <div>
                        <Field label="Confirm New Password">
                          <UnderlineInput
                            value={pwd.confirm}
                            onChange={(v) =>
                              setPwd((p) => ({ ...p, confirm: v }))
                            }
                            placeholder="Repeat new password"
                            type="password"
                          />
                        </Field>

                        {isPwdMismatch && (
                          <div className="mt-2 flex items-center gap-1.5 text-xs font-bold text-red-600">
                            <Icon name="alert" className="h-4 w-4" />
                            Passwords do not match
                          </div>
                        )}
                      </div>

                      <div className="md:col-span-2">
                        <div className="rounded-xl border border-zinc-100 bg-zinc-50/70 p-4">
                          <div className="mb-2 text-[11px] font-extrabold uppercase tracking-[0.12em] text-orange-500">
                            Recommended
                          </div>
                          <div className="text-sm font-medium leading-relaxed text-zinc-500">
                            Use 8 or more characters, mixing letters, numbers,
                            and symbols. Avoid dictionary words or personal
                            info.
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* ACTION BAR: centered + constrained width (fixes your "2nd image" full-bleed button) */}
              <div className="border-t border-zinc-100 px-8 py-6">
                <div className="mx-auto w-full max-w-[860px]">
                  <div className="flex flex-col gap-3 sm:flex-row">
                    <button
                      type="button"
                      onClick={discard}
                      className="h-12 flex-1 rounded-2xl border border-zinc-200 bg-white text-sm font-semibold text-zinc-500 transition hover:bg-zinc-50 hover:text-zinc-700"
                    >
                      Discard changes
                    </button>

                    <button
                      type="button"
                      onClick={save}
                      className="h-12 flex-[2] rounded-2xl bg-orange-500 text-sm font-extrabold text-white shadow-[0_8px_20px_rgba(249,115,22,0.28)] transition hover:bg-orange-600 active:scale-[0.99]"
                    >
                      <span className="inline-flex items-center justify-center gap-2">
                        <Icon name="check" className="h-5 w-5" />
                        Save changes
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
