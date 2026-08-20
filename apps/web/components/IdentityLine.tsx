import type { PrintingIdentity } from "@isp/db";
import { formatPrintingIdentity } from "@isp/db";

export function IdentityLine({ identity }: { identity: PrintingIdentity }) {
  return <span className="identity-line">{formatPrintingIdentity(identity)}</span>;
}
