// Deny the configured private store even when its directory is not .data.
import { resolve } from "node:path";
import { realpathSync, existsSync } from "node:fs";
const store = resolve(process.env.BOUNTY_DATA_DIR || ".data");
const privatePaths = [...new Set([store, ...(existsSync(store) ? [realpathSync(store)] : [])])];
const literalGlob = path => path.replaceAll("\\", "/").replace(/[?*\[\]{}()!+@]/g, "\\$&");

export default {
  server: {
    host: "127.0.0.1",
    proxy: { "/api": "http://127.0.0.1:4174" },
    fs: {
      deny: [
        ...privatePaths.map(path => literalGlob(path) + "/**"),
        ".env",
        ".env.*",
        "*.{crt,pem}",
        "**/.git/**",
        // Character classes keep the match case-insensitive for macOS and
        // Windows file systems, where /.DATA/ would reach the same folder.
        "**/.[dD][aA][tT][aA]/**",
        "**/*.[sS][qQ][lL][iI][tT][eE]",
        "**/*.[sS][qQ][lL][iI][tT][eE]-*",
      ],
    },
  },
  preview: { host: "127.0.0.1" },
  build: {
    rollupOptions: {
      // Radix marks its files "use client" for React Server Components,
      // which this app does not use; the notice is noise here.
      onwarn(warning, warn) {
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
        warn(warning);
      },
    },
  },
};
