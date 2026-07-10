import { NextResponse } from "next/server";
import { redisGetJson } from "@/lib/server/redis";
import { verifyAdminCookie } from "@/lib/server/admin-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!verifyAdminCookie(request)) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  const stats = await redisGetJson<object>("snap:admin");
  if (!stats) return NextResponse.json({ ok: false }, { status: 503 });
  return NextResponse.json(stats);
}
