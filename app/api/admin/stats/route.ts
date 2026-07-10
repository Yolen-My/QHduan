import { NextResponse } from "next/server";
import { redisGetJson } from "@/lib/server/redis";

export const dynamic = "force-dynamic";

export async function GET() {
  const stats = await redisGetJson<object>("snap:admin");
  if (!stats) return NextResponse.json({ ok: false }, { status: 503 });
  return NextResponse.json(stats);
}
