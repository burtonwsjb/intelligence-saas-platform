const NAME_MIN = 2;
const NAME_MAX = 80;

export function parseOrganizationName(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const name = raw.trim();
  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    return null;
  }
  return name;
}

export function slugifyOrganizationName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return base.length > 0 ? base : "workspace";
}
