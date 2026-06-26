import { defineConfig } from "vite";

// Forge's VitePlugin handles all preload script build configuration.
export default defineConfig({
  build: {
    minify: false,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      // Disable tree shaking (it's not working for Electron modules anyway)
      treeshake: false,
      // Prevent code splitting for Electron preload scripts
      output: {
        manualChunks: undefined,
        inlineDynamicImports: true,
      },
    },
  },
});
