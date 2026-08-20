import { OPERATOR_TRUST_STATES, getCreatorAuthorityProfile, listCreators } from "@isp/db";
import { requireGrantedOperator } from "@/lib/platform-admin";
import { setCreatorTrustAction } from "@/app/admin-actions";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function AdminCreatorsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const operator = await requireGrantedOperator();
  const query = await searchParams;
  const db = operator.adminDb;
  if (!db) {
    return <p className="muted">Creator moderation needs the platform admin database role.</p>;
  }
  const creators = await listCreators(db);
  const profiles = await Promise.all(creators.map((row) => getCreatorAuthorityProfile(db, row.id)));

  return (
    <>
      <h1>Creator trust</h1>
      <p className="muted">
        Exclusion sets trust to excluded and keeps call history. This is not a delete.
      </p>
      {query.error ? <p className="form-error">Trust update was rejected.</p> : null}
      {profiles.map((profile) => (
        <section key={profile.creator?.id}>
          <h2>{profile.creator?.displayName ?? profile.creator?.id}</h2>
          <p>
            trust {profile.trustState} · calls {profile.totalCalls} · historical{" "}
            {profile.historicalCalls.length}
          </p>
          <form className="inline-form" action={setCreatorTrustAction}>
            <input type="hidden" name="creatorId" value={profile.creator?.id ?? ""} />
            <label>
              State
              <select name="trustState" defaultValue="excluded">
                {OPERATOR_TRUST_STATES.map((state) => (
                  <option key={state} value={state}>
                    {state}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Reason
              <input name="reason" required />
            </label>
            <button type="submit">Record trust</button>
          </form>
          <p>
            <Link href={`/app/creators/${profile.creator?.id}`}>Customer profile</Link>
          </p>
        </section>
      ))}
    </>
  );
}
