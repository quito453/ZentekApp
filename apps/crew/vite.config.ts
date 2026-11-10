import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// VITE_BASE lets the same app be published under a sub-path, e.g. /ZentekApp/live/tech/ on GitHub Pages.
export default defineConfig({
  base: process.env.VITE_BASE || "/",
  plugins: [react()],
});
