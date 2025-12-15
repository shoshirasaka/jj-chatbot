import OpenAI from "openai";

export const runtime = "nodejs";

// ここに許可するOriginを列挙
const ALLOWED_ORIGINS = new Set([
  "https://shop.jellyjellycafe.com",
]);

const SHOP_API_BASE = "https://shop.jellyjellycafe.com/chatbot-api/products";
const SHOP_TOKEN = process.env.SHOP_TOKEN || "";

function cors(origin: string | null) {
  // Originが許可されていれば返す。違えば空にしてブラウザがブロックする
  const allowOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

type Msg = { role: "user" | "assistant" | "system"; content: string };

export async function OPTIONS(req: Request) {
  const origin = req.headers.get("origin");
  return new Response(null, { status: 204, headers: cors(origin) });
}

export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  const headers = { "Content-Type": "application/json", ...cors(origin) };

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "OPENAI_API_KEY is missing" }), {
        status: 500,
        headers,
      });
    }

    const client = new OpenAI({ apiKey });

    const body = await req.json();
    const messages = (body?.messages ?? []) as Msg[];

    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: "messages is required" }), {
        status: 400,
        headers,
      });
    }

const completion = await client.chat.completions.create({
  model: "gpt-4.1-mini",
  messages: [
    {
      role: "system",
      content:
        "あなたはボードゲームカフェの店員です。日本語でカジュアルに答えてください。送られてきたキーワードから、おすすめゲームを提案してください。",
    },
    ...messages,
  ],
  temperature: 0.7,
});

const reply = completion.choices[0]?.message?.content ?? "";

// --- ここから：おすすめ商品をEC-CUBEから取得して返す（A） ---
let recommended_items: any[] = [];

let debug_shop: any = {
  token_set: !!SHOP_TOKEN,
  url: null,
  status: null,
  ok: null,
  total_items: null,
  visible_count: null,
  instock_count: null,
  both_count: null,
  sample: null,
  error: null,
};

try {
  if (!SHOP_TOKEN) {
    // トークン未設定なら無理に落とさない
    recommended_items = [];
  } else {
    const url = `${SHOP_API_BASE}?limit=50&offset=0&token=${encodeURIComponent(
      SHOP_TOKEN
    )}`;
    debug_shop.url = url;

    const r = await fetch(url, { headers: { Accept: "application/json" } });

    debug_shop.status = r.status;
    debug_shop.ok = r.ok;

    if (r.ok) {
      const data = await r.json();
      const items = Array.isArray(data?.items) ? data.items : [];

      debug_shop.total_items = items.length;
      debug_shop.visible_count = items.filter((x: any) => x?.is_visible).length;
      debug_shop.instock_count = items.filter((x: any) => x?.in_stock).length;
      debug_shop.both_count = items.filter(
        (x: any) => x?.is_visible && x?.in_stock
      ).length;
      debug_shop.sample = items[0] ?? null;

      recommended_items = items
        .filter((x: any) => x && x.is_visible && x.in_stock)
        .slice(0, 10);
    } else {
      const t = await r.text().catch(() => "");
      debug_shop.error = t.slice(0, 300);
    }
  }
} catch (e: any) {
  debug_shop.error = e?.message ?? String(e);
  recommended_items = [];
}
// --- ここまで ---
// --- ここまで ---

return new Response(
  JSON.stringify({
    reply,
    recommended_items,
    api_version: "2025-12-15-a",
    debug_shop,
  }),
  { status: 200, headers }
);
    
    
} catch (e: any) {
  debug_shop = { ...debug_shop, step: "catch", error: e?.message ?? String(e) };
  recommended_items = [];
}
}