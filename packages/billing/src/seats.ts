export function occupiedTeamSeats(members: number, pendingInvites: number): number {
  return Math.max(0, members) + Math.max(0, pendingInvites);
}
