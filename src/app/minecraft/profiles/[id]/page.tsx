import { MinecraftProfileDetail } from "@/components/minecraft-profile-detail";

export default async function ProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MinecraftProfileDetail key={id} id={id} />;
}
