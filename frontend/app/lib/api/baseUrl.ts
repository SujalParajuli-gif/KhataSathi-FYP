// reading the API base URL from the Vite environment variable
// if not set (like in development), we default to localhost:4000 where our backend runs
export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";

