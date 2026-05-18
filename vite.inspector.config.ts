import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: "inspector",
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      react: path.resolve(root, "node_modules/react"),
      "react-dom": path.resolve(root, "node_modules/react-dom"),
      "react/jsx-runtime": path.resolve(root, "node_modules/react/jsx-runtime.js"),
    },
    dedupe: ["react", "react-dom"],
  },
  build: {
    outDir: "../dist-inspector",
    emptyOutDir: true
  }
});
