import { NextResponse } from "next/server";
import { ADMIN_COOKIE_NAME, getAdminSessionValue } from "@/lib/server/admin-auth";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const username = typeof body?.username === "string" ? body.username.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const adminUsername = process.env.ADMIN_USERNAME || "admin";
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminPassword) {
      return NextResponse.json(
        { ok: false, message: "管理员密码未配置" },
        { status: 500 }
      );
    }

    if (username === adminUsername && password === adminPassword) {
      const res = NextResponse.json({ ok: true });
      res.cookies.set(ADMIN_COOKIE_NAME, getAdminSessionValue(), {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production"
      });
      return res;
    }

    return NextResponse.json(
      { ok: false, message: "用户名或密码错误" },
      { status: 401 }
    );
  } catch {
    return NextResponse.json(
      { ok: false, message: "请求格式错误" },
      { status: 400 }
    );
  }
}
