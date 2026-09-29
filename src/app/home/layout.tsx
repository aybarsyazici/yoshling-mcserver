import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Backdrop } from "@/components/ui-bits";
import { HomeChrome } from "@/components/home-chrome";
import { OperationLedger } from "@/components/operation-ledger";
import { OperationsProvider } from "@/components/operations-provider";
import { operationsPayload } from "@/lib/operations";

export default async function HomeLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const initialOps = await operationsPayload(session.user.games);

  return (
    <OperationsProvider initial={initialOps}>
    <div className="relative flex min-h-screen flex-col">
      <Backdrop tintA="var(--mc)" tintB="var(--sd)" />
      <HomeChrome
        user={{ name: session.user.name, image: session.user.image, role: session.user.role }}
      />
      {/* `/home` does not use DashShell, so for months the landing — the screen with
          the Power Core and the power bus, the first page anyone sees — had no
          refresh-surviving operation feedback at all. `MissionControl` narrated
          itself from local React state that vanished on reload. CLAUDE.md said the
          banner was on every page; it was not. */}
      {/* `HomeChrome` above and `<main>` below are both `max-w-5xl … sm:px-6`, so the
          strip has to share that column — the default (`DashShell`'s `max-w-6xl …
          lg:px-8`) put its glyph and clock 56px outside the content edge on the one page
          whose whole identity is axial symmetry around the Power Core. */}
      <OperationLedger className="mx-auto w-full max-w-5xl px-4 sm:px-6" />
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
        {" · "}one box, three worlds
      </footer>
    </div>
    </OperationsProvider>
  );
}
