import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  build: {
    rollupOptions: {
      output: {
        // Grouped by resolved module path rather than by bare specifier: the
        // specifier form ("react", "react-dom") emitted an empty chunk, because
        // what actually lands in the graph are Vite's pre-bundled deps, not
        // those ids.
        //
        // `three` is already split out by the React.lazy boundary in
        // Gallery.tsx — naming it here only keeps the chunk name stable across
        // builds. `react` and `providers` are caching wins rather than startup
        // wins (both are on the startup path), but they change far less often
        // than app code, so a release invalidates only the chunk that changed.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return;
          if (/[\\/]node_modules[\\/](three|@react-three)[\\/]/.test(id))
            return "three";
          if (
            /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)
          )
            return "react";
          if (/[\\/]node_modules[\\/](@fal-ai|replicate)[\\/]/.test(id))
            return "providers";
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
