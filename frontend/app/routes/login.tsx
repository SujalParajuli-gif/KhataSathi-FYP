// frontend/app/routes/login.tsx
import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import Icon from "~/components/ui/Icon";
import navData from "~/config/ui.nav.json";
import type { AuthUser, UserRole } from "~/lib/auth";
import { setAuthUser, setToken, isLoggedIn } from "~/lib/auth";
import { loginApi } from "~/lib/api/endpoints";

// --- Utility ---
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
        <div className="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-2">
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
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  right?: React.ReactNode;
  left?: React.ReactNode;
  type?: string;
  onEnter?: () => void;
}) {
  return (
    <div className="group h-[48px] rounded-[14px] border-2 border-slate-200 bg-slate-50 focus-within:bg-white focus-within:border-orange-500 transition-colors px-[14px] flex items-center gap-3">
      {left}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onEnter) onEnter();
        }}
        className="w-full h-full bg-transparent outline-none text-[13px] font-bold text-slate-900 placeholder:text-slate-400 placeholder:font-medium"
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
    "h-[48px] rounded-[14px] font-extrabold text-[13px] border-2 transition flex items-center justify-center gap-2 px-6 active:scale-95";
  const variants = {
    primary:
      "bg-orange-500 hover:bg-orange-600 text-white border-orange-500 shadow-md hover:shadow-lg shadow-orange-500/20",
    outline:
      "bg-white hover:bg-slate-50 text-slate-700 border-slate-200 hover:border-slate-300",
    ghost:
      "bg-transparent border-transparent text-slate-500 hover:text-orange-600 hover:bg-orange-50",
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
        disabled && "opacity-50 pointer-events-none",
      )}
    >
      {children}
    </button>
  );
}

export default function LoginPage() {
  const navigate = useNavigate();

  const [showPw, setShowPw] = useState(false);
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Form state
  const [formData, setFormData] = useState({
    email: "",
    password: "",
  });

  // Redirect if already logged in
  React.useEffect(() => {
    if (isLoggedIn()) {
      const stored = localStorage.getItem("khatasathi_auth_user") || sessionStorage.getItem("khatasathi_auth_user");
      if (stored) {
        const user = JSON.parse(stored);
        navigate(user.role === "cashier" ? "/billing" : "/");
      }
    }
  }, []);

  const canSubmit = useMemo(() => {
    const emailOk = formData.email.trim().length > 0;
    const pwOk = formData.password.length >= 4;
    return emailOk && pwOk && !loading;
  }, [formData, loading]);

  async function onLogin(e?: React.FormEvent) {
    e?.preventDefault();
    setErrorMsg(null);

    const email = formData.email.trim();
    if (!email) return setErrorMsg("Please enter your email.");
    if (formData.password.length < 4)
      return setErrorMsg("Password is too short.");

    setLoading(true);

    try {
      // Call real backend API
      const data = await loginApi(email, formData.password);

      // Store JWT token
      setToken(data.token);

      // Store user info (role will be lowercased by setAuthUser)
      const user: AuthUser = {
        id: data.user.id,
        name: data.user.name,
        email: data.user.email,
        role: data.user.role.toLowerCase() as UserRole,
      };
      setAuthUser(user, remember);

      // Redirect by role
      if (user.role === "cashier") {
        navigate("/billing");
      } else {
        navigate("/");
      }
    } catch (err: any) {
      const msg =
        err.response?.data?.error || "Login failed. Please check your credentials.";
      setErrorMsg(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen w-full bg-slate-50 flex items-center justify-center overflow-hidden font-sans">
      <div className="w-full max-w-[420px] p-6 space-y-8">
        {/* Brand Header */}
        <div className="flex flex-col items-center gap-4">
          <div className="w-[64px] h-[64px] rounded-[18px] bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center shadow-xl shadow-orange-500/20 font-extrabold text-white text-[22px]">
            {navData.brand.logoText}
          </div>
          <div className="text-center space-y-1">
            <h2 className="text-[28px] font-extrabold text-slate-900">
              Welcome Back
            </h2>
            <p className="text-slate-500 text-[14px] font-medium">
              Sign in to {navData.brand.name}
            </p>
          </div>
        </div>

        {errorMsg ? (
          <div className="rounded-[14px] border-2 border-rose-200 bg-rose-50 px-4 py-3 text-[13px] font-bold text-rose-700">
            {errorMsg}
          </div>
        ) : null}

        {/* Form */}
        <form onSubmit={onLogin} className="space-y-5">
          <Field label="Email">
            <TextInput
              value={formData.email}
              onChange={(v) =>
                setFormData((p) => ({ ...p, email: v }))
              }
              placeholder="e.g. admin@khatasathi.com"
              type="email"
              left={<Icon name="person" className="text-slate-400" />}
            />
          </Field>

          <div className="space-y-2">
            <Field label="Password">
              <TextInput
                value={formData.password}
                onChange={(v) => setFormData((p) => ({ ...p, password: v }))}
                placeholder="••••••••"
                type={showPw ? "text" : "password"}
                onEnter={() => (canSubmit ? onLogin() : null)}
                left={<Icon name="lock" className="text-slate-400" />}
                right={
                  <button
                    type="button"
                    onClick={() => setShowPw((v) => !v)}
                    className="text-slate-400 hover:text-slate-600 transition"
                    title={showPw ? "Hide password" : "Show password"}
                  >
                    <Icon
                      name={showPw ? "visibility" : "visibility_off"}
                    />
                  </button>
                }
              />
            </Field>

            <div className="flex items-center">
              <label className="inline-flex items-center gap-2 text-[12px] font-bold text-slate-600 select-none">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="h-4 w-4"
                />
                Remember me
              </label>
            </div>
          </div>

          <Button
            variant="primary"
            className="w-full mt-2 h-[52px] text-[15px]"
            type="submit"
            disabled={!canSubmit}
          >
            {loading ? (
              <span className="animate-pulse">Processing...</span>
            ) : (
              <>
                <Icon name="login" className="text-white" />
                Sign In
              </>
            )}
          </Button>
        </form>

        {/* Footer */}
        <div className="pt-4 text-[11px] font-bold text-slate-400 text-center">
          © {new Date().getFullYear()} {navData.brand.name}
        </div>
      </div>
    </div>
  );
}
