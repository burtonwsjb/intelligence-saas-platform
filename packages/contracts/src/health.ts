export type HealthStatus = "ok";

export interface HealthResponse {
  status: HealthStatus;
}

export function healthOk(): HealthResponse {
  return { status: "ok" };
}
