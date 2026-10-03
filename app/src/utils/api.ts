import axios, { AxiosError } from "axios";

const api = axios.create({
  baseURL: "/api/v1",
  timeout: 15_000,
  headers: { "Content-Type": "application/json" },
});

api.interceptors.request.use((config) => {
  try {
    const raw = localStorage.getItem("upg:token");
    if (raw) {
      const token = JSON.parse(raw) as string;
      if (token) config.headers.Authorization = `Bearer ${token}`;
    }
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
      try {
        localStorage.removeItem("upg:token");
        localStorage.removeItem("upg:me");
      } catch {}
      if (!location.pathname.startsWith("/login")) {
        location.href = "/login";
      }
    }
    return Promise.reject(err);
  }
);

export default api;
