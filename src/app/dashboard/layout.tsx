import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { RoadhogDrawer } from "@/components/roadhog-drawer";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <RoadhogDrawer />
        <div className="p-4 sm:p-6 lg:p-8 min-h-full flex flex-col">
          <div className="flex-1 max-lg:pt-12">{children}</div>
          <footer className="text-center text-xs text-muted-foreground pt-8 pb-4 border-t border-border/50 mt-8">
            created by{" "}
            <a
              href="https://github.com/aybarsyazici/yoshling-mcserver"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              yoshiane
            </a>
          </footer>
        </div>
      </main>
    </div>
  );
}
