import axios from "axios";
import { API_BASE_URL } from "./baseUrl";

// creating a shared axios instance with the API base URL
// every API call in the app uses this client so we don't repeat the base URL everywhere
const api = axios.create({
    baseURL: API_BASE_URL,
    headers: {
        "Content-Type": "application/json",
    },
});

// request interceptor — attaching the JWT token from localStorage to every outgoing request
// this way the backend knows which user is making the request
api.interceptors.request.use((config) => {
    if (typeof window !== "undefined") {
        const token = localStorage.getItem("khatasathi_token");
        if (token) {
            config.headers.Authorization = `Bearer ${token}`;
        }
    }
    return config;
});

// response interceptor — handling 401 (unauthorized) responses globally
// when the backend says 401, it means our token is invalid or expired
// so we clear the auth state and redirect to login to force re-authentication
api.interceptors.response.use(
    (response) => response, // successful responses pass through unchanged
    (error) => {
        if (error.response?.status === 401) {
            if (typeof window !== "undefined") {
                localStorage.removeItem("khatasathi_token");
                localStorage.removeItem("khatasathi_auth_user");

                // only redirecting to login if we are not already on the login page
                if (!window.location.pathname.includes("/login")) {
                    window.location.href = "/login";
                }
            }
        }
        return Promise.reject(error);
    }
);

export default api;

