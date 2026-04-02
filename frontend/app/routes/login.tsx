import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import BrandLogo from "~/components/ui/BrandLogo";
import Icon from "~/components/ui/Icon";
import navData from "~/config/ui.nav.json";
import type { AuthUser, UserRole } from "~/lib/auth";
import { isLoggedIn, setAuthUser, setToken } from "~/lib/auth";
import { loginApi } from "~/lib/api/endpoints";

function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

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
        <div className="mb-2 text-[11px] font-extrabold uppercase  text-[#8C8889]">
          {label}
        </div>
      ) : null}
      {children}
    </div>
  );
}

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
        "flex h-[52px] items-center gap-3 rounded-[14px] border-2 bg-white px-[16px] transition-all duration-200 ",
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
      "border-[#000000] bg-[#000000] text-white hover:bg-[#1F2937] hover:border-[#1F2937]  ",
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
  const [formData, setFormData] = useState({ email: "", password: "" });
  const [touched, setTouched] = useState({ email: false, password: false });

  const emailValue = formData.email.trim();
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailValue);
  const emailError =
    touched.email && !emailValue
      ? "Email is required."
      : touched.email && !emailValid
        ? "Please enter a valid email address."
        : "";
  const passwordError =
    touched.password && !formData.password ? "Password is required." : "";

  React.useEffect(() => {
    if (isLoggedIn()) {
      const stored = localStorage.getItem("khatasathi_auth_user");
      if (stored) {
        const user = JSON.parse(stored);
        navigate(user.role === "cashier" ? "/billing" : "/");
      }
    }
  }, [navigate]);

  const canSubmit = useMemo(() => {
    return (
      emailValid &&
      emailValue.length > 0 &&
      formData.password.length > 0 &&
      !loading
    );
  }, [emailValid, emailValue, formData.password, loading]);

  async function onLogin(e?: React.FormEvent) {
    e?.preventDefault();
    setErrorMsg(null);
    setTouched({ email: true, password: true });

    if (!emailValue) return setErrorMsg("Please enter your email.");
    if (!emailValid) return setErrorMsg("Please enter a valid email address.");
    if (!formData.password) return setErrorMsg("Please enter your password.");

    setLoading(true);

    try {
      const data = await loginApi(emailValue, formData.password);
      setToken(data.token);

      const user: AuthUser = {
        id: data.user.id,
        name: data.user.name,
        email: data.user.email,
        role: data.user.role.toLowerCase() as UserRole,
        profileImage: data.user.profileImage,
      };
      setAuthUser(user);

      navigate(user.role === "cashier" ? "/billing" : "/");
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
    <div className="min-h-screen w-full overflow-hidden bg-[#EEF2F6] font-sans">
      <div className="relative flex min-h-screen items-center justify-center px-4 py-8 sm:px-6 lg:px-8">
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.95),rgba(238,242,246,0.9)_34%,rgba(226,232,240,0.95)_100%)]" />
          <div className="absolute left-[-8%] top-[-10%] h-[420px] w-[420px] rounded-full bg-white/70 blur-3xl" />
          <div className="absolute bottom-[-18%] right-[-8%] h-[420px] w-[420px] rounded-full bg-slate-200/50 blur-3xl" />

          {/* Faded background image behind all components */}
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
                  <div className="inline-flex py-1.5 text-[11px] ">
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
                  <Field label="Email">
                    <TextInput
                      value={formData.email}
                      onChange={(value) =>
                        setFormData((current) => ({ ...current, email: value }))
                      }
                      placeholder="Username or email"
                      type="email"
                      left={<Icon name="person" className="text-[#8C8889]" />}
                      hasError={!!emailError}
                      onEnter={() =>
                        setTouched({ email: true, password: true })
                      }
                    />
                    {emailError ? (
                      <div className="mt-1 text-[11px] font-semibold text-rose-500">
                        {emailError}
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
                          setTouched({ email: true, password: true });
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
                        Sign up
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
              <div className="relative  flex h-full w-full items-center justify-end">
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
  );
}

