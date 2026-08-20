import { updateOrgProfileAction, updatePreferenceAction, updateUserProfileAction } from "@/app/settings-actions";
import { loadAppAccess } from "@/lib/app-access";
import { getDb } from "@/lib/auth";
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  REQUIRED_NOTIFICATION_CATEGORIES,
  getCrmOrganizationProfile,
  getCrmUserProfile,
  listNotificationPreferences,
  withOrganizationContext,
} from "@isp/db";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { organizationId, userId, access } = await loadAppAccess();
  const query = await searchParams;
  const snapshot = await withOrganizationContext(getDb(), { organizationId, userId }, async (scoped) => {
    const [org, profile, prefs] = await Promise.all([
      getCrmOrganizationProfile(scoped, organizationId),
      getCrmUserProfile(scoped, { organizationId, userId }),
      listNotificationPreferences(scoped, { organizationId, userId }),
    ]);
    return { org, profile, prefs };
  });

  return (
    <>
      <h1>Settings</h1>
      {query.error ? <p className="form-error">Settings change was rejected.</p> : null}
      <h2>Organization</h2>
      <p className="muted">Lifecycle {snapshot.org?.lifecycleStage ?? "unknown"} · status {snapshot.org?.customerStatus ?? "unknown"}</p>
      {access.canManageMembers ? (
        <form className="auth-form" action={updateOrgProfileAction}>
          <label>
            Display name
            <input name="displayName" defaultValue={snapshot.org?.displayName ?? ""} required />
          </label>
          <label>
            Website
            <input name="website" defaultValue={snapshot.org?.website ?? ""} />
          </label>
          <label>
            Industry
            <input name="industry" defaultValue={snapshot.org?.industry ?? ""} />
          </label>
          <label>
            Primary use case
            <input name="primaryUseCase" defaultValue={snapshot.org?.primaryUseCase ?? ""} />
          </label>
          <button type="submit">Save organization</button>
        </form>
      ) : (
        <p>{snapshot.org?.displayName}</p>
      )}
      <h2>Your profile</h2>
      <form className="auth-form" action={updateUserProfileAction}>
        <label>
          Display name
          <input name="displayName" defaultValue={snapshot.profile?.displayName ?? ""} />
        </label>
        <label>
          Job title
          <input name="jobTitle" defaultValue={snapshot.profile?.jobTitle ?? ""} />
        </label>
        <label>
          Timezone
          <input name="timezone" defaultValue={snapshot.profile?.timezone ?? ""} />
        </label>
        <button type="submit">Save profile</button>
      </form>
      <h2>Notification preferences</h2>
      <p className="muted">Account and security email/in-app cannot be disabled. Marketing is opt-in.</p>
      <table className="data-table">
        <thead>
          <tr>
            <th>Category</th>
            <th>Channel</th>
            <th>Opted in</th>
          </tr>
        </thead>
        <tbody>
          {NOTIFICATION_CATEGORIES.flatMap((category) =>
            NOTIFICATION_CHANNELS.map((channel) => {
              const row = snapshot.prefs.find((pref) => pref.category === category && pref.channel === channel);
              const required = (REQUIRED_NOTIFICATION_CATEGORIES as readonly string[]).includes(category) && channel !== "webhook";
              return (
                <tr key={`${category}-${channel}`}>
                  <td>{category}</td>
                  <td>{channel}</td>
                  <td>
                    <form action={updatePreferenceAction}>
                      <input type="hidden" name="category" value={category} />
                      <input type="hidden" name="channel" value={channel} />
                      <input type="checkbox" name="optedIn" defaultChecked={row?.optedIn ?? false} disabled={required} />
                      {required ? null : <button className="link-button" type="submit">Save</button>}
                    </form>
                  </td>
                </tr>
              );
            }),
          )}
        </tbody>
      </table>
    </>
  );
}
