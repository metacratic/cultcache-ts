import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "inspector",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../dist-inspector",
    emptyOutDir: true
  }
});
