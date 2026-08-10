import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import BrandLogo from "~/components/ui/BrandLogo";
import Icon from "~/components/ui/Icon";
import {
  getBusinessCapabilitiesApi,
  getMeApi,
  logoutApi,
  updateProfileApi,
} from "~/lib/api/endpoints";
import { clearAuthUser, setAuthUser, type AuthUser, type UserRole } from "~/lib/auth";
import { getDefaultRoute } from "~/lib/routeAccess";

function authUserFromApi(user: any): AuthUser {
  return {
    id: String(user.id),
    name: String(user.name),
    email: user.email || null,
    phone: user.phone || null,
    role: String(user.role).toLowerCase() as UserRole,
    profileImage: user.profileImage || undefined,
    mustChangePassword: user.mustChangePassword === true,
  };
}

export default function ChangePasswordPage() {
  const navigate = useNavigate();
  const currentRef = useRef<HTMLInputElement>(null);
  const newRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const [checking, setChecking] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    getMeApi()
      .then(async ({ user }) => {
        if (cancelled) return;
        const normalized = authUserFromApi(user);
        setAuthUser(normalized);
        if (!normalized.mustChangePassword) {
          const capabilities = await getBusinessCapabilitiesApi();
          if (!cancelled) {
            navigate(getDefaultRoute(normalized.role, capabilities), { replace: true });
          }
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (!currentPassword) {
      setError("Enter the temporary password you used to sign in.");
      currentRef.current?.focus();
      return;
    }
    if (newPassword.length < 8) {
      setError("Your new password must contain at least 8 characters.");
      newRef.current?.focus();
      return;
    }
    if (newPassword.length > 128) {
      setError("Your new password must contain no more than 128 characters.");
      newRef.current?.focus();
      return;
    }
    if (newPassword === currentPassword) {
      setError("Choose a password different from the temporary password.");
      newRef.current?.focus();
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("The new password and confirmation do not match.");
      confirmRef.current?.focus();
      return;
    }

    setSaving(true);
    try {
      const { user } = await updateProfileApi({
        currentPassword,
        newPassword,
      });
      const normalized = authUserFromApi(user);
      setAuthUser(normalized);
      window.dispatchEvent(new Event("auth_change"));
      const capabilities = await getBusinessCapabilitiesApi();
      navigate(getDefaultRoute(normalized.role, capabilities), { replace: true });
    } catch (requestError: any) {
      setError(
        requestError?.response?.data?.error ||
          requestError?.message ||
          "The password could not be changed. Please try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function signOut() {
    setLoggingOut(true);
    try {
      await logoutApi();
    } finally {
      clearAuthUser();
      window.dispatchEvent(new Event("auth_change"));
      navigate("/login", { replace: true });
    }
  }

  if (checking) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-[#F7F7F5] p-5">
        <p className="text-sm font-bold text-[#565449]">Checking account security…</p>
      </main>
    );
  }

  const inputClass =
    "h-12 w-full rounded-xl border border-[#CFCFD3] bg-white px-4 pr-12 text-[15px] font-semibold text-[#11120D] outline-none transition focus:border-[#11120D] focus:ring-2 focus:ring-[#11120D]/10";

  return (
    <main className="min-h-dvh bg-[#F7F7F5] px-4 py-6 sm:flex sm:items-center sm:justify-center sm:px-6">
      <section className="mx-auto w-full max-w-[520px] overflow-hidden rounded-[24px] border border-[#D9D9D4] bg-white shadow-[0_18px_55px_rgba(17,18,13,0.10)]">
        <header className="flex items-center gap-3 border-b border-[#E5E5E1] px-5 py-5 sm:px-7">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-[#D9D9D4] bg-white">
            <BrandLogo variant="icon" className="h-9 w-9" />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-extrabold uppercase tracking-[0.12em] text-[#6A685E]">
              Account security
            </p>
            <h1 className="text-xl font-extrabold text-[#11120D] sm:text-2xl">
              Create your private password
            </h1>
          </div>
        </header>

        <form onSubmit={submit} className="space-y-5 px-5 py-6 sm:px-7 sm:py-7">
          <div className="rounded-2xl border border-[#E4D7B5] bg-[#FFF9E9] p-4">
            <div className="flex gap-3">
              <Icon name="shield" sizePx={20} className="mt-0.5 shrink-0 text-[#7A5412]" />
              <div>
                <p className="text-sm font-extrabold text-[#332A18]">Temporary password detected</p>
                <p className="mt-1 text-[13px] leading-5 text-[#62573F]">
                  Change it before opening shop information. Your Admin cannot see the private password you create here.
                </p>
              </div>
            </div>
          </div>

          {error ? (
            <div role="alert" className="rounded-xl border border-[#F3B8C1] bg-[#FFF1F3] px-4 py-3 text-sm font-bold text-[#A3132F]">
              {error}
            </div>
          ) : null}

          <label className="block">
            <span className="mb-2 block text-[12px] font-extrabold text-[#25251F]">Temporary password</span>
            <input
              ref={currentRef}
              type={showPasswords ? "text" : "password"}
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              className={inputClass}
              disabled={saving}
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-2 block text-[12px] font-extrabold text-[#25251F]">New password</span>
              <input
                ref={newRef}
                type={showPasswords ? "text" : "password"}
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                className={inputClass}
                disabled={saving}
              />
            </label>
            <label className="block">
              <span className="mb-2 block text-[12px] font-extrabold text-[#25251F]">Confirm new password</span>
              <input
                ref={confirmRef}
                type={showPasswords ? "text" : "password"}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                className={inputClass}
                disabled={saving}
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[12px] font-semibold text-[#6A685E]">Use 8–128 characters. A longer, unique phrase is easier to remember.</p>
            <button
              type="button"
              onClick={() => setShowPasswords((value) => !value)}
              className="min-h-11 rounded-xl border border-[#D9D9D4] px-4 text-[12px] font-extrabold text-[#25251F]"
            >
              {showPasswords ? "Hide passwords" : "Show passwords"}
            </button>
          </div>

          <button
            type="submit"
            disabled={saving || loggingOut}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#11120D] px-5 text-sm font-extrabold text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-55"
          >
            <Icon name="lock" sizePx={18} />
            {saving ? "Saving private password…" : "Save password and continue"}
          </button>

          <button
            type="button"
            onClick={signOut}
            disabled={saving || loggingOut}
            className="min-h-11 w-full rounded-xl text-sm font-bold text-[#565449] underline-offset-4 hover:underline disabled:opacity-55"
          >
            {loggingOut ? "Signing out…" : "Sign out and finish later"}
          </button>
        </form>
      </section>
    </main>
  );
}
