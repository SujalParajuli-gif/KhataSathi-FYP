import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import BrandLogo from "~/components/ui/BrandLogo";
import Icon from "~/components/ui/Icon";
import navData from "~/config/ui.nav.json";
import type { AuthUser, UserRole } from "~/lib/auth";
import { getDefaultRoute } from "~/lib/routeAccess";
import { getAuthUser, isLoggedIn, setAuthUser } from "~/lib/auth";
import {
  getBusinessCapabilitiesApi,
  getMeApi,
  loginApi,
} from "~/lib/api/endpoints";

// helper function to join CSS class names
function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

// desktop form field wrapper
function Field({
  label,
  children,
  className,
}: {
  label?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      {label ? (
        <div className="mb-2 text-[11px] font-extrabold uppercase text-[#8C8889]">
          {label}
        </div>
      ) : null}
      {children}
    </div>
  );
}

// desktop text input
function TextInput({
  value,
  onChange,
  placeholder,
  right,
  left,
  type = "text",
  onEnter,
  hasError,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  right?: React.ReactNode;
  left?: React.ReactNode;
  type?: string;
  onEnter?: () => void;
  hasError?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-[52px] items-center gap-3 rounded-[14px] border-2 bg-white px-[16px] transition-all duration-200",
        hasError
          ? "border-rose-300"
          : "border-[#CFCFD3] focus-within:border-[#000000] hover:border-[#8C8889]",
      )}
    >
      {left}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onEnter) onEnter();
        }}
        className="h-full w-full bg-transparent text-[13px] font-bold text-[#000000] outline-none placeholder:font-medium placeholder:text-[#8C8889]"
      />
      {right}
    </div>
  );
}

// desktop button
function Button({
  children,
  variant = "primary",
  onClick,
  className,
  type = "button",
  disabled,
}: {
  children: React.ReactNode;
  variant?: "primary" | "outline" | "ghost";
  onClick?: () => void;
  className?: string;
  type?: "button" | "submit";
  disabled?: boolean;
}) {
  const baseClass =
    "h-[52px] rounded-[14px] border-2 px-6 text-[13px] font-extrabold transition flex items-center justify-center gap-2 active:scale-95";
  const variants = {
    primary:
      "border-[#000000] bg-[#000000] text-white hover:bg-[#1F2937] hover:border-[#1F2937]",
    outline:
      "border-[#CFCFD3] bg-white text-[#000000] hover:bg-[#F8FAFC] hover:border-[#8C8889]",
    ghost:
      "border-transparent bg-transparent text-[#8C8889] hover:bg-[#F3F4F6] hover:text-[#000000]",
  };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        baseClass,
        variants[variant],
        className,
        disabled && "pointer-events-none opacity-50",
      )}
    >
      {children}
    </button>
  );
}

export default function LoginPage() {
  const navigate = useNavigate();
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [formData, setFormData] = useState({ identifier: "", password: "" });
  const [touched, setTouched] = useState({ identifier: false, password: false });

  const identifierValue = formData.identifier.trim();
  const identifierError =
    touched.identifier && !identifierValue ? "Phone or email is required." : "";
  const passwordError =
    touched.password && !formData.password ? "Password is required." : "";

  // automatically redirect to the correct dashboard if user is already logged in
  React.useEffect(() => {
    if (!isLoggedIn()) return;
    const cachedUser = getAuthUser();
    if (cachedUser?.mustChangePassword) {
      navigate("/change-password", { replace: true });
      return;
    }
    let cancelled = false;
    Promise.all([getMeApi(), getBusinessCapabilitiesApi()])
      .then(([, capabilities]) => {
        if (cancelled) return;
        const user = getAuthUser();
        if (user) {
          navigate(getDefaultRoute(user.role, capabilities), { replace: true });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const canSubmit = useMemo(() => {
    return (
      identifierValue.length > 0 &&
      formData.password.length > 0 &&
      !loading
    );
  }, [identifierValue, formData.password, loading]);

  async function onLogin(e?: React.FormEvent) {
    e?.preventDefault();
    setErrorMsg(null);
    setTouched({ identifier: true, password: true });

    if (!identifierValue) return setErrorMsg("Please enter your phone number or email.");
    if (!formData.password) return setErrorMsg("Please enter your password.");

    setLoading(true);

    try {
      const data = await loginApi(identifierValue, formData.password);

      const user: AuthUser = {
        id: data.user.id,
        name: data.user.name,
        email: data.user.email,
        phone: data.user.phone,
        mustChangePassword: data.user.mustChangePassword === true,
        role: data.user.role.toLowerCase() as UserRole,
        profileImage: data.user.profileImage,
      };
      setAuthUser(user);

      if (user.mustChangePassword) {
        navigate("/change-password", { replace: true });
        return;
      }

      const capabilities = await getBusinessCapabilitiesApi();
      navigate(getDefaultRoute(user.role, capabilities));
    } catch (err: any) {
      const msg =
        err.response?.data?.error ||
        "Login failed. Please check your credentials.";
      setErrorMsg(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {/* ========================================================================= */}
      {/* 📱 MOBILE VIEW ONLY (< lg) - Rich, fulfilling native-style mobile layout  */}
      {/* ========================================================================= */}
      <div className="relative flex min-h-screen w-full flex-col justify-between overflow-hidden bg-gradient-to-b from-slate-50 via-[#f8fafc] to-slate-100/90 px-4 py-8 font-sans text-slate-900 antialiased selection:bg-slate-900 selection:text-white sm:px-6 sm:py-12 lg:hidden">
        {/* Subtle ambient light gradient in background */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute -top-24 left-1/2 -translate-x-1/2 h-72 w-96 rounded-full bg-slate-200/40 blur-3xl" />
          <div className="absolute -bottom-24 right-0 h-64 w-64 rounded-full bg-slate-200/30 blur-3xl" />
        </div>

        <div />

        {/* Centered Main Form Card */}
        <div className="relative z-10 mx-auto w-full max-w-[400px] rounded-3xl border border-slate-200/80 bg-white/95 p-6 shadow-[0_16px_48px_rgba(0,0,0,0.06),0_2px_8px_rgba(0,0,0,0.03)] backdrop-blur-md sm:p-8">
          {/* Top Logo Container */}
          <div className="mb-6 flex justify-center">
            <BrandLogo
              variant="full"
              className="h-16 w-[240px] sm:h-18 sm:w-[260px]"
              imageClassName="object-contain object-center"
            />
          </div>

          {/* Heading and Subtitle */}
          <div className="mb-7 text-center">
            <h1 className="text-[26px] font-black tracking-tight text-slate-900 sm:text-[28px]">
              Welcome back
            </h1>
            <p className="mt-1 text-[13.5px] font-medium text-slate-500">
              Sign in to continue
            </p>
          </div>

          {/* Error Alert Message */}
          {errorMsg ? (
            <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50/90 p-3 text-[12px] font-semibold text-rose-800 shadow-2xs">
              <Icon name="error" className="mt-0.5 shrink-0 text-[16px] text-rose-600" />
              <div className="flex-1 text-left">{errorMsg}</div>
            </div>
          ) : null}

          {/* Mobile Login Form */}
          <form onSubmit={onLogin} className="space-y-4">
            {/* Phone or Email Input */}
            <div>
              <div
                className={cn(
                  "group flex h-[54px] items-center gap-3 rounded-2xl border bg-slate-50/60 px-4 transition-all focus-within:bg-white focus-within:ring-4",
                  identifierError
                    ? "border-rose-300 ring-4 ring-rose-500/10"
                    : "border-slate-200/90 hover:border-slate-300 focus-within:border-slate-900 focus-within:ring-slate-900/5 shadow-2xs",
                )}
              >
                <Icon name="person" className="text-[20px] text-slate-400 transition-colors group-focus-within:text-slate-700" />
                <input
                  type="text"
                  value={formData.identifier}
                  onChange={(e) =>
                    setFormData((current) => ({
                      ...current,
                      identifier: e.target.value,
                    }))
                  }
                  placeholder="Phone or Email"
                  aria-label="Phone or Email"
                  className="h-full w-full bg-transparent text-[14px] font-semibold text-slate-900 outline-none placeholder:font-normal placeholder:text-slate-400"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      setTouched({ identifier: true, password: true });
                    }
                  }}
                />
              </div>
              {identifierError ? (
                <div className="mt-1.5 text-left text-[11px] font-bold text-rose-600">
                  {identifierError}
                </div>
              ) : null}
            </div>

            {/* Password Input */}
            <div>
              <div
                className={cn(
                  "group flex h-[54px] items-center gap-3 rounded-2xl border bg-slate-50/60 px-4 transition-all focus-within:bg-white focus-within:ring-4",
                  passwordError
                    ? "border-rose-300 ring-4 ring-rose-500/10"
                    : "border-slate-200/90 hover:border-slate-300 focus-within:border-slate-900 focus-within:ring-slate-900/5 shadow-2xs",
                )}
              >
                <Icon name="lock" className="text-[20px] text-slate-400 transition-colors group-focus-within:text-slate-700" />
                <input
                  type={showPw ? "text" : "password"}
                  value={formData.password}
                  onChange={(e) =>
                    setFormData((current) => ({
                      ...current,
                      password: e.target.value,
                    }))
                  }
                  placeholder="••••••••••••"
                  aria-label="Password"
                  className="h-full w-full bg-transparent text-[14px] font-semibold text-slate-900 outline-none placeholder:font-normal placeholder:text-slate-400"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      setTouched({ identifier: true, password: true });
                      if (canSubmit) onLogin();
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  className="rounded-lg p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-800"
                  title={showPw ? "Hide password" : "Show password"}
                  aria-label={showPw ? "Hide password" : "Show password"}
                >
                  <Icon
                    name={showPw ? "visibility" : "visibility_off"}
                    className="text-[20px]"
                  />
                </button>
              </div>
              {passwordError ? (
                <div className="mt-1.5 text-left text-[11px] font-bold text-rose-600">
                  {passwordError}
                </div>
              ) : null}
            </div>

            {/* Primary Sign in Button */}
            <button
              type="submit"
              disabled={loading}
              className={cn(
                "mt-2 flex h-[54px] w-full items-center justify-center gap-2 rounded-2xl bg-[#11120d] text-[15px] font-bold text-white shadow-sm transition-all duration-150 hover:bg-black hover:shadow-md active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60",
              )}
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <Icon name="progress_activity" className="animate-spin text-[18px]" />
                  <span>Signing in...</span>
                </span>
              ) : (
                <>
                  <span>Sign in</span>
                  <Icon name="arrow_forward" className="text-[17px]" />
                </>
              )}
            </button>
          </form>
        </div>

        {/* Mobile Bottom Footer */}
        <div className="relative z-10 mt-6 flex justify-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-slate-200/80 bg-white/80 px-4 py-1.5 text-[11.5px] font-semibold text-slate-500 shadow-2xs backdrop-blur-sm">
            <Icon name="shield" className="text-[14px] text-slate-400" />
            <span>Encrypted POS session</span>
          </div>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* 🖥️ DESKTOP VIEW ONLY (>= lg) - Exact original approved desktop layout     */}
      {/* ========================================================================= */}
      <div className="hidden min-h-screen w-full overflow-hidden bg-[#EEF2F6] font-sans lg:block">
        <div className="relative flex min-h-screen items-center justify-center px-4 py-8 sm:px-6 lg:px-8">
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.95),rgba(238,242,246,0.9)_34%,rgba(226,232,240,0.95)_100%)]" />
            <div className="absolute left-[-8%] top-[-10%] h-[420px] w-[420px] rounded-full bg-white/70 blur-3xl" />
            <div className="absolute bottom-[-18%] right-[-8%] h-[420px] w-[420px] rounded-full bg-slate-200/50 blur-3xl" />

            <div className="absolute inset-0 flex items-center justify-center opacity-5">
              <img
                src="/assets/images/Login.png"
                alt=""
                aria-hidden="true"
                className="w-full max-w-[2000px] object-contain"
              />
            </div>
          </div>

          <div className="relative z-10 w-full max-w-[1240px] overflow-hidden rounded-[28px] border border-[#D9DDE3] bg-white">
            <div className="grid min-h-[720px] lg:grid-cols-[420px_520px] xl:grid-cols-[420px_820px]">
              <div className="relative flex items-center px-6 py-10 sm:px-10 lg:px-12 xl:px-16">
                <div className="w-full max-w-[318px]">
                  <div className="mb-10 space-y-4">
                    <div className="inline-flex py-1.5 text-[11px]">
                      <BrandLogo className="h-12 w-[252px]" />
                    </div>

                    <div className="space-y-2">
                      <h2 className="text-[38px] font-extrabold leading-none text-[#2B5563] sm:text-[32px]">
                        Login
                      </h2>
                      <p className="text-[15px] font-medium text-[#4B5563]">
                        Welcome to {navData.brand.name}
                      </p>
                    </div>
                  </div>

                  {errorMsg ? (
                    <div className="mb-5 rounded-[14px] border-2 border-rose-200 bg-rose-50 px-4 py-3 text-[13px] font-bold text-rose-700">
                      {errorMsg}
                    </div>
                  ) : null}

                  <form onSubmit={onLogin} className="space-y-5">
                    <Field label="Phone or email">
                      <TextInput
                        value={formData.identifier}
                        onChange={(value) =>
                          setFormData((current) => ({ ...current, identifier: value }))
                        }
                        placeholder="98XXXXXXXX or name@example.com"
                        type="text"
                        left={<Icon name="person" className="text-[#8C8889]" />}
                        hasError={!!identifierError}
                        onEnter={() =>
                          setTouched({ identifier: true, password: true })
                        }
                      />
                      {identifierError ? (
                        <div className="mt-1 text-[11px] font-semibold text-rose-500">
                          {identifierError}
                        </div>
                      ) : null}
                    </Field>

                    <div className="space-y-2">
                      <Field label="Password">
                        <TextInput
                          value={formData.password}
                          onChange={(value) =>
                            setFormData((current) => ({
                              ...current,
                              password: value,
                            }))
                          }
                          placeholder="password"
                          type={showPw ? "text" : "password"}
                          onEnter={() => {
                            setTouched({ identifier: true, password: true });
                            if (canSubmit) onLogin();
                          }}
                          left={<Icon name="lock" className="text-[#8C8889]" />}
                          hasError={!!passwordError}
                          right={
                            <button
                              type="button"
                              onClick={() => setShowPw((value) => !value)}
                              className="text-[#8C8889] transition hover:text-[#000000]"
                              title={showPw ? "Hide password" : "Show password"}
                            >
                              <Icon
                                name={showPw ? "visibility" : "visibility_off"}
                              />
                            </button>
                          }
                        />
                        {passwordError ? (
                          <div className="mt-1 text-[11px] font-semibold text-rose-500">
                            {passwordError}
                          </div>
                        ) : null}
                      </Field>
                    </div>

                    <Button
                      variant="primary"
                      className="mt-3 w-full text-[15px]"
                      type="submit"
                      disabled={!canSubmit}
                    >
                      {loading ? (
                        <span className="animate-pulse">Processing...</span>
                      ) : (
                        <>
                          <Icon name="login" className="text-white" />
                          Sign in
                        </>
                      )}
                    </Button>
                  </form>

                  <div className="pt-6 text-center text-[11px] font-bold text-[#9CA3AF]">
                    Copyright {new Date().getFullYear()} {navData.brand.name}
                  </div>
                </div>
              </div>

              <div className="relative hidden min-h-[720px] items-center justify-end overflow-hidden lg:flex">
                <div className="relative flex h-full w-full items-center justify-end">
                  <img
                    src="/assets/images/Login.png"
                    alt="Login visual"
                    className="h-full w-full object-cover object-center"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
