import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Backdrop } from "@/components/ui-bits";
import { HomeChrome } from "@/components/home-chrome";

export default async function HomeLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <div className="relative flex min-h-screen flex-col">
      <Backdrop tintA="var(--mc)" tintB="var(--sd)" />
      <HomeChrome
        user={{ name: session.user.name, image: session.user.image, role: session.user.role }}
      />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6 lg:py-16">
        {children}
      </main>
      <footer className="px-4 py-6 text-center text-xs text-muted-foreground">
        created by{" "}
        <a
          href="https://github.com/aybarsyazici/yoshling-mcserver"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          yoshiane
        </a>
        {" · "}one box, two worlds
      </footer>
    </div>
  );
}
