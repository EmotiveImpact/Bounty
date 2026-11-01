// The dev server must never hand out local data: the database, ledger
// proofs and shelf photos live in .data/ inside the project by default, so
// they are denied alongside Vite's own defaults. A BOUNTY_DATA_DIR inside
// the project should also be named .data.
export default {
  server: {
    host: "127.0.0.1",
    proxy: { "/api": "http://127.0.0.1:4174" },
    fs: {
      deny: [
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
};
