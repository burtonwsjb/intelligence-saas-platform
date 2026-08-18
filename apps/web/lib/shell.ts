import { healthOk } from "@isp/contracts";

export function shellLabel(): string {
  return `Phase 02 foundation · health contract ${healthOk().status}`;
}
