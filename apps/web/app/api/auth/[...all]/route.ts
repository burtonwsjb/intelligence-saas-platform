import { toNextJsHandler } from "better-auth/next-js";
import { getAuth, isAuthConfigError } from "@/lib/auth";

export const runtime = "nodejs";

function unavailable() {
  return Response.json(
    { error: "Authentication is not configured." },
    { status: 503 },
  );
}

export async function GET(request: Request) {
  try {
    return toNextJsHandler(getAuth()).GET(request);
  } catch (error) {
    if (isAuthConfigError(error)) {
      return unavailable();
    }
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    return toNextJsHandler(getAuth()).POST(request);
  } catch (error) {
    if (isAuthConfigError(error)) {
      return unavailable();
    }
    throw error;
  }
}
