import { EmptyState } from "@/components/EmptyState";
import { createDbFromEnv, getPublicationByPath } from "@isp/db";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function IntelligencePage({
  params,
}: {
  params: Promise<{ slug: string[] }>;
}) {
  const { slug } = await params;
  const pathname = `/intelligence/${slug.map((part) => encodeURIComponent(part)).join("/")}`;
  let publication = null;
  try {
    publication = await getPublicationByPath(createDbFromEnv(), pathname);
  } catch {
    publication = null;
  }
  if (!publication?.draft) {
    notFound();
  }
  return (
    <>
      <h1>{publication.draft.title}</h1>
      <p className="muted">
        robots: {publication.publication.robots} · {publication.publication.indexable ? "indexable" : "noindex"} ·
        approved {publication.publication.approvedAt.toISOString()}
      </p>
      {publication.publication.indexable ? null : (
        <EmptyState title="Not indexed" body="Thin, duplicate, or insufficient evidence stays noindex." />
      )}
      <article>
        <p>{publication.draft.bodyText}</p>
      </article>
    </>
  );
}
