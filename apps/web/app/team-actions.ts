"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/lib/auth";
import { requireAppActor } from "@/lib/app-access";
import {
  INVITABLE_ROLES,
  assertNotLastOwner,
  invitation,
  isInvitableRole,
  member,
} from "@isp/db";
import { eq } from "drizzle-orm";

async function requireTeamManager() {
  return requireAppActor("canManageMembers");
}

export async function inviteMemberAction(formData: FormData) {
  const { session, organizationId } = await requireTeamManager();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "viewer");
  if (!email.includes("@") || !isInvitableRole(role)) {
    redirect("/app/team?error=invalid");
  }
  await getDb().insert(invitation).values({
    id: crypto.randomUUID(),
    organizationId,
    email,
    role,
    status: "pending",
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    inviterId: session.user.id,
  });
  redirect("/app/team");
}

export async function changeRoleAction(formData: FormData) {
  await requireTeamManager();
  const memberId = String(formData.get("memberId") ?? "");
  const role = String(formData.get("role") ?? "");
  if (![...INVITABLE_ROLES, "owner"].includes(role)) {
    redirect("/app/team?error=invalid");
  }
  const db = getDb();
  const [existing] = await db.select().from(member).where(eq(member.id, memberId)).limit(1);
  if (!existing) {
    redirect("/app/team?error=missing");
  }
  const owners = await db.select().from(member).where(eq(member.organizationId, existing.organizationId));
  const ownerCount = owners.filter((row) => row.role === "owner").length;
  try {
    if (existing.role === "owner" && role !== "owner") {
      assertNotLastOwner({ targetRole: "owner", ownerCount, removing: true });
    }
  } catch {
    redirect("/app/team?error=last-owner");
  }
  await db.update(member).set({ role }).where(eq(member.id, memberId));
  redirect("/app/team");
}

export async function removeMemberAction(formData: FormData) {
  await requireTeamManager();
  const memberId = String(formData.get("memberId") ?? "");
  const db = getDb();
  const [existing] = await db.select().from(member).where(eq(member.id, memberId)).limit(1);
  if (!existing) {
    redirect("/app/team");
  }
  const owners = await db.select().from(member).where(eq(member.organizationId, existing.organizationId));
  try {
    assertNotLastOwner({
      targetRole: existing.role,
      ownerCount: owners.filter((row) => row.role === "owner").length,
      removing: true,
    });
  } catch {
    redirect("/app/team?error=last-owner");
  }
  await db.delete(member).where(eq(member.id, memberId));
  redirect("/app/team");
}

export async function cancelInvitationAction(formData: FormData) {
  await requireTeamManager();
  const invitationId = String(formData.get("invitationId") ?? "");
  await getDb().delete(invitation).where(eq(invitation.id, invitationId));
  redirect("/app/team");
}
