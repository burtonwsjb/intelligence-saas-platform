import { setCreatorPreferenceAction } from "@/app/creator-list-actions";

/** Follow / hide controls for one creator in this workspace. */
export function PreferenceButtons({
  creatorId,
  current,
  returnTo,
}: {
  creatorId: string;
  current: string | undefined;
  returnTo: string;
}) {
  return (
    <div className="badge-row" style={{ alignItems: "center" }}>
      {current !== "follow" ? (
        <form action={setCreatorPreferenceAction}>
          <input type="hidden" name="creatorId" value={creatorId} />
          <input type="hidden" name="preference" value="follow" />
          <input type="hidden" name="returnTo" value={returnTo} />
          <button className="link-button text-link" type="submit">
            Follow
          </button>
        </form>
      ) : null}
      {current !== "hide" ? (
        <form action={setCreatorPreferenceAction}>
          <input type="hidden" name="creatorId" value={creatorId} />
          <input type="hidden" name="preference" value="hide" />
          <input type="hidden" name="returnTo" value={returnTo} />
          <button className="link-button text-link" type="submit">
            Hide from my views
          </button>
        </form>
      ) : null}
    </div>
  );
}
