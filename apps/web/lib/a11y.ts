export const SKIP_LINK_HREF = "#main";

export function preferenceControlLabel(category: string, channel: string): string {
  return `${category.replaceAll("_", " ")} ${channel.replaceAll("_", " ")} notifications`;
}
