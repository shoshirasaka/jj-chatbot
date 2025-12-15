import OpenAI from "openai";

export const runtime = "nodejs";

const ALLOWED_ORIGINS = new Set(["https://shop.jellyjellycafe.com"]);

const SHOP_API_BASE = "https://shop.jellyjellycafe.com/chatbot-api/products";
const SHOP_TOKEN = process.env.SHOP_TOKEN || ""; // test123 をVercel envへ

function cors(origin: string | null) {
  const allowOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

type Msg = { role: "user" | "assistant" | "system"; content: string };

export async function OPTIONS(req: Request) {
  const origin = req.headers.get("origin");
  return new Response(null, { status: 204, headers: cors(origin) });
}

function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function shopSearchByQ(q: string) {
  const url =
    `${SHOP_API_BASE}?q=${encodeURIComponent(q)}&limit=10&offset=0&token=` +
    encodeURIComponent(SHOP_TOKEN);

  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) return { ok: false, status: r.status, items: [] as any[], url };

  const data = await r.json();
  const items = Array.isArray(data?.items) ? data.items : [];
  return { ok: true, status: r.status, items, url };
}

export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  const headers = { "Content-Type": "application/json", ...cors(origin) };

  let debug_b: any = {
    step: "init",
    token_set: !!SHOP_TOKEN,
    extracted_titles: [],
    searches: [] as any[],
    error: null,
  };

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "OPENAI_API_KEY is missing" }), {
        status: 500,
        headers,
      });
    }

    const body = await req.json();
    const messages = (body?.messages ?? []) as Msg[];
    if (!Array.isArray(messages) || messages.length === 0) {
      return new Response(JSON.stringify({ error: "messages is required" }), {
        status: 400,
        headers,
      });
    }

    const client = new OpenAI({ apiKey });

    // ✅ ここがBの肝：文章＋タイトル配列をJSONで返させる
    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.7,
      messages: [
        {
          role: "system",
          content: [
            "あなたはボードゲームカフェの店員です。日本語でカジュアルに返答してください。",
            "必ず次のJSONだけを返してください（コードブロック禁止）。",
            `{"reply":"...","titles":["ゲーム名1","ゲーム名2","ゲーム名3"]}`,
            "titlesは商品検索に使うので、できるだけ正確な正式名称にしてください。",
          ].join("\n"),
        },
        ...messages,
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? "";
    const parsed = safeJsonParse<{ reply: string; titles: string[] }>(raw);

    // JSONが壊れて返ってきた時の保険（最低限動かす）
    const reply = parsed?.reply ?? raw;
    const titles = Array.isArray(parsed?.titles) ? parsed!.titles : [];

    debug_b.extracted_titles = titles;

    // ✅ EC-CUBE検索して、AIが言ったタイトルと一致する商品を拾う
    let recommended_items: any[] = [];

    if (SHOP_TOKEN && titles.length) {
      for (const t of titles.slice(0, 3)) {
        const r = await shopSearchByQ(t);

        debug_b.searches.push({
          q: t,
          ok: r.ok,
          status: r.status,
          url: r.url,
          count: r.items.length,
          sample_name: r.items[0]?.name ?? null,
        });

        if (!r.ok) continue;

        // 「公開&在庫」だけに絞る（あなたのAPIの定義に合わせる）
        const hit = r.items.find((x: any) => x?.is_visible && x?.in_stock);

        // 見つからなければとりあえず先頭（公開/在庫条件がAPI側で落ちてるケース対策）
        const fallback = r.items[0];

        if (hit) recommended_items.push(hit);
        else if (fallback) recommended_items.push(fallback);
      }
    }

    return new Response(
      JSON.stringify({
        reply,
        recommended_items,
        api_version: "2025-12-15-B",
        debug_b, // いまは残してOK。安定したら消す。
      }),
      { status: 200, headers }
    );
  } catch (e: any) {
    debug_b = { ...debug_b, step: "catch", error: e?.message ?? String(e) };
    return new Response(
      JSON.stringify({ error: e?.message ?? "unknown error", debug_b }),
      { status: 500, headers }
    );
  }
}