import { useState } from "react";
import { useNavigate } from "react-router";
import { ConfirmDialog } from "~/components/ui/Modal";
import { clearAuthUser } from "~/lib/auth";

// simple logout route that shows a confirmation dialog
export default function LogoutPage() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false); // tracks whether the logout confirmation is already running

  // this closes the dialog flow and sends the user back to their safe default page
  // we use replace so the temporary logout route does not stay in browser history
  function cancel() {
    navigate("/", { replace: true });
  }

  // clearing auth data and dispatching the event so AppShell rerenders
  function confirm() {
    setBusy(true);
    clearAuthUser();
    window.dispatchEvent(new Event("auth_change"));
    navigate("/login", { replace: true });
  }

  // showing the confirmation modal as the whole page content
  // this route exists only to confirm the action before we clear the stored session
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

