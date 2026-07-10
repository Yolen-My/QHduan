import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/lib/server/redis";

export const dynamic = "force-dynamic";

const PB_URL = process.env.POCKETBASE_SERVER_URL || "http://127.0.0.1:8090";
const TTL_SECONDS = 60;
const VALID_KEYS = new Set(["bingo", "quiz", "story", "elimination", "all"]);

export async function GET(request: NextRequest, { params }: { params: Promise<{ gameKey: string }> }) {
  const { gameKey } = await params;
  const lang = request.nextUrl.searchParams.get("lang") === "en" ? "en" : "zh";
  if (!VALID_KEYS.has(gameKey)) {
    return NextResponse.json({ questions: [] }, { status: 400 });
  }

  const cacheKey = `q:${gameKey}:${lang}`;
  try {
    const cached = await getRedis().get(cacheKey);
    if (cached) {
      return new NextResponse(cached, { headers: { "content-type": "application/json" } });
    }
  } catch {}

  const filter = gameKey === "all"
    ? encodeURIComponent("isActive = true")
    : encodeURIComponent(`gameKey = '${gameKey}' && isActive = true`);
  const url = `${PB_URL}/api/collections/questions/records?perPage=500&sort=order&filter=${filter}`;
  const res = await fetch(url, { headers: { ua: lang }, cache: "no-store" });
  if (!res.ok) return NextResponse.json({ questions: [] }, { status: 502 });
  const data = await res.json();
  const body = JSON.stringify({ questions: data.items || [] });

  try {
    await getRedis().set(cacheKey, body, "EX", TTL_SECONDS);
  } catch {}

  return new NextResponse(body, { headers: { "content-type": "application/json" } });
}
