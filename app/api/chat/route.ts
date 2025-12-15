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




function normalizeTitle(s: string) {
  return (s || "")
    .replace(/[『』「」"'“”]/g, "")
    .replace(/\s+/g, " ")
    // 版・数字・拡張系のノイズを落とす（必要に応じて追加）
    .replace(/(拡張|日本語版|新版|完全版|第\d+版|改訂版|再版)/g, "")
    .replace(/[0-9０-９]+/g, "")
    .trim();
}

function buildQueriesForTitle(title: string) {
  const t = title.trim();
  const n = normalizeTitle(t);

  const variants = new Set<string>([
    t,
    n,
    // 「：」「-」以降を落とす（副題除去）
    t.split(/[:：\-－]/)[0].trim(),
    n.split(/[:：\-－]/)[0].trim(),
  ]);

  return [...variants].filter(Boolean);
}

function scoreItem(q: string, itemName: string) {
  const qn = normalizeTitle(q);
  const iname = normalizeTitle(itemName);

  if (!qn || !iname) return 0;
  if (iname === qn) return 100;              // 正規化完全一致
  if (iname.includes(qn)) return 70;         // 片方向部分一致
  if (qn.includes(iname)) return 60;         // 逆方向部分一致
  return 0;
}

function pickBestInStock(q: string, items: any[]) {
  const candidates = items.filter(x => x?.is_visible && x?.in_stock);
  let best: any = null;
  let bestScore = 0;

  for (const it of candidates) {
    const s = scoreItem(q, it?.name || "");
    if (s > bestScore) { bestScore = s; best = it; }
  }
  return bestScore > 0 ? best : null;
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
            "あなたはボードゲーム販売店の店員です。日本語でカジュアルに返答してください。",
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
  const queries = buildQueriesForTitle(t); // ← これが「表記揺れ吸収」

  let hit: any | null = null;
  let fallback: any | null = null;

  for (const q of queries) {
    const r = await shopSearchByQ(q);

    debug_b.searches.push({
      title: t,
      q,
      ok: r.ok,
      status: r.status,
      url: r.url,
      count: r.items.length,
      sample_name: r.items[0]?.name ?? null,
    });

    if (!r.ok || !r.items.length) continue;

    // 1在庫あり最優先
    const bestInStock = pickBestInStock(q, r.items);
    if (bestInStock) { hit = bestInStock; break; }

    // 2在庫なしでも“近い”候補は fallback に保持（次ステップ「在庫なし代替」に使う）
    if (!fallback) {
      // visibleだけ拾っておく（in_stockは問わない）
      fallback = r.items.find(x => x?.is_visible) ?? null;
    }
  }

  if (hit) recommended_items.push(hit);
  else if (fallback) recommended_items.push(fallback); // ← ここが次の「在庫なし代替」への入口
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