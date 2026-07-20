import { auth, signIn } from "@/lib/auth";
import { redirect } from "next/navigation";
import { LoginCard } from "@/components/login-card";

export default async function LoginPage() {
  const session = await auth();
  if (session?.user) redirect("/home");

  async function signInAction() {
    "use server";
    await signIn("discord", { redirectTo: "/home" });
  }

  return <LoginCard signInAction={signInAction} />;
}
