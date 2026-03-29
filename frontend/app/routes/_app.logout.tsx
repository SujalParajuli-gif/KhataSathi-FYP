import { useState } from "react";
import { useNavigate } from "react-router";
import { ConfirmDialog } from "~/components/ui/Modal";
import { clearAuthUser } from "~/lib/auth";

export default function LogoutPage() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  function cancel() {
    navigate("/", { replace: true });
  }

  function confirm() {
    setBusy(true);
    clearAuthUser();
    window.dispatchEvent(new Event("auth_change"));
    navigate("/login", { replace: true });
  }

  return (
    <div className="min-h-[40vh]">
      <ConfirmDialog
        open
        title="Log out?"
        message="Are you sure you want to log out of your account?"
        confirmLabel="Log out"
        cancelLabel="Cancel"
        onConfirm={confirm}
        onClose={cancel}
        tone="danger"
        icon="logout"
        busy={busy}
      />
    </div>
  );
}
