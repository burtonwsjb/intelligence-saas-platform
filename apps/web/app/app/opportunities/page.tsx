import { redirect } from "next/navigation";

// Opportunities is now a preset of the Cards explorer. Old links and saved
// filters keep working: compatible parameters carry over.
export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const params = new URLSearchParams({ view: "opportunities" });
  for (const key of ["game", "language", "set", "recommendation", "minOpportunity", "maxRisk", "minLiquidity"]) {
    const value = query[key];
    const text = Array.isArray(value) ? value[0] : value;
    if (text) params.set(key, text);
  }
  redirect(`/app/cards?${params.toString()}`);
}
