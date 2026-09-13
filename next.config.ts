import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
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
