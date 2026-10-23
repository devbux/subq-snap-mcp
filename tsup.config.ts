import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  bundle: true,
  splitting: false,
  clean: true,
  dts: false,
  sourcemap: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
