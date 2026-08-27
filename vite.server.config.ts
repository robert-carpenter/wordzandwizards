import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "node24",
    ssr: "src/server/server.ts",
    outDir: "dist/server",
    emptyOutDir: false,
    rollupOptions: {
      input: "src/server/server.ts",
      external: [
        "cors",
        "express",
        "socket.io",
        "http",
        "fs",
        "path",
        "url",
        "crypto"
      ],
      output: {
        format: "esm",
        entryFileNames: "index.mjs"
      }
    }
  },
  ssr: {
    external: ["cors", "express", "socket.io"]
  }
});
