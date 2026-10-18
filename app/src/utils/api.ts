import axios, { AxiosError } from "axios";
import { clearAccessToken, getAccessToken } from "./tokenStore";

const api = axios.create({
  baseURL: "/api/v1",
  timeout: 15_000,
  headers: { "Content-Type": "application/json" },
  // Send cookies so the HttpOnly refresh cookie reaches the auth endpoints.
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  try {
    // The access token lives ONLY in the in-memory store — never localStorage.
    const token = getAccessToken();
    if (token) config.headers.Authorization = `Bearer ${token}`;
  } catch {
    // ignore
  }
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err: AxiosError<{ error?: string }>) => {
    const status = err.response?.status;
    if (status === 401) {
      clearAccessToken();
      try {
        localStorage.removeItem("upg:me");
        // Legacy cleanup — the token must never be persisted again.
        localStorage.removeItem("upg:token");
      } catch {}
      if (!location.pathname.startsWith("/login")) {
        location.href = "/login";
      }
    }
    return Promise.reject(err);
  }
);

export default api;
