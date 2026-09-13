import type { Metadata } from "next";
import { Geist, Geist_Mono, Space_Grotesk } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { MikuEasterEgg } from "@/components/miku-easter-egg";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Yoshling — Game Server Control",
  description: "One box, three worlds. Run your Minecraft, 7 Days to Die and Project Zomboid servers.",
  icons: {
    icon: "/fat-yoshi.png",
  },
  openGraph: {
    title: "Yoshling — Game Server Control",
    description: "One box, three worlds. Run your Minecraft, 7 Days to Die and Project Zomboid servers.",
    images: ["/fat-yoshi.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${spaceGrotesk.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <ThemeProvider>
          {children}
          <Toaster />
          <MikuEasterEgg />
        </ThemeProvider>
      </body>
    </html>
  );
}
