function LegalPlaceholder({ title }: { title: string }) {
  return (
    <>
      <h1>{title}</h1>
      <p>
        This is a placeholder. Legal counsel must review and replace this text before production
        launch. It is not a contract and is not finalized policy.
      </p>
    </>
  );
}

export function TermsPlaceholder() {
  return <LegalPlaceholder title="Terms of Service" />;
}

export function PrivacyPlaceholder() {
  return <LegalPlaceholder title="Privacy Policy" />;
}

export function AcceptableUsePlaceholder() {
  return <LegalPlaceholder title="Acceptable Use" />;
}

export function ApiTermsPlaceholder() {
  return <LegalPlaceholder title="API Terms" />;
}
