import { shellLabel } from "@/lib/shell";

export default function HomePage() {
  return (
    <>
      <h1>Intelligence Platform</h1>
      <p>
        Standalone commercial decision intelligence SaaS. Sign up to create a
        tenant workspace.
      </p>
      <p className="muted">{shellLabel()}</p>
    </>
  );
}
