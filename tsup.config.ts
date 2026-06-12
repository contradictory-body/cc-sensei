import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  target: "es2022",
  clean: true,
  shims: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
