import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Relative base so the build works at any GitHub Pages subpath.
export default defineConfig({
  plugins: [react()],
  base: "./",
});
