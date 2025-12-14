import { requireRedis } from "@/lib/redis";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const EC_API_URL = process.env.EC_API_URL!;
const CHATBOT_TOKEN = process.env.CHATBOT_TOKEN!;

const KEY = "ec_products_v1";
const TTL_SECONDS = 60 * 60;

async function fetchAllProducts() {
  const res = await fetch(`${EC_API_URL}?limit=5000`, {
    headers: {
      Authorization: `Bearer ${CHATBOT_TOKEN}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (!res.ok) throw new Error(`EC API error: ${res.status}`);
  const data = await res.json();
  return data.items ?? data;
}

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const incoming = auth.replace(/^Bearer\s+/i, "").trim();
  if (!incoming || incoming !== CHATBOT_TOKEN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const redis = requireRedis();

  const items = await fetchAllProducts();
  const payload = { updatedAt: Date.now(), items };

  await redis.set(KEY, payload, { ex: TTL_SECONDS }); // ★ expireを1行に

  return NextResponse.json({ ok: true, count: items?.length ?? 0 });
}