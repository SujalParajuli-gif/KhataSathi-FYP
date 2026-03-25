// frontend/app/lib/api/client.ts — Axios API client with JWT auth
import axios from "axios";

// Create axios instance with base URL from env
const api = axios.create({
    baseURL: import.meta.env.VITE_API_BASE_URL || "http://localhost:4000",
    headers: {
        "Content-Type": "application/json",
    },
});

// ─── Request Interceptor: Attach JWT token ──────────
api.interceptors.request.use((config) => {
    if (typeof window !== "undefined") {
        const token = localStorage.getItem("khatasathi_token");
        if (token) {
            config.headers.Authorization = `Bearer ${token}`;
        }
    }
    return config;
});

// ─── Response Interceptor: Handle 401 ───────────────
api.interceptors.response.use(
    (response) => response,
    (error) => {
        if (error.response?.status === 401) {
            // Token expired or invalid — clear auth and redirect to login
            if (typeof window !== "undefined") {
                localStorage.removeItem("khatasathi_token");
                localStorage.removeItem("khatasathi_auth_user");

                // Only redirect if not already on login page
                if (!window.location.pathname.includes("/login")) {
                    window.location.href = "/login";
                }
            }
        }
        return Promise.reject(error);
    }
);

export default api;
