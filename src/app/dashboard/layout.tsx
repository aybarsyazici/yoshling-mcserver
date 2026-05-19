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
      <div className="flex-1 flex flex-col overflow-hidden">
        <RoadhogDrawer />
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 max-lg:pt-12">
          {children}
        </main>
        <footer className="flex-shrink-0 text-center text-xs text-muted-foreground py-3 border-t border-border/50 bg-background">
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
    </div>
  );
}
