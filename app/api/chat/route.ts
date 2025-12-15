import OpenAI from "openai";

export const runtime = "nodejs";

const ALLOWED_ORIGINS = new Set(["https://shop.jellyjellycafe.com"]);

const SHOP_API_BASE = "https://shop.jellyjellycafe.com/chatbot-api/products";
const SHOP_TOKEN = process.env.SHOP_TOKEN || ""; // test123 をVercel envへ

// 年齢カテゴリ（◯歳以上）
const AGE_CATEGORY_MAP: Record<number, number> = {
  3: 163,
  4: 164,
  5: 165,
  6: 166,
  7: 167,
  8: 168,
  9: 169,
  10: 170,
  11: 171,
  12: 172,
  13: 173,
  14: 174,
  15: 175,
  16: 176,
};

const AGE_TRIGGER_RE = /(\d{1,2})\s*(歳|才)|子ども|子供|小学生/i;

// 「7才」などから “対象カテゴリID” を決める
function detectAgeCategoryId(text: string): number | null {
  const m = text.match(/(\d{1,2})\s*(歳|才)/);
  if (m) {
    const age = Math.max(0, Math.min(99, Number(m[1])));

    // 3未満は3へ、16超は16へ丸める
    const clamped = Math.max(3, Math.min(16, age));
    return AGE_CATEGORY_MAP[clamped] ?? null;
  }

  // 「子ども/小学生」だけで年齢が無い場合は、運用上のデフォルトを決める
  // ここは好みで変更OK（例：小学生=6歳以上）
  if (/(子ども|子供|小学生)/i.test(text)) {
    return 166; // 6歳以上
  }

  return null;
}

function hasCategory(item: any, categoryId: number): boolean {
  const ids = Array.isArray(item?.category_ids) ? item.category_ids : [];
  return ids.map((x: any) => Number(x)).includes(categoryId);
}


function cors(origin: string | null) {
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

function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/* ===== ここから追加 ===== */

function extractJsonObject(raw: string): any | null {
  // 1) まず全文をJSONとして試す
  const direct = safeJsonParse<any>(raw);
  if (direct) return direct;

  // 2) 文中に混ざったJSONを抜き出す
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  const candidate = raw.slice(start, end + 1).trim();
  return safeJsonParse<any>(candidate);
}

function stripTrailingJson(raw: string): string {
  // 末尾にJSONがくっついてたら落とす
  return raw.replace(/\{[\s\S]*\}\s*$/m, "").trim();
}

/* ===== 追加ここまで ===== */

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
 const candidates = items.filter((x: any) => x?.is_visible && x?.in_stock);
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
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "chatbot_reply",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["reply", "titles"],
        properties: {
          reply: { type: "string" },
          titles: {
            type: "array",
            items: { type: "string" },
            maxItems: 5
          }
        }
      }
    }
  },
  messages: [
    {
      role: "system",
      content: [
        "あなたはボードゲーム販売店の店員です。日本語でカジュアルに返答してください。",
        "replyにはユーザーへの自然な返答を書いてください。",
        "titlesには、reply内でおすすめしたゲーム名を配列で入れてください（最大5件）。",
        "出力は指定スキーマのJSONのみです。"
      ].join("\n"),
    },
    ...messages,
  ],
});

const raw = completion.choices[0]?.message?.content ?? "";
const parsed = extractJsonObject(raw) as { reply?: string; titles?: string[] } | null;

const reply =
  typeof parsed?.reply === "string" && parsed.reply.trim()
    ? parsed.reply
    : stripTrailingJson(raw);

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
      fallback = r.items.find((x: any) => x?.is_visible) ?? null;
    }
  }

  if (hit) recommended_items.push(hit);
  else if (fallback) recommended_items.push(fallback); // ← ここが次の「在庫なし代替」への入口
  
  // ===== 年齢ワードがあれば「◯歳以上カテゴリ」に属する商品だけに絞る =====
const lastUserText =
  messages.filter((m) => m.role === "user").slice(-1)[0]?.content ?? "";

const ageCategoryId = AGE_TRIGGER_RE.test(lastUserText)
  ? detectAgeCategoryId(lastUserText)
  : null;

if (ageCategoryId) {
  // ここで “その年齢カテゴリに属している商品だけ” 残す
  recommended_items = recommended_items.filter((it) => hasCategory(it, ageCategoryId));
  debug_b.age_filter = { triggered: true, ageCategoryId };
} else {
  debug_b.age_filter = { triggered: false, ageCategoryId: null };
}
  
  
}
}

// ===== A: 取扱いがある商品だけを返答に反映する =====
const pickedNames = recommended_items
  .filter((x: any) => x?.is_visible && x?.in_stock)
  .map((x: any) => x?.name)
  .filter(Boolean) as string[];

let finalReply = reply;

if (pickedNames.length === 0) {
  finalReply =
    "ごめんなさい、その条件だと在庫のある商品が見つからなかった！人数・時間・好きな系統（協力/対戦/ワイワイ）を教えてもらえる？";
} else {
  // ===== B: 採用できた商品だけで自然文を生成（2回目のOpenAI） =====
  try {
    const completion2 = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.6,
      messages: [
        {
          role: "system",
          content:
            "あなたはボードゲーム販売店の店員です。次の『取扱い商品』に含まれるゲーム名だけを使っておすすめ文を作り、取扱いにないゲーム名は絶対に出さないでください。",
        },
        {
          role: "user",
          content:
            `取扱い商品: ${pickedNames.join(" / ")}\n` +
            "この中から最大3つを挙げて、自然な日本語で1〜2文のおすすめ文にしてください。",
        },
      ],
    });

    const text2 = completion2.choices[0]?.message?.content ?? "";
    if (text2.trim()) finalReply = text2.trim();
  } catch {
    // 2回目が落ちてもAの安全文に戻す
    const show = pickedNames.slice(0, 3).join("」「");
    finalReply = `おすすめは「${show}」あたり！気になるのはどれ？`;
  }
}

// ★返すのは finalReply
return new Response(
  JSON.stringify({
    reply: finalReply,
    recommended_items,
    api_version: "2025-12-15-B",
    debug_b,
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