// frontend/app/routes/_app.logout.tsx — Logout route
import { useEffect } from "react";
import { useNavigate } from "react-router";
import { clearAuthUser } from "~/lib/auth";

export default function LogoutPage() {
  const navigate = useNavigate();

  useEffect(() => {
    clearAuthUser();
    navigate("/login", { replace: true });
  }, []);

  return (
    <div className="flex items-center justify-center h-64">
      <p className="text-slate-500 font-semibold">Logging out...</p>
    </div>
  );
}
