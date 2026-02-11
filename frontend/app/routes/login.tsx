// frontend/app/routes/login.ui-only.tsx
// Import React hooks for component state management
import React, { useState } from "react";
// Import Google Material Icons component
import GoogleIcon from "~/components/ui/GoogleIcon";

// Utility function to combine class names conditionally
function cn(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(" ");
}

// Reusable Field component for form inputs with optional label
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
      {/* Display label text if provided */}
      {label ? (
        <div className="text-[11px] font-extrabold text-slate-500 uppercase tracking-wider mb-2">
          {label}
        </div>
      ) : null}
      {children}
    </div>
  );
}

// Reusable TextInput component with icon support and enter key handling
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
    // Input container with focus state styling
    <div className="group h-[48px] rounded-[14px] border-2 border-slate-200 bg-slate-50 focus-within:bg-white focus-within:border-orange-500 transition-colors px-[14px] flex items-center gap-3">
      {/* Left icon slot */}
      {left}
      {/* Main input field */}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        onKeyDown={(e) => {
          // Trigger onEnter callback when Enter key is pressed
          if (e.key === "Enter" && onEnter) onEnter();
        }}
        className="w-full h-full bg-transparent outline-none text-[13px] font-bold text-slate-900 placeholder:text-slate-400 placeholder:font-medium"
      />
      {/* Right icon slot */}
      {right}
    </div>
  );
}

// Reusable Button component with multiple style variants
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
  // Base styles applied to all button variants
  const baseClass =
    "h-[48px] rounded-[14px] font-extrabold text-[13px] border-2 transition flex items-center justify-center gap-2 px-6 active:scale-95";
  // Variant-specific styles for different button types
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

// Define authentication mode types
type AuthMode = "login" | "register";

// Main login/register page component
export default function LoginUiOnly() {
  // State to track current mode (login or register)
  const [mode, setMode] = useState<AuthMode>("login");
  // State to toggle password visibility
  const [showPwd, setShowPwd] = useState(false);
  // State to track form submission loading state
  const [isLoading, setIsLoading] = useState(false);

  // State to store form input values
  const [formData, setFormData] = useState({
    email: "",
    password: "",
    fullName: "",
  });

  // Validation logic to enable/disable submit button
  const canSubmit =
    formData.email.trim().length > 0 &&
    formData.password.length >= 4 &&
    (mode === "login" || formData.fullName.trim().length > 0) &&
    !isLoading;

  // Handle form submission
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    // Simulate API call with loading state
    setIsLoading(true);
    setTimeout(() => {
      setIsLoading(false);
    }, 900);
  }

  return (
    // Main container with two-panel layout
    <div className="min-h-screen w-full bg-slate-50 flex overflow-hidden font-sans">
      {/* Left panel with branding and promotional content (desktop only) */}
      <div className="hidden lg:flex flex-1 bg-slate-900 relative items-center justify-center p-12 overflow-hidden">
        {/* Decorative background blur effects */}
        <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] bg-orange-600/20 rounded-full blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[500px] h-[500px] bg-blue-600/20 rounded-full blur-[100px]" />

        {/* Main branding content */}
        <div className="relative z-10 max-w-md text-white space-y-8">
          {/* Application logo */}
          <div className="w-[64px] h-[64px] rounded-[18px] bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center shadow-xl shadow-orange-900/50">
            <GoogleIcon name="dataset" className="text-[32px] text-white" />
          </div>

          {/* Marketing headline and description */}
          <div className="space-y-4">
            <h1 className="text-[42px] font-extrabold leading-[1.1] tracking-tight">
              Manage your <br />
              <span className="text-orange-500">Business</span> Logic.
            </h1>
            <p className="text-slate-400 text-[16px] leading-relaxed font-medium">
              Join thousands of cashiers and managers using KhataSathi to
              streamline daily billing, track inventory, and secure payments.
            </p>
          </div>

          {/* Feature highlight card */}
          <div className="mt-8 p-5 rounded-[22px] bg-white/10 border border-white/10 backdrop-blur-md">
            <div className="flex items-center gap-4 mb-4">
              {/* Feature icon */}
              <div className="w-10 h-10 rounded-full bg-slate-200/20 flex items-center justify-center">
                <GoogleIcon name="verified_user" className="text-orange-400" />
              </div>
              {/* Feature text */}
              <div>
                <div className="text-[13px] font-bold text-white">
                  Secure Access
                </div>
                <div className="text-[11px] text-slate-400">
                  End-to-end encrypted
                </div>
              </div>
            </div>
            {/* Visual progress indicator */}
            <div className="h-2 w-full bg-white/10 rounded-full overflow-hidden">
              <div className="h-full w-[70%] bg-orange-500 rounded-full" />
            </div>
          </div>
        </div>
      </div>

      {/* Right panel containing login/register form */}
      <div className="flex-1 flex flex-col items-center justify-center p-6 lg:p-12 relative">
        {/* Mode switcher button (login/register toggle) */}
        <div className="absolute top-6 right-6 lg:top-12 lg:right-12">
          <div className="text-[13px] font-bold text-slate-500">
            {mode === "login"
              ? "Don't have an account?"
              : "Already have an account?"}
            <button
              type="button"
              onClick={() => setMode(mode === "login" ? "register" : "login")}
              className="ml-2 text-orange-600 hover:underline decoration-2 underline-offset-4"
            >
              {mode === "login" ? "Sign Up" : "Log In"}
            </button>
          </div>
        </div>

        {/* Form container */}
        <div className="w-full max-w-[400px] space-y-8">
          {/* Form header with title and description */}
          <div className="space-y-2 text-center lg:text-left">
            <h2 className="text-[28px] font-extrabold text-slate-900">
              {mode === "login" ? "Welcome Back" : "Create Account"}
            </h2>
            <p className="text-slate-500 text-[14px] font-medium">
              {mode === "login"
                ? "Enter your credentials to access your dashboard."
                : "Enter your details to get started with KhataSathi."}
            </p>
          </div>

          {/* Login/Register form */}
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Full name field (only shown in register mode) */}
            {mode === "register" ? (
              <Field label="Full Name">
                <TextInput
                  value={formData.fullName}
                  onChange={(v) => setFormData((p) => ({ ...p, fullName: v }))}
                  placeholder="e.g. John Doe"
                  left={<GoogleIcon name="person" className="text-slate-400" />}
                />
              </Field>
            ) : null}

            {/* Email input field */}
            <Field label="Email Address">
              <TextInput
                value={formData.email}
                onChange={(v) => setFormData((p) => ({ ...p, email: v }))}
                placeholder="name@company.com"
                type="email"
                left={<GoogleIcon name="mail" className="text-slate-400" />}
              />
            </Field>

            {/* Password field with visibility toggle */}
            <div className="space-y-2">
              <Field label="Password">
                <TextInput
                  value={formData.password}
                  onChange={(v) => setFormData((p) => ({ ...p, password: v }))}
                  placeholder="••••••••"
                  type={showPwd ? "text" : "password"}
                  left={<GoogleIcon name="lock" className="text-slate-400" />}
                  right={
                    // Toggle password visibility button
                    <button
                      type="button"
                      onClick={() => setShowPwd(!showPwd)}
                      className="text-slate-400 hover:text-slate-600 transition"
                      title={showPwd ? "Hide password" : "Show password"}
                    >
                      <GoogleIcon
                        name={showPwd ? "visibility" : "visibility_off"}
                      />
                    </button>
                  }
                />
              </Field>

              {/* Forgot password link (only shown in login mode) */}
              {mode === "login" ? (
                <div className="flex justify-end">
                  <button
                    type="button"
                    className="text-[12px] font-bold text-slate-500 hover:text-orange-600 transition"
                  >
                    Forgot Password?
                  </button>
                </div>
              ) : null}
            </div>

            {/* Submit button with loading state */}
            <Button
              variant="primary"
              className="w-full mt-4 h-[52px] text-[15px]"
              type="submit"
              disabled={!canSubmit}
            >
              {isLoading ? (
                <span className="animate-pulse">Processing...</span>
              ) : mode === "login" ? (
                "Sign In"
              ) : (
                "Create Account"
              )}
            </Button>
          </form>

          {/* Divider for alternative login methods */}
          <div className="flex items-center gap-4">
            <div className="h-[2px] flex-1 bg-slate-100" />
            <div className="text-[11px] font-extrabold text-slate-400 uppercase tracking-widest">
              Or continue with
            </div>
            <div className="h-[2px] flex-1 bg-slate-100" />
          </div>

          {/* Social login buttons */}
          <div className="grid grid-cols-2 gap-3">
            {/* Google login button */}
            <Button variant="outline" className="h-[44px]">
              <GoogleIcon name="add_circle" className="text-slate-500" />
              Google
            </Button>
            {/* Passkey login button */}
            <Button variant="outline" className="h-[44px]">
              <GoogleIcon name="fingerprint" className="text-slate-500" />
              Passkey
            </Button>
          </div>
        </div>

        {/* Footer with copyright and legal links */}
        <div className="absolute bottom-6 text-[11px] font-bold text-slate-400 text-center w-full">
          © 2024 KhataSathi System.{" "}
          <a href="#" className="hover:text-slate-600">
            Privacy
          </a>{" "}
          •{" "}
          <a href="#" className="hover:text-slate-600">
            Terms
          </a>
        </div>
      </div>
    </div>
  );
}
