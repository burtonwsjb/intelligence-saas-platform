export const dynamic = "force-dynamic";

export default function WorkspaceUnavailablePage() {
  return (
    <>
      <h1>Workspace unavailable</h1>
      <p className="muted">
        This workspace is suspended or no longer available. Contact the owner if
        you need access.
      </p>
    </>
  );
}
