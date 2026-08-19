const REQUEST_ID_PATTERN = /^[A-Za-z0-9_:-]{8,128}$/;

export function resolveRequestId(header: string | undefined): string {
  const candidate = header?.trim();
  if (candidate && REQUEST_ID_PATTERN.test(candidate)) {
    return candidate;
  }
  return crypto.randomUUID();
}
