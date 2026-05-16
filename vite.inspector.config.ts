import { defineConfig } from "vite";

export default defineConfig({
  root: "inspector",
  build: {
    outDir: "../dist-inspector",
    emptyOutDir: true
  }
});
