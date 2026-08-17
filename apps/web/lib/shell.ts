import { healthOk } from "@isp/contracts";

export function shellLabel(): string {
  return `Phase 01 shell · health contract ${healthOk().status}`;
}
