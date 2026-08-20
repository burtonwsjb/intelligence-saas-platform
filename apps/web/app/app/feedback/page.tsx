import { submitBugReportAction, submitFeedbackAction } from "@/app/beta-actions";
import { loadAppAccess } from "@/lib/app-access";

export const dynamic = "force-dynamic";

export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  await loadAppAccess();
  const query = await searchParams;
  return (
    <>
      <h1>Feedback</h1>
      <p className="muted">
        First-party reports stay inside your tenant. They are not published. Do not include API keys
        or passwords.
      </p>
      {query.ok ? <p>Received. Thank you.</p> : null}
      {query.error ? <p className="form-error">Could not save that report.</p> : null}
      <h2>Product feedback</h2>
      <form className="auth-form" action={submitFeedbackAction}>
        <label>
          Category
          <select name="category" defaultValue="product">
            <option value="product">product</option>
            <option value="intelligence">intelligence</option>
            <option value="billing">billing</option>
            <option value="api">api</option>
            <option value="other">other</option>
          </select>
        </label>
        <label>
          Page
          <input name="pageContext" placeholder="/app/opportunities" />
        </label>
        <label>
          Severity
          <select name="severity" defaultValue="normal">
            <option value="low">low</option>
            <option value="normal">normal</option>
            <option value="high">high</option>
            <option value="blocker">blocker</option>
          </select>
        </label>
        <label>
          Message
          <input name="message" required minLength={8} />
        </label>
        <button type="submit">Send feedback</button>
      </form>
      <h2>Bug report</h2>
      <form className="auth-form" action={submitBugReportAction}>
        <label>
          Request ID
          <input name="requestId" />
        </label>
        <label>
          Route
          <input name="route" />
        </label>
        <label>
          Description
          <input name="description" required minLength={8} />
        </label>
        <label>
          Reproduction
          <input name="reproduction" />
        </label>
        <button type="submit">Report bug</button>
      </form>
    </>
  );
}
