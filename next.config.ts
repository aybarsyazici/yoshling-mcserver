import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Runtime files come from mounted game volumes and Compose's environment.
  // Dynamic filesystem access must not make those host files build artifacts.
  outputFileTracingExcludes: {
    "**": [
      "**/.env*",
      "**/*.{db,sqlite,sqlite3}",
      "**/*.{db,sqlite,sqlite3}-{wal,shm,journal}",
      "**/*.{db,sqlite,sqlite3}.{bak,backup}*",
      "**/*.pem",
      "**/*.key",
      ".git/**/*",
      ".claude/**/*",
      ".codex/**/*",
      ".worktrees/**/*",
      "data/**/*",
      "docs/**/*",
      "tests/**/*",
    ],
  },
  async redirects() {
    return [
      // The app sign-in whitelist was never Minecraft-specific; it lives with the
      // other shared pages now.
      { source: "/minecraft/whitelist", destination: "/whitelist", permanent: true },
    ];
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "cdn.modrinth.com" },
      { protocol: "https", hostname: "cdn-raw.modrinth.com" },
      { protocol: "https", hostname: "cdn.discordapp.com" },
      // Steam Workshop thumbnails for the Project Zomboid mod list
      { protocol: "https", hostname: "*.akamaihd.net" },
      { protocol: "https", hostname: "*.steamstatic.com" },
      { protocol: "https", hostname: "*.steamusercontent.com" },
    ],
  },
};

export default nextConfig;
