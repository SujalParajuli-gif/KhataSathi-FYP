import React, { useEffect, useMemo, useState } from "react";
import Icon from "~/components/ui/Icon";
import { SuccessDialog } from "~/components/ui/Modal";
import UserAvatar from "~/components/ui/UserAvatar";
import {
  getMeApi,
  updateProfileApi,
  uploadProfilePhotoApi,
} from "~/lib/api/endpoints";
import { API_BASE_URL } from "~/lib/api/baseUrl";
import { setAuthUser } from "~/lib/auth";

type TabKey = "personal" | "security";

type CashierProfile = {
  firstName: string;
  lastName: string;
  gender: "Male" | "Female";
  email: string;
  emailVerified: boolean | null;
  address: string;
  phone: string;
  location: string;
  roleLabel: string;
  profileImage?: string | null;
  lastLogin?: string | null;
};

const LOCATION_STORAGE_KEY = "khatasathi_cashier_profile_location";

// we use this helper to combine tailwind class names cleanly
function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

// pulls the region choice from local storage since it's not saved to the backend yet
function readStoredLocation() {
  if (typeof window === "undefined") return "Nepal";
  return window.localStorage.getItem(LOCATION_STORAGE_KEY) || "Nepal";
}

// humanizes the role codes back to readable labels
function formatRoleLabel(role?: string | null) {
  const normalized = String(role || "").toLowerCase();
  if (normalized === "admin") return "Admin";
  if (normalized === "manager") return "Manager";
  if (normalized === "staff") return "Staff";
  return "Cashier";
}

// splits a full name string into first and last name so forms can control them independently
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

// renders standard UI readable dates
function formatDateTime(value?: string | null) {
  if (!value) return "Not available";
  return new Date(value).toLocaleString();
}

// takes the ugly raw API user object and standardizes it into our CashierProfile format
function mapUserToProfile(user: any): CashierProfile {
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
    location: readStoredLocation(),
    roleLabel: formatRoleLabel(user?.role),
    profileImage: user?.profileImage || null,
    lastLogin: user?.lastLogin || null,
  };
}

// this panel wrapper keeps the profile page cards consistent for both personal and security sections
function Panel({
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
    <section className="overflow-hidden rounded-[22px] border border-slate-200 bg-white  flex flex-col h-full">
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

// this is the shared action button used for save, discard, and profile actions on the page
function ActionButton({
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

// this keeps label and hint formatting consistent across all profile form fields
function Field({
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
        <label className="text-[11px] font-extrabold uppercase  text-slate-500">
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

// this is the shared text input used across personal details and security fields
function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
  disabled = false,
  right,
}: {
  value: string;
  onChange: (v: string) => void;
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
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder || "Text input"}
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

// this wraps the select element so it matches the same visual style as the text inputs
function SelectInput({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <div className="rounded-[14px] border border-slate-200 bg-white px-4 py-3 transition focus-within:border-slate-900">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Select an option"
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

// handles the main "My Profile" page allowing the currently logged-in cashier or admin to view and edit their details
export default function CashierProfileSection() {
  const [tab, setTab] = useState<TabKey>("personal"); // switches between personal details and password settings
  const [loading, setLoading] = useState(true); // tracks whether the initial data fetch is still running
  const [saving, setSaving] = useState(false); // blocks repeated profile saves while an update is running
  const [uploadingPhoto, setUploadingPhoto] = useState(false); // tracks photo upload progress separately from normal form saves
  const [error, setError] = useState(""); // shared error message for load/save/upload problems
  const [successOpen, setSuccessOpen] = useState(false); // controls the success dialog
  const [successMessage, setSuccessMessage] = useState(""); // success message shown after profile or password update

  const [profile, setProfile] = useState<CashierProfile>({
    firstName: "",
    lastName: "",
    gender: "Male",
    email: "",
    emailVerified: null,
    address: "",
    phone: "",
    location: "Nepal",
    roleLabel: "Cashier",
    profileImage: null,
    lastLogin: null,
  });
  const [initialProfile, setInitialProfile] = useState<CashierProfile>({
    firstName: "",
    lastName: "",
    gender: "Male",
    email: "",
    emailVerified: null,
    address: "",
    phone: "",
    location: "Nepal",
    roleLabel: "Cashier",
    profileImage: null,
    lastLogin: null,
  });
  const [pwd, setPwd] = useState({ current: "", next: "", confirm: "" }); // password form state used only in the security tab

  useEffect(() => {
    // loading the current logged-in user's profile details when the page first opens
    async function load() {
      setLoading(true);
      setError("");
      try {
        // asking the backend for the latest profile data keeps this page aligned with the current auth user
        const data = await getMeApi();
        const nextProfile = mapUserToProfile(data.user || data);
        setProfile(nextProfile);
        setInitialProfile(nextProfile);
      } catch (err: any) {
        setError(
          err?.response?.data?.error ||
            "Unable to load your profile right now.",
        );
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // saving region to localstorage whenever it changes
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(LOCATION_STORAGE_KEY, profile.location);
    }
  }, [profile.location]);

  // dynamically calculating the user's initials for the fallback avatar without storing it in state
  const fullName =
    `${profile.firstName} ${profile.lastName}`.trim() || "Cashier"; // fallback keeps the avatar initials stable even when the form is still blank
  const initials = useMemo(
    () =>
      fullName
        .split(" ")
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() || "")
        .join(""),
    [fullName],
  );

  // this tells us whether the new password and confirmation disagree
  const isPwdMismatch = useMemo(() => {
    if (!pwd.next || !pwd.confirm) return false;
    return pwd.next !== pwd.confirm;
  }, [pwd.next, pwd.confirm]);

  // comparing the current form to the initial snapshot lets us block empty saves
  const hasProfileChanges = useMemo(
    () => JSON.stringify(profile) !== JSON.stringify(initialProfile),
    [profile, initialProfile],
  );
  const hasSecurityChanges = Boolean(pwd.current || pwd.next || pwd.confirm); // true when the security tab has any typed input

  // reverts everything back to whatever was saved last
  function discard() {
    setError("");
    setProfile(initialProfile);
    setPwd({ current: "", next: "", confirm: "" });
  }

  // running the update against the server
  // includes various validation stops to ensure passwords all match and actual changes exist
  async function save() {
    setError("");

    // this handles when the personal tab has nothing new to save
    if (tab === "personal" && !hasProfileChanges) {
      setError("No personal profile changes to save.");
      return;
    }

    // security updates need a stricter set of checks because the backend expects both the current and new password
    if (tab === "security") {
      if (!hasSecurityChanges) {
        setError("Enter a new password before saving security settings.");
        return;
      }
      if (!pwd.current) {
        setError("Enter your current password to continue.");
        return;
      }
      if (!pwd.next) {
        setError("Enter the new password.");
        return;
      }
      if (isPwdMismatch) {
        setError("New password and confirmation must match.");
        return;
      }
    }

    setSaving(true);
    try {
      // only sending the editable profile fields keeps read-only values like email and role out of the update payload
      const payload: any = {
        name: `${profile.firstName} ${profile.lastName}`.trim(),
        phone: profile.phone,
        gender: profile.gender,
        address: profile.address,
      };
      if (tab === "security" && pwd.next) {
        payload.currentPassword = pwd.current;
        payload.newPassword = pwd.next;
      }

      // saving either personal details or password through the same profile endpoint
      const res = await updateProfileApi(payload);
      if (res.user) {
        // syncing auth state after profile changes keeps the header/avatar updated everywhere else in the app
        setAuthUser(res.user);
        window.dispatchEvent(new Event("auth_change"));
        const nextProfile = {
          ...mapUserToProfile(res.user),
          location: profile.location,
          emailVerified: profile.emailVerified,
        };
        setProfile(nextProfile);
        setInitialProfile(nextProfile);
      } else {
        setInitialProfile(profile);
      }

      setPwd({ current: "", next: "", confirm: "" });
      setSuccessMessage(
        tab === "personal"
          ? "Your profile details have been updated."
          : "Your password has been updated.",
      );
      setSuccessOpen(true);
    } catch (err: any) {
      setError(
        err?.response?.data?.error || "Unable to save your changes right now.",
      );
    } finally {
      setSaving(false);
    }
  }

  // this uploads a new profile photo and then refreshes the saved auth user so the rest of the app sees the new image
  async function handlePhotoChange(file?: File | null) {
    if (!file) return;
    setUploadingPhoto(true);
    setError("");
    try {
      const res = await uploadProfilePhotoApi(file);
      if (res.user) {
        setAuthUser(res.user);
        window.dispatchEvent(new Event("auth_change"));
        const nextProfile = {
          ...mapUserToProfile(res.user),
          location: profile.location,
          emailVerified: profile.emailVerified,
        };
        setProfile(nextProfile);
        setInitialProfile(nextProfile);
      }
      setSuccessMessage("Your profile photo has been updated.");
      setSuccessOpen(true);
    } catch (err: any) {
      setError(err?.message || "Upload failed.");
    } finally {
      setUploadingPhoto(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-5 pb-8">
        <div className="space-y-5 xl:flex xl:items-start xl:gap-5 xl:space-y-0">
          <div className="h-[360px] animate-pulse rounded-[22px] border border-slate-200 bg-white xl:w-[340px] xl:flex-none" />
          <div className="h-[360px] animate-pulse rounded-[22px] border border-slate-200 bg-white xl:min-w-0 xl:flex-1" />
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-5 pb-8 text-slate-900">
        {/* this layout keeps the account overview in a fixed-feeling side card and leaves the larger area for editable forms */}
        <div className="space-y-5 xl:flex xl:items-start xl:gap-5 xl:space-y-0">
          <div className="xl:w-[450px] xl:h-[700px] xl:flex-none">
            <Panel
              title="Account Overview"
              subtitle="Photo, contact , and sign-in for this cashier account."
            >
              <div className="space-y-5 px-5 py-5">
                {/* we center the avatar block here so the page opens with a stronger profile feel before the editable fields start */}
                <div className="flex flex-col items-center text-center">
                  <UserAvatar
                    src={
                      profile.profileImage
                        ? `${API_BASE_URL}${profile.profileImage}`
                        : undefined
                    }
                    alt="Profile"
                    className="flex h-28 w-28 items-center justify-center overflow-hidden rounded-full border-4 border-slate-200 bg-slate-100 text-[30px] font-extrabold text-slate-700"
                    fallback={initials || "CU"}
                  />
                  <div className="mt-4 text-[20px] font-extrabold text-slate-900">
                    {fullName}
                  </div>
                  <div className="mt-1 text-[13px] font-semibold text-slate-500">
                    {profile.email || "No email available"}
                  </div>
                  <div className="mt-3">
                    <label className="cursor-pointer">
                      <input
                        type="file"
                        className="hidden"
                        accept="image/*"
                        onChange={(e) => handlePhotoChange(e.target.files?.[0])}
                      />
                      <span
                        className={cn(
                          "inline-flex h-[42px] items-center justify-center gap-2 rounded-[14px] border px-4 text-[13px] font-extrabold transition",
                          uploadingPhoto
                            ? "border-slate-200 bg-slate-100 text-slate-400"
                            : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
                        )}
                      >
                        <Icon name="photo_camera" className="text-[18px]" />
                        {uploadingPhoto ? "Uploading..." : "Change Photo"}
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
                      {profile.phone || "No phone added"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="inline-flex items-center gap-2">
                      <Icon name="location_on" className="text-[18px]" /> Region
                    </span>
                    <span className="text-right text-slate-900">
                      {profile.location}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="inline-flex items-center gap-2">
                      <Icon name="schedule" className="text-[18px]" /> Last
                      login
                    </span>
                    <span className="text-right text-slate-900">
                      {formatDateTime(profile.lastLogin)}
                    </span>
                  </div>
                </div>
              </div>
            </Panel>
          </div>

          <div className="xl:min-w-0 xl:flex-1">
            <Panel
              title={
                tab === "personal" ? "Personal Details" : "Login & Password"
              }
              subtitle={
                tab === "personal"
                  ? "Update the same profile fields already available on this page."
                  : "Keep the current password fields, password guidance, and save flow."
              }
              actions={
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setTab("personal")}
                    className={cn(
                      "rounded-full border px-4 py-2 text-[12px] font-extrabold transition",
                      tab === "personal"
                        ? "border-slate-900 bg-slate-900 text-white"
                        : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
                    )}
                  >
                    Personal Information
                  </button>
                  <button
                    type="button"
                    onClick={() => setTab("security")}
                    className={cn(
                      "rounded-full border px-4 py-2 text-[12px] font-extrabold transition",
                      tab === "security"
                        ? "border-slate-900 bg-slate-900 text-white"
                        : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
                    )}
                  >
                    Login & Password
                  </button>
                </div>
              }
            >
              <div className="flex flex-col h-full justify-between space-y-6 px-5 py-5">
                <div className="space-y-6">
                  {error ? (
                    <div className="rounded-[16px] border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] font-semibold text-rose-700">
                      {error}
                    </div>
                  ) : null}

                  {tab === "personal" ? (
                    <>
                      <Field label="Gender">
                        <div className="flex flex-wrap gap-3">
                          {(["Male", "Female"] as const).map((gender) => (
                            <button
                              key={gender}
                              type="button"
                              onClick={() =>
                                setProfile((current) => ({
                                  ...current,
                                  gender,
                                }))
                              }
                              className={cn(
                                "rounded-[14px] border px-6 py-3 text-[13px] font-extrabold transition",
                                profile.gender === gender
                                  ? "border-slate-900 bg-slate-900 text-white"
                                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
                              )}
                            >
                              {gender}
                            </button>
                          ))}
                        </div>
                      </Field>

                      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                        <Field label="First Name">
                          <TextInput
                            value={profile.firstName}
                            onChange={(value) =>
                              setProfile((current) => ({
                                ...current,
                                firstName: value,
                              }))
                            }
                            placeholder="First name"
                          />
                        </Field>

                        <Field label="Last Name">
                          <TextInput
                            value={profile.lastName}
                            onChange={(value) =>
                              setProfile((current) => ({
                                ...current,
                                lastName: value,
                              }))
                            }
                            placeholder="Last name"
                          />
                        </Field>

                        <div className="md:col-span-2">
                          <Field label="Email Address" hint="Read-only here">
                            <TextInput
                              value={profile.email}
                              onChange={() => {}}
                              placeholder="Email address"
                              disabled
                              right={
                                profile.emailVerified ? (
                                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-[10px] font-extrabold uppercase  text-emerald-700">
                                    <Icon
                                      name="verified"
                                      className="text-[14px]"
                                    />
                                    Verified
                                  </span>
                                ) : (
                                  <span className="inline-flex rounded-full border border-slate-200 bg-slate-100 px-2 py-1 text-[10px] font-extrabold uppercase  text-slate-500">
                                    Sign-in Email
                                  </span>
                                )
                              }
                            />
                          </Field>
                        </div>

                        <div className="md:col-span-2">
                          <Field label="Home Address">
                            <TextInput
                              value={profile.address}
                              onChange={(value) =>
                                setProfile((current) => ({
                                  ...current,
                                  address: value,
                                }))
                              }
                              placeholder="e.g. Kathmandu, Nepal"
                            />
                          </Field>
                        </div>

                        <Field label="Phone Number">
                          <TextInput
                            value={profile.phone}
                            onChange={(value) =>
                              setProfile((current) => ({
                                ...current,
                                phone: value,
                              }))
                            }
                            placeholder="+977 98XXXXXXXX"
                          />
                        </Field>

                        <Field
                          label="Country / Region"
                          hint="Stored locally on this device"
                        >
                          <SelectInput
                            value={profile.location}
                            onChange={(value) =>
                              setProfile((current) => ({
                                ...current,
                                location: value,
                              }))
                            }
                            options={["Nepal", "India", "Other"]}
                          />
                        </Field>
                      </div>
                    </>
                  ) : (
                    <>
                      <Field label="Current Password">
                        <TextInput
                          value={pwd.current}
                          onChange={(value) =>
                            setPwd((current) => ({
                              ...current,
                              current: value,
                            }))
                          }
                          placeholder="Enter current password"
                          type="password"
                        />
                      </Field>

                      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                        <Field label="New Password">
                          <TextInput
                            value={pwd.next}
                            onChange={(value) =>
                              setPwd((current) => ({ ...current, next: value }))
                            }
                            placeholder="New password"
                            type="password"
                          />
                        </Field>

                        <Field label="Confirm New Password">
                          <TextInput
                            value={pwd.confirm}
                            onChange={(value) =>
                              setPwd((current) => ({
                                ...current,
                                confirm: value,
                              }))
                            }
                            placeholder="Repeat new password"
                            type="password"
                          />
                        </Field>
                      </div>

                      {isPwdMismatch ? (
                        <div className="rounded-[16px] border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] font-semibold text-rose-700">
                          Passwords do not match.
                        </div>
                      ) : null}

                      <div className="rounded-[18px] border border-slate-200 bg-slate-50/70 p-5">
                        <div className="text-[11px] font-extrabold uppercase  text-slate-500">
                          Password Requirements
                        </div>
                        <div className="mt-2 text-[13px] font-medium leading-7 text-slate-600">
                          Use 8 or more characters, mixing letters, numbers, and
                          symbols. Avoid using dictionary words or easily
                          guessable personal information.
                        </div>
                      </div>
                    </>
                  )}
                </div>

                <div className="mt-8 flex flex-wrap items-center justify-end gap-3 border-t border-slate-100 pt-5">
                  <ActionButton
                    icon="restart_alt"
                    label="Discard Changes"
                    onClick={discard}
                    disabled={
                      saving || (!hasProfileChanges && !hasSecurityChanges)
                    }
                  />
                  <ActionButton
                    icon={tab === "security" ? "lock" : "save"}
                    label={
                      saving
                        ? "Saving..."
                        : tab === "security"
                          ? "Update Password"
                          : "Save Profile"
                    }
                    onClick={save}
                    disabled={
                      saving || (tab === "security" ? isPwdMismatch : false)
                    }
                    primary
                  />
                </div>
              </div>
            </Panel>
          </div>
        </div>
      </div>

      <SuccessDialog
        open={successOpen}
        title="Profile updated"
        message={successMessage}
        onClose={() => setSuccessOpen(false)}
        actionLabel="Continue"
      />
    </>
  );
}
