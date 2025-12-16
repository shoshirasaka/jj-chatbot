import OpenAI from "openai";

export const runtime = "nodejs";

const ALLOWED_ORIGINS = new Set(["https://shop.jellyjellycafe.com"]);


const SHOP_API_BASE = "https://shop.jellyjellycafe.com/chatbot-api/products";
const SHOP_TOKEN = process.env.SHOP_TOKEN || ""; // test123 をVercel envへ
const JJ_CHATBOT_API_KEY = process.env.JJ_CHATBOT_API_KEY || "";
const SHOP_TOP_SELLING_BASE = "https://shop.jellyjellycafe.com/chatbot-api/top-selling";

function getClientApiKey(req: Request) {
  const x = req.headers.get("x-api-key");
  if (x) return x.trim();

  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();

  return "";
}

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

// ▼▼▼ ここに追加 ▼▼▼

// 人数カテゴリ（◯人）
const COUNT_CATEGORY_MAP: Record<number, number> = {
  1: 64,
  2: 63,
  3: 62,
  4: 61,
  5: 60,
  6: 59,
  7: 58,
  8: 57,
  9: 56,
  10: 55,
};

const COUNT_TRIGGER_RE = /([1-9]|10)\s*人/;

// ▲▲▲ ここまで追加 ▲▲▲


function detectKeywordCategoryId(text: string): number | null {
  const hit = KEYWORD_RULES
    .filter((r) => r.keywords.some((kw) => text.includes(kw)))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];

  return hit?.categoryId ?? null;
}


type KeywordRule = {
  categoryId: number;
  keywords: string[];
  priority: number; // 大きいほど優先
};

const KEYWORD_RULES: KeywordRule[] = [
  {categoryId: 69, keywords: ["パーティー", "ワイワイ", "わいわい"], priority: 50 },
  {categoryId: 70, keywords: ["推理"], priority: 20 },
  {categoryId: 71, keywords: ["2人専用"], priority: 80 },
  {categoryId: 72, keywords: ["頭脳戦"], priority: 90 },
  {categoryId: 73, keywords: ["手札管理"], priority: 150 },
  {categoryId: 74, keywords: ["人狼"], priority: 20 },
  {categoryId: 75, keywords: ["国産"], priority: 40 },
  {categoryId: 76, keywords: ["カワイイ", "かわいい", "可愛い"], priority: 22 },
  {categoryId: 77, keywords: ["ゲーム賞"], priority: 80 },
  {categoryId: 78, keywords: ["はじめて", "初めて", "最初の"], priority: 13 },
  {categoryId: 79, keywords: ["ダイス", "サイコロ","さいころ"], priority: 21 },
  {categoryId: 80, keywords: ["キッズ"], priority: 44 },
  {categoryId: 81, keywords: ["正体隠匿", "招待隠匿"], priority: 122 },
  {categoryId: 82, keywords: ["スピード"], priority: 31 },
  {categoryId: 83, keywords: ["協力"], priority: 41 },
  {categoryId: 84, keywords: ["記憶"], priority: 55 },
  {categoryId: 85, keywords: ["オークション","競り"], priority: 77 },
  {categoryId: 86, keywords: ["動物"], priority: 30 },
  {categoryId: 87, keywords: ["タイル"], priority: 20 },
  {categoryId: 88, keywords: ["アブストラクト"], priority: 90 },
  {categoryId: 89, keywords: ["想像力"], priority: 49 },
  {categoryId: 90, keywords: ["ブラフ"], priority: 76 },
  {categoryId: 91, keywords: ["ペア","チーム"], priority: 29 },
  {categoryId: 92, keywords: ["スペース広め"], priority: 90 },
  {categoryId: 93, keywords: ["チキンレース"], priority: 98 },
  {categoryId: 94, keywords: ["テクニック"], priority: 39 },
  {categoryId: 95, keywords: ["バランス"], priority: 25 },
  {categoryId: 96, keywords: ["運"], priority: 24 },
  {categoryId: 97, keywords: ["バッティング"], priority: 112 },
  {categoryId: 98, keywords: ["エリアマジョリティ"], priority:115 },
  {categoryId: 99, keywords: ["大喜利"], priority: 101 },
  {categoryId: 100, keywords: ["交渉"], priority: 77 },
  {categoryId: 101, keywords: ["パズル"], priority: 55 },
  {categoryId: 102, keywords: ["バースト"], priority: 52 },
  {categoryId: 105, keywords: ["拡大再生産"], priority: 153 },
  {categoryId: 106, keywords: ["デッキ構築"], priority: 144 },
  {categoryId: 107, keywords: ["お絵描き"], priority: 77 },
  {categoryId: 108, keywords: ["ワーカープレイスメント"], priority: 132 },
  {categoryId: 110, keywords: ["すごろく"], priority: 66 },
  {categoryId: 112, keywords: ["トリックテイキング","トリテ"], priority: 99 },
  {categoryId: 114, keywords: ["可変ボード"], priority: 200 },
  {categoryId: 116, keywords: ["レース"], priority: 49 },
  {categoryId: 117, keywords: ["アクション"], priority: 20 },
  {categoryId: 119, keywords: ["ドラフト"], priority: 14 },
  {categoryId: 120, keywords: ["クイズ"], priority: 66 },
  {categoryId: 135, keywords: ["定番"], priority: 33 },
  {categoryId: 136, keywords: ["シンプル"], priority: 22 },
  {categoryId: 137, keywords: ["小箱"], priority: 43 },
  {categoryId: 139, keywords: ["セットコレクション"], priority: 178 },
  {categoryId: 140, keywords: ["ファンタジー"], priority: 21 },
  {categoryId: 146, keywords: ["音を使う"], priority: 210 },
  {categoryId: 149, keywords: ["カードドラフト"], priority: 66 },
  {categoryId: 150, keywords: ["紙ペンゲーム"], priority: 89 },
  {categoryId: 151, keywords: ["TRPG"], priority: 140 },
  {categoryId: 152, keywords: ["将棋"], priority: 80 },
  {categoryId: 155, keywords: ["謎解き本"], priority: 192 },
  {categoryId: 156, keywords: ["カード配置"], priority: 55 },
  {categoryId: 157, keywords: ["エリア移動"], priority: 89 },
  {categoryId: 158, keywords: ["マーダーミステリー","マダミス"], priority: 266 },
  {categoryId: 160, keywords: ["コミュニケーション"], priority: 85 },
  {categoryId: 178, keywords: ["ピザラジオ","ピザラジ"], priority: 229 },
  {categoryId: 179, keywords: ["1人でも遊べる"], priority: 234 },
  {categoryId: 180, keywords: ["謎解き"], priority: 190 },
  {categoryId: 181, keywords: ["JELLY JELLY GAMES"], priority: 261 },
  {categoryId: 182, keywords: ["心理戦","駆け引き"], priority: 111 },
  {categoryId: 184, keywords: ["アップグレードキット"], priority: 220 },
  {categoryId: 188, keywords: ["ゲームマーケット"], priority: 42 },
  {categoryId: 191, keywords: ["拡張セット"], priority: 350 },
  {categoryId: 196, keywords: ["エンジンビルド"], priority: 150 },
  {categoryId: 199, keywords: ["allplay"], priority: 210 },
  {categoryId: 65, keywords: ["簡単","初心者","カンタン","かんたん"], priority: 10 },
  {categoryId: 67, keywords: ["上級者"], priority: 10 },
  {categoryId: 45, keywords: ["重量級","重ゲー","重めな"], priority: 210 },
  {categoryId: 10, keywords: ["軽めの","軽量級","ライトな","サクッと","さくっと"], priority: 4 },
  {categoryId: 199, keywords: ["allplay"], priority: 210 },
  {categoryId: 201, keywords: ["ゴーアウト"], priority: 170 }
];





// 「4人」「10人」などから “人数カテゴリID” を決める
function detectCountCategoryId(text: string): number | null {
  const m = text.match(/([1-9]|10)\s*人/); //  1〜10だけ拾う（14人を拾わない）
  if (!m) return null;

  const n = Number(m[1]);
  return COUNT_CATEGORY_MAP[n] ?? null;
}


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
    "Access-Control-Allow-Headers": "Content-Type, x-api-key, Authorization, x-debug",
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



async function shopListByCategory(categoryId: number, limit = 200, offset = 0) {
  const url =
    `${SHOP_API_BASE}?category_id=${encodeURIComponent(String(categoryId))}` +
    `&limit=${encodeURIComponent(String(limit))}` +
    `&offset=${encodeURIComponent(String(offset))}` +
    `&token=${encodeURIComponent(SHOP_TOKEN)}`;

  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) return { ok: false, status: r.status, items: [] as any[], url };

  const data = await r.json();
  const items = Array.isArray(data?.items) ? data.items : [];
  return { ok: true, status: r.status, items, url };
}




async function shopTopSelling(params: { categoryId?: number; limit?: number; days?: number }) {
  const limit = params.limit ?? 10;
  const days = params.days ?? 90;

  const qs = new URLSearchParams();
  qs.set("limit", String(limit));
  qs.set("days", String(days));
  if (params.categoryId) qs.set("category_id", String(params.categoryId));
  qs.set("token", SHOP_TOKEN);

  const url = `${SHOP_TOP_SELLING_BASE}?${qs.toString()}`;
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) return { ok: false, status: r.status, items: [] as any[], url };

  const data = await r.json();
  const items = Array.isArray(data?.items) ? data.items : [];
  return { ok: true, status: r.status, items, url };
}




// 在庫あり・表示ありだけからランダムに最大take件
function pickRandomInStock(items: any[], take = 3) {
  const pool = items.filter((x: any) => x?.is_visible && x?.in_stock);

  // シャッフル（Fisher–Yates）
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i],pool[j]] = [pool[j],pool[i]];
  }
  return pool.slice(0, take);
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
  
    // ===== API KEY 認証 =====
  const clientKey = getClientApiKey(req);
  
    // 🔽🔽🔽 ここに入れる 🔽🔽🔽
  console.log("JJ_CHATBOT_API_KEY:", JJ_CHATBOT_API_KEY);
  console.log("clientKey:", clientKey);
  // 🔼🔼🔼 ここまで 🔼🔼🔼

  if (!JJ_CHATBOT_API_KEY || clientKey !== JJ_CHATBOT_API_KEY) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers,
    });
  }
  

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
    
    // ===== 直近ユーザー発話 =====
const lastUserText =
  messages.filter((m) => m.role === "user").slice(-1)[0]?.content ?? "";

// ===== 年齢 / 人数 / キーワード検出（OpenAIより先にやる）=====
const ageCategoryId = AGE_TRIGGER_RE.test(lastUserText)
  ? detectAgeCategoryId(lastUserText)
  : null;

const countCategoryId = COUNT_TRIGGER_RE.test(lastUserText)
  ? detectCountCategoryId(lastUserText)
  : null;

const keywordCategoryId = detectKeywordCategoryId(lastUserText);




// debugに記録
debug_b.age_filter = ageCategoryId
  ? { triggered: true, ageCategoryId }
  : { triggered: false, ageCategoryId: null };

debug_b.count_filter = countCategoryId
  ? { triggered: true, countCategoryId }
  : { triggered: false, countCategoryId: null };

debug_b.keyword_filter = keywordCategoryId
  ? { triggered: true, keywordCategoryId }
  : { triggered: false, keywordCategoryId: null };
  
  
  
  
  // ===== 人数が出たら「売れ筋10件→ランダム3件」を最優先 =====
if (countCategoryId && SHOP_TOKEN) {
  const rT = await shopTopSelling({ categoryId: countCategoryId, limit: 10, days: 90 });

  debug_b.top_selling = {
    ok: rT.ok,
    status: rT.status,
    url: rT.url,
    total: rT.items.length,
  };

  if (rT.ok && rT.items.length) {
    let pool = rT.items;

    // 任意：キーワード・年齢もANDで絞る（不要ならこの2行は消してOK）
    if (keywordCategoryId) pool = pool.filter((it: any) => hasCategory(it, keywordCategoryId));
    if (ageCategoryId) pool = pool.filter((it: any) => hasCategory(it, ageCategoryId));

    debug_b.top_selling.after_filter = pool.length;

    const picked3 = pickRandomInStock(pool, 3);
    if (picked3.length) {
      const show = picked3.map((x: any) => x?.name).filter(Boolean).join("」「");
      const finalReply = `おすすめは「${show}」あたり！気になるのはどれ？`;

      return new Response(
        JSON.stringify({
          reply: finalReply,
          recommended_items: picked3,
          api_version: "2025-12-16-top-selling-enabled",
          debug_b,
        }),
        { status: 200, headers }
      );
    }
  }
  // ここに来たら「売れ筋から拾えなかった」→ 下の既存ロジックへ落とす
}
  

// ===== キーワードカテゴリがヒットしたら「カテゴリ内ランダム」を優先（ここで早期return）=====
if (keywordCategoryId && SHOP_TOKEN) {
  const rK = await shopListByCategory(keywordCategoryId, 200, 0);

  debug_b.keyword_filter.list = {
    ok: rK.ok,
    status: rK.status,
    url: rK.url,
    total: rK.items.length,
  };

  if (rK.ok && rK.items.length) {
    let pool = rK.items;

    // 年齢・人数があればANDで絞る（61を含んでればOK方式なので hasCategory でOK）
    if (ageCategoryId) pool = pool.filter((it: any) => hasCategory(it, ageCategoryId));
    if (countCategoryId) pool = pool.filter((it: any) => hasCategory(it, countCategoryId));

    debug_b.keyword_filter.after_and_filter = pool.length;

    const picked3 = pickRandomInStock(pool, 3);

    if (picked3.length) {
      const show = picked3.map((x: any) => x?.name).filter(Boolean).join("」「");
      const finalReply = `おすすめは「${show}」あたり！気になるのはどれ？`;

      return new Response(
        JSON.stringify({
          reply: finalReply,
          recommended_items: picked3,
          api_version: "2025-12-16-top-selling-enabled",
          debug_b,
        }),
        { status: 200, headers }
      );
    }
  }

  // ここに来た = キーワードはヒットしたが在庫ありで拾えなかった
  // → 既存ロジック（OpenAI→検索→fallback）に落とす
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

}
}

// ===== OpenAIで拾った候補も、年齢/人数があればANDで絞る（再検出はしない）=====
if (ageCategoryId) {
  recommended_items = recommended_items.filter((it) => hasCategory(it, ageCategoryId));
}
if (countCategoryId) {
  recommended_items = recommended_items.filter((it) => hasCategory(it, countCategoryId));
}

// ===== A: 取扱いがある商品だけを返答に反映する =====
const pickedNames = recommended_items
  .filter((x: any) => x?.is_visible && x?.in_stock)
  .map((x: any) => x?.name)
  .filter(Boolean) as string[];

let finalReply = reply;

if (pickedNames.length === 0) {
  const ageCat: number | null =
    debug_b?.age_filter?.triggered && typeof debug_b?.age_filter?.ageCategoryId === "number"
      ? debug_b.age_filter.ageCategoryId
      : null;

  const countCat: number | null =
    debug_b?.count_filter?.triggered && typeof debug_b?.count_filter?.countCategoryId === "number"
      ? debug_b.count_filter.countCategoryId
      : null;

  // どっちも指定なし → 従来メッセージ
  if (!ageCat && !countCat) {
    finalReply =
      "ごめんなさい、その条件だと在庫のある商品が見つからなかった！人数・時間・好きな系統（協力/対戦/ワイワイ）を教えてもらえる？";
  } else {
    // まず「年齢カテゴリ」を優先で一覧取得（なければ人数カテゴリ）
    const primaryCat = ageCat ?? countCat!;
    const secondaryCat = ageCat && countCat ? countCat : null; // 両方あるときだけ使う

    const r2 = await shopListByCategory(primaryCat, 200, 0);

    debug_b.fallback = {
      primaryCat,
      secondaryCat,
      ok: r2.ok,
      status: r2.status,
      url: r2.url,
      total: r2.items.length,
    };

    if (r2.ok && r2.items.length) {
      // 両方指定されてたら、もう片方カテゴリも満たすものだけ残す（AND）
      let pool = r2.items;
      if (secondaryCat) {
        pool = pool.filter((it: any) => hasCategory(it, secondaryCat));
        debug_b.fallback.after_secondary_filter = pool.length;
      }

      const picked3 = pickRandomInStock(pool, 3);

      if (picked3.length) {
        recommended_items = picked3;
        const show = picked3.map((x: any) => x?.name).filter(Boolean).join("」「");
        finalReply = `おすすめは「${show}」あたり！気になるのはどれ？`;
      } else {
        finalReply =
          "ごめんなさい、その条件（年齢/人数）で在庫のある商品が見つからなかった…！人数か年齢を少し広げてみて〜";
      }
    } else {
      finalReply =
        "ごめんなさい、カテゴリの商品一覧が取得できなかった…！少し時間をおいてもう一度試してみて〜";
    }
  }
}

// ★返すのは finalReply
return new Response(
  JSON.stringify({
    reply: finalReply,
    recommended_items,
    api_version: "2025-12-16-top-selling-enabled",
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