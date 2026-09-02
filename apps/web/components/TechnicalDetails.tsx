export function TechnicalDetails({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <details className="technical-details">
      <summary>{title}</summary>
      {children}
    </details>
  );
}

export function explanationText(item: unknown): string {
  if (typeof item === "string") {
    return item;
  }
  if (item && typeof item === "object" && "text" in item && typeof (item as { text: unknown }).text === "string") {
    return (item as { text: string }).text;
  }
  return "See technical details.";
}
