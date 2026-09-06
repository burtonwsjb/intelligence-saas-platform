import { NextResponse } from "next/server";
import { getDb } from "@/lib/auth";
import { loadAppAccess } from "@/lib/app-access";
import { exportOrganizationData, withOrganizationContext } from "@isp/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const { organizationId, userId, access } = await loadAppAccess();
  if (!access.canManageMembers) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const pack = await withOrganizationContext(getDb(), { organizationId, userId }, (scoped) =>
    exportOrganizationData(scoped, organizationId),
  );
  return new NextResponse(JSON.stringify(pack), {
    headers: {
      "content-type": "application/json",
      "content-disposition": "attachment; filename=social-signal-iq-export.json",
    },
  });
}
