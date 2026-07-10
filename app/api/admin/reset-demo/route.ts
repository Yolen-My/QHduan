import { NextResponse } from "next/server";
import { verifyAdminCookie } from "@/lib/server/admin-auth";

const PB_URL = process.env.POCKETBASE_SERVER_URL || "http://127.0.0.1:8090";

export async function POST(request: Request) {
  if (!verifyAdminCookie(request)) {
    return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });
  }
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) {
    return NextResponse.json({ ok: false, error: "ADMIN_API_TOKEN 未配置" }, { status: 500 });
  }
  try {
    const res = await fetch(`${PB_URL}/api/reset-demo`, {
      method: "POST",
      headers: { "X-Admin-Token": token },
      cache: "no-store"
    });
    const body = await res.json().catch(() => ({ ok: false, error: "invalid response" }));
    return NextResponse.json(body, { status: res.status });
  } catch {
    return NextResponse.json({ ok: false, error: "PocketBase 不可达" }, { status: 502 });
  }
}
