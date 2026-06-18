import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // Load env files (e.g. VITE_API_BASE_URL) from the monorepo root .env.
  envDir: fileURLToPath(new URL("../../", import.meta.url)),
  server: {
    port: 5173,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return undefined;
          }

          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("/react-router-dom/")
          ) {
            return "react";
          }

          if (id.includes("/@tanstack/react-query/")) {
            return "query";
          }

          if (id.includes("/recharts/")) {
            return "charts";
          }

          if (id.includes("/lucide-react/") || id.includes("/@radix-ui/react-tabs/")) {
            return "ui";
          }

          return undefined;
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./vitest.setup.ts",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
