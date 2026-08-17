import { shellLabel } from "@/lib/shell";

export default function HomePage() {
  return (
    <>
      <h1>Intelligence Platform</h1>
      <p>
        Standalone commercial decision intelligence SaaS. This is the Phase 01
        local application shell.
      </p>
      <p className="muted">{shellLabel()}</p>
      <p className="muted">
        Authentication, billing, TCG dashboards, and customer functionality are
        not implemented in this phase.
      </p>
    </>
  );
}
