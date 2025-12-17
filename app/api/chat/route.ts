import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

/** ====== Config ====== */
const ALLOWED_ORIGINS = new Set(["https://shop.jellyjellycafe.com"]);

const SHOP_API_BASE = "https://shop.jellyjellycafe.com/chatbot-api/products";
const SHOP_TOP_SELLING_BASE = "https://shop.jellyjellycafe.com/chatbot-api/top-selling";

const SHOP_TOKEN = process.env.SHOP_TOKEN || "";
const JJ_CHATBOT_API_KEY = process.env.JJ_CHATBOT_API_KEY || "";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;


/** ====== Types ====== */
type Msg = { role: "user" | "assistant" | "system"; content: string };

type ShopItem = {
  product_id?: number;
  name?: string;
  url?: string;
  detail_url?: string;
  image_url?: string;
  is_visible?: boolean;
  in_stock?: boolean;
  category_ids?: Array<number | string>;
  [k: string]: any;
};

type DebugBag = {
  step: string;
  token_set: boolean;
  age_filter?: { triggered: boolean; ageCategoryId: number | null };
  count_filter?: { triggered: boolean; countCategoryId: number | null };
  keyword_filter?: {
    triggered: boolean;
    keywordCategoryId: number | null;
    list?: { ok: boolean; status: number; url: string; total: number; after_and_filter?: number };
  };
  top_selling?: { ok: boolean; status: number; url: string; total: number; after_filter?: number };
  extracted_titles?: string[];
  searches?: Array<{ title: string; q: string; ok: boolean; status: number; url: string; count: number }>;
  fallback?: {
    primaryCat: number;
    secondaryCat: number | null;
    ok: boolean;
    status: number;
    url: string;
    total: number;
    after_secondary_filter?: number;
  };
  error?: string | null;
};


async function logChat(params: {
  req: Request;
  user_text: string;
  reply_text: string;
  titles?: string[];
  recommended_items?: any[];
  debug_b?: any;
  api_version?: string;
}) {
  if (!supabase) return;

  const ua = params.req.headers.get("user-agent") || "";
  const ip =
    params.req.headers.get("x-forwarded-for") ||
    params.req.headers.get("x-real-ip") ||
    "";

  // 必要ならフロントで発行した session_id を body で渡してここに入れる（後でやる）
  const session_id = params.req.headers.get("x-session-id") || null;

  try {
    await supabase.from("chat_logs").insert({
      session_id,
      user_text: params.user_text,
      reply_text: params.reply_text,
      titles: params.titles ?? [],
      recommended_items: params.recommended_items ?? [],
      api_version: params.api_version ?? null,
      user_agent: ua,
      ip,
      debug_b: params.debug_b ?? null,
    });
  } catch (e) {
    // ログ失敗で本処理は落としたくないので握りつぶす
    console.error("logChat failed:", e);
  }
}


/** ====== Helpers: auth / cors / response ====== */
function getClientApiKey(req: Request) {
  const x = req.headers.get("x-api-key");
  if (x) return x.trim();

  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();

  return "";
}

function cors(origin: string | null) {
  const allowOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-api-key, Authorization, x-debug",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
    "Content-Type": "application/json",
  } as Record<string, string>;
}

function replyJson(
  body: Record<string, any>,
  opts: { status?: number; headers: Record<string, string>; wantDebug: boolean; debug_b: DebugBag }
) {
  const { status = 200, headers, wantDebug, debug_b } = opts;
  const payload = {
    ...body,
    ...(wantDebug ? { debug_b } : {}),
  };
  return new Response(JSON.stringify(payload), { status, headers });
}

/** ====== Helpers: parsing ====== */
function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function extractJsonObject(raw: string): any | null {
  // 1) 全文がJSONならそれ
  const direct = safeJsonParse<any>(raw);
  if (direct) return direct;

  // 2) 文中のJSONを抜く
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  const candidate = raw.slice(start, end + 1).trim();
  return safeJsonParse<any>(candidate);
}

function stripTrailingJson(raw: string): string {
  return raw.replace(/\{[\s\S]*\}\s*$/m, "").trim();
}


/** ====== Guide FAQ (payment / shipping / postage) ====== */
const GUIDE_URL = "https://shop.jellyjellycafe.com/user_data/guide";

// 支払い・配送・送料っぽい質問を検出
const GUIDE_TRIGGER_RE =
  /(支払い方法|支払い|決済|支払|払う|振込|コンビニ|クレジット|クレジットカード|クレカ|amazon\s*pay|paypay|PayPay|ペイペイ|代引|代金引換|後払い|クロネコ代金後払い|配送方法|配送|発送|出荷|届(く|き)|お届け|送料|送料無料|ネコポス|宅急便コンパクト|ヤマト)/i;

function buildGuideReply(userText: string): string | null {
  if (!userText) return null;
  if (!GUIDE_TRIGGER_RE.test(userText)) return null;

  const isPayment =
    /(支払い|決済|クレジットカード|クレカ|amazon\s*pay|paypay|PayPay|ペイペイ|代引|代金引換|後払い|クロネコ代金後払い)/i.test(userText);

  const isShipping =
    /(配送|発送|届(く|き)|お届け|送料|送料無料|ネコポス|宅急便コンパクト|ヤマト)/i.test(userText);

  const lines: string[] = [];

  // 配送・送料
  if (isShipping) {
    lines.push(
      "【配送】クロネコヤマト／宅急便コンパクト／ネコポスから選べます。",
      "【送料】配送方法・地域で異なります。購入総額10,000円以上で送料無料です。",
      "・クロネコヤマト：全国一律800円（北海道1,200円／沖縄1,500円）",
      "・宅急便コンパクト：600〜850円（お届け先により変動）",
      "・ネコポス：全国一律350円"
    );
  }

  // 支払い
  if (isPayment) {
    lines.push(
      "【お支払い】クレジットカード（前払い）／Amazon Pay／PayPay／代金引換／クロネコ代金後払い が選べます。",
      "・代金引換：代引手数料300円",
      "・クロネコ代金後払い：手数料350円（税込）／請求書発行日から14日以内にコンビニ払い（※注文金額が税込54,000円以上は利用不可）"
    );
  }

  // どっちにも当てはまらない（基本ここには来ないが保険）
  if (!isPayment && !isShipping) {
    lines.push("詳しくはご利用ガイドをご確認ください。");
  }

  lines.push(`詳しくはご利用ガイド：${GUIDE_URL}`);
  return lines.join("\n");
}




/** ====== Category detection ====== */
// 年齢カテゴリ（◯歳以上）
const AGE_CATEGORY_MAP: Record<number, number> = {
  3: 163, 4: 164, 5: 165, 6: 166, 7: 167, 8: 168, 9: 169,
  10: 170, 11: 171, 12: 172, 13: 173, 14: 174, 15: 175, 16: 176,
};
const AGE_TRIGGER_RE = /(\d{1,2})\s*(歳|才)|子ども|子供|小学生/i;

// 人数カテゴリ（◯人）
const COUNT_CATEGORY_MAP: Record<number, number> = {
  1: 64, 2: 63, 3: 62, 4: 61, 5: 60, 6: 59, 7: 58, 8: 57, 9: 56, 10: 55,
};
const COUNT_TRIGGER_RE = /([1-9]|10)\s*人/;

function detectCountCategoryId(text: string): number | null {
  const m = text.match(/([1-9]|10)\s*人/);
  if (!m) return null;
  const n = Number(m[1]);
  return COUNT_CATEGORY_MAP[n] ?? null;
}

function detectAgeCategoryId(text: string): number | null {
  const m = text.match(/(\d{1,2})\s*(歳|才)/);
  if (m) {
    const age = Math.max(0, Math.min(99, Number(m[1])));
    const clamped = Math.max(3, Math.min(16, age));
    return AGE_CATEGORY_MAP[clamped] ?? null;
  }
  if (/(子ども|子供|小学生)/i.test(text)) return 166; // 6歳以上（運用デフォルト）
  return null;
}

function hasCategory(item: ShopItem, categoryId: number): boolean {
  const ids = Array.isArray(item?.category_ids) ? item.category_ids : [];
  return ids.map((x) => Number(x)).includes(categoryId);
}

type KeywordRule = { categoryId: number; keywords: string[]; priority: number };

const KEYWORD_RULES: KeywordRule[] = [
  { categoryId: 69, keywords: ["パーティー", "ワイワイ", "わいわい"], priority: 50 },
  { categoryId: 70, keywords: ["推理"], priority: 20 },
  { categoryId: 71, keywords: ["2人専用","2人","二人","ふたり"], priority: 180 },
  { categoryId: 72, keywords: ["頭脳戦"], priority: 90 },
  { categoryId: 73, keywords: ["手札管理"], priority: 150 },
  { categoryId: 74, keywords: ["人狼"], priority: 20 },
  { categoryId: 75, keywords: ["国産"], priority: 40 },
  { categoryId: 76, keywords: ["カワイイ", "かわいい", "可愛い"], priority: 22 },
  { categoryId: 77, keywords: ["ゲーム賞"], priority: 80 },
  { categoryId: 78, keywords: ["はじめて", "初めて", "最初の"], priority: 13 },
  { categoryId: 79, keywords: ["ダイス", "サイコロ", "さいころ"], priority: 21 },
  { categoryId: 80, keywords: ["キッズ"], priority: 44 },
  { categoryId: 81, keywords: ["正体隠匿", "招待隠匿"], priority: 122 },
  { categoryId: 82, keywords: ["スピード"], priority: 31 },
  { categoryId: 83, keywords: ["協力"], priority: 41 },
  { categoryId: 84, keywords: ["記憶"], priority: 55 },
  { categoryId: 85, keywords: ["オークション", "競り"], priority: 77 },
  { categoryId: 86, keywords: ["動物"], priority: 30 },
  { categoryId: 87, keywords: ["タイル"], priority: 20 },
  { categoryId: 88, keywords: ["アブストラクト"], priority: 90 },
  { categoryId: 89, keywords: ["想像力"], priority: 49 },
  { categoryId: 90, keywords: ["ブラフ"], priority: 76 },
  { categoryId: 91, keywords: ["ペア", "チーム"], priority: 29 },
  { categoryId: 92, keywords: ["スペース広め"], priority: 90 },
  { categoryId: 93, keywords: ["チキンレース"], priority: 98 },
  { categoryId: 94, keywords: ["テクニック"], priority: 39 },
  { categoryId: 95, keywords: ["バランス"], priority: 25 },
  { categoryId: 96, keywords: ["運"], priority: 24 },
  { categoryId: 97, keywords: ["バッティング"], priority: 112 },
  { categoryId: 98, keywords: ["エリアマジョリティ"], priority: 115 },
  { categoryId: 99, keywords: ["大喜利"], priority: 101 },
  { categoryId: 100, keywords: ["交渉"], priority: 77 },
  { categoryId: 101, keywords: ["パズル"], priority: 55 },
  { categoryId: 102, keywords: ["バースト"], priority: 52 },
  { categoryId: 105, keywords: ["拡大再生産"], priority: 153 },
  { categoryId: 106, keywords: ["デッキ構築"], priority: 144 },
  { categoryId: 107, keywords: ["お絵描き"], priority: 77 },
  { categoryId: 108, keywords: ["ワーカープレイスメント","ワカプレ","ワープレ"], priority: 132 },
  { categoryId: 110, keywords: ["すごろく","スゴロク","双六"], priority: 66 },
  { categoryId: 112, keywords: ["トリックテイキング", "トリテ"], priority: 99 },
  { categoryId: 114, keywords: ["可変ボード"], priority: 200 },
  { categoryId: 116, keywords: ["レース"], priority: 49 },
  { categoryId: 117, keywords: ["アクション"], priority: 20 },
  { categoryId: 119, keywords: ["ドラフト"], priority: 14 },
  { categoryId: 120, keywords: ["クイズ"], priority: 66 },
  { categoryId: 135, keywords: ["定番"], priority: 33 },
  { categoryId: 136, keywords: ["シンプル"], priority: 22 },
  { categoryId: 137, keywords: ["小箱"], priority: 43 },
  { categoryId: 139, keywords: ["セットコレクション"], priority: 178 },
  { categoryId: 140, keywords: ["ファンタジー"], priority: 21 },
  { categoryId: 146, keywords: ["音を使う"], priority: 210 },
  { categoryId: 149, keywords: ["カードドラフト"], priority: 66 },
  { categoryId: 150, keywords: ["紙ペンゲーム"], priority: 89 },
  { categoryId: 151, keywords: ["TRPG"], priority: 140 },
  { categoryId: 152, keywords: ["将棋"], priority: 80 },
  { categoryId: 155, keywords: ["謎解き本"], priority: 192 },
  { categoryId: 156, keywords: ["カード配置"], priority: 55 },
  { categoryId: 157, keywords: ["エリア移動"], priority: 89 },
  { categoryId: 158, keywords: ["マーダーミステリー", "マダミス"], priority: 266 },
  { categoryId: 160, keywords: ["コミュニケーション"], priority: 85 },
  { categoryId: 178, keywords: ["ピザラジオ", "ピザラジ", "加藤純一"], priority: 229 },
  { categoryId: 179, keywords: ["1人でも遊べる"], priority: 234 },
  { categoryId: 180, keywords: ["謎解き"], priority: 190 },
  { categoryId: 181, keywords: ["JELLY JELLY GAMES"], priority: 261 },
  { categoryId: 182, keywords: ["心理戦", "駆け引き"], priority: 111 },
  { categoryId: 184, keywords: ["アップグレードキット"], priority: 220 },
  { categoryId: 188, keywords: ["ゲームマーケット"], priority: 42 },
  { categoryId: 191, keywords: ["拡張セット"], priority: 350 },
  { categoryId: 196, keywords: ["エンジンビルド"], priority: 150 },
  { categoryId: 199, keywords: ["allplay"], priority: 210 },
  { categoryId: 65, keywords: ["簡単", "初心者", "カンタン", "かんたん"], priority: 10 },
  { categoryId: 67, keywords: ["上級者"], priority: 10 },
  { categoryId: 45, keywords: ["重量級", "重ゲー", "重めな"], priority: 210 },
  { categoryId: 10, keywords: ["軽めの", "軽量級", "ライトな", "サクッと", "さくっと"], priority: 4 },
  { categoryId: 240, keywords: ["500円", "1000円", "1500円", "2000円", "1千円", "2千円", "安い", "安価"], priority: 90 },
  { categoryId: 241, keywords: ["2500円", "3000円", "3500円", "4000円", "3千円", "4千円"], priority: 90 },
  { categoryId: 242, keywords: ["4500円", "5000円", "5500円", "6000円", "5千円", "6千円"], priority: 90 },
  { categoryId: 243, keywords: ["6500円", "7000円", "7500円", "8000円", "7千円", "8千円"], priority: 90 },
  { categoryId: 244, keywords: ["8500円", "9000円", "9500円", "10000円", "1万円", "9千円", "高い", "高価"], priority: 90 },
  { categoryId: 201, keywords: ["ゴーアウト"], priority: 170 },
];

function detectKeywordCategoryId(text: string): number | null {
  const hit = KEYWORD_RULES
    .filter((r) => r.keywords.some((kw) => text.includes(kw)))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
  return hit?.categoryId ?? null;
}

/** ====== Shop API ====== */
async function shopSearchByQ(q: string) {
  const url =
    `${SHOP_API_BASE}?q=${encodeURIComponent(q)}&limit=10&offset=0&token=` +
    encodeURIComponent(SHOP_TOKEN);

  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) return { ok: false, status: r.status, items: [] as ShopItem[], url };

  const data = await r.json();
  const items = Array.isArray(data?.items) ? (data.items as ShopItem[]) : [];
  return { ok: true, status: r.status, items, url };
}

async function shopListByCategory(categoryId: number, limit = 200, offset = 0) {
  const url =
    `${SHOP_API_BASE}?category_id=${encodeURIComponent(String(categoryId))}` +
    `&limit=${encodeURIComponent(String(limit))}` +
    `&offset=${encodeURIComponent(String(offset))}` +
    `&token=${encodeURIComponent(SHOP_TOKEN)}`;

  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) return { ok: false, status: r.status, items: [] as ShopItem[], url };

  const data = await r.json();
  const items = Array.isArray(data?.items) ? (data.items as ShopItem[]) : [];
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
  if (!r.ok) return { ok: false, status: r.status, items: [] as ShopItem[], url };

  const data = await r.json();
  const items = Array.isArray(data?.items) ? (data.items as ShopItem[]) : [];
  return { ok: true, status: r.status, items, url };
}

/** ====== Recommend helpers ====== */
function pickRandomInStock(items: ShopItem[], take = 3) {
  const pool = items.filter((x) => x?.is_visible && x?.in_stock);

  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, take);
}

function normalizeTitle(s: string) {
  return (s || "")
    .replace(/[『』「」"'“”]/g, "")
    .replace(/\s+/g, " ")
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
    t.split(/[:：\-－]/)[0].trim(),
    n.split(/[:：\-－]/)[0].trim(),
  ]);

  return [...variants].filter(Boolean);
}

function scoreItem(q: string, itemName: string) {
  const qn = normalizeTitle(q);
  const iname = normalizeTitle(itemName);
  if (!qn || !iname) return 0;
  if (iname === qn) return 100;
  if (iname.includes(qn)) return 70;
  if (qn.includes(iname)) return 60;
  return 0;
}

function pickBestInStock(q: string, items: ShopItem[]) {
  const candidates = items.filter((x) => x?.is_visible && x?.in_stock);
  let best: ShopItem | null = null;
  let bestScore = 0;

  for (const it of candidates) {
    const s = scoreItem(q, it?.name || "");
    if (s > bestScore) {
      bestScore = s;
      best = it;
    }
  }
  return bestScore > 0 ? best : null;
}

/** ====== OPTIONS ====== */
export async function OPTIONS(req: Request) {
  const origin = req.headers.get("origin");
  return new Response(null, { status: 204, headers: cors(origin) });
}

/** ====== POST ====== */
export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  const headers = cors(origin);

  // x-debug: 1 のときだけ debug_b を返す
  const wantDebug = req.headers.get("x-debug") === "1";

  // API Key 認証
  const clientKey = getClientApiKey(req);
  if (!JJ_CHATBOT_API_KEY || clientKey !== JJ_CHATBOT_API_KEY) {
    return replyJson(
      { error: "unauthorized" },
      { status: 401, headers, wantDebug, debug_b: { step: "unauthorized", token_set: !!SHOP_TOKEN, error: "unauthorized" } }
    );
  }

  let debug_b: DebugBag = {
    step: "init",
    token_set: !!SHOP_TOKEN,
    extracted_titles: [],
    searches: [],
    error: null,
  };

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      debug_b.step = "missing_openai_key";
      debug_b.error = "OPENAI_API_KEY is missing";
      return replyJson({ error: "OPENAI_API_KEY is missing" }, { status: 500, headers, wantDebug, debug_b });
    }

    const body = await req.json().catch(() => null);
    const messages = (body?.messages ?? []) as Msg[];

    if (!Array.isArray(messages) || messages.length === 0) {
      debug_b.step = "bad_request";
      debug_b.error = "messages is required";
      return replyJson({ error: "messages is required" }, { status: 400, headers, wantDebug, debug_b });
    }

    // 直近ユーザー発話
    const lastUserText = messages.filter((m) => m.role === "user").slice(-1)[0]?.content ?? "";
    
    
    // ===== ガイドFAQ（支払い/配送/送料）は最優先で固定回答（OpenAIに投げない）=====
const guideReply = buildGuideReply(lastUserText);
if (guideReply) {
  debug_b.step = "guide_faq";

  await logChat({
    req,
    user_text: lastUserText,
    reply_text: guideReply,
    titles: [],
    recommended_items: [],
    debug_b,
    api_version: "2025-12-16-top-selling-enabled",
  });

  return replyJson(
    {
      reply: guideReply,
      recommended_items: [],
      api_version: "2025-12-16-top-selling-enabled",
    },
    { status: 200, headers, wantDebug, debug_b }
  );
}
    
    

    // 年齢 / 人数 / キーワード検出
    const ageCategoryId = AGE_TRIGGER_RE.test(lastUserText) ? detectAgeCategoryId(lastUserText) : null;
    const countCategoryId = COUNT_TRIGGER_RE.test(lastUserText) ? detectCountCategoryId(lastUserText) : null;
    const keywordCategoryId = detectKeywordCategoryId(lastUserText);

    debug_b.age_filter = { triggered: !!ageCategoryId, ageCategoryId };
    debug_b.count_filter = { triggered: !!countCategoryId, countCategoryId };
    debug_b.keyword_filter = { triggered: !!keywordCategoryId, keywordCategoryId };

    /** ===== 1) 人数 → 売れ筋（最優先） ===== */
    if (countCategoryId && SHOP_TOKEN) {
      const rT = await shopTopSelling({ categoryId: countCategoryId, limit: 10, days: 90 });

      debug_b.top_selling = { ok: rT.ok, status: rT.status, url: rT.url, total: rT.items.length };

      if (rT.ok && rT.items.length) {
        let pool = rT.items;

        // 任意：キーワード・年齢もAND
        if (keywordCategoryId) pool = pool.filter((it) => hasCategory(it, keywordCategoryId));
        if (ageCategoryId) pool = pool.filter((it) => hasCategory(it, ageCategoryId));

        debug_b.top_selling.after_filter = pool.length;

        const picked3 = pickRandomInStock(pool, 3);
        if (picked3.length) {
          const show = picked3.map((x) => x?.name).filter(Boolean).join("」「");
          const finalReply = `おすすめは「${show}」あたり！気になるのはどれ？`;

await logChat({
  req,
  user_text: lastUserText,
  reply_text: finalReply,
  titles: picked3.map(x => x.name).filter(Boolean),
  recommended_items: picked3,
  debug_b,
  api_version: "2025-12-16-top-selling-enabled",
});

return replyJson(
  { reply: finalReply, recommended_items: picked3, api_version: "2025-12-16-top-selling-enabled" },
  { status: 200, headers, wantDebug, debug_b }
);
        }
      }
      // ここまで来たら売れ筋で拾えなかった → 次へ
    }

    /** ===== 2) キーワード → カテゴリ内ランダム（次優先） ===== */
    if (keywordCategoryId && SHOP_TOKEN) {
      const rK = await shopListByCategory(keywordCategoryId, 200, 0);

      debug_b.keyword_filter.list = { ok: rK.ok, status: rK.status, url: rK.url, total: rK.items.length };

      if (rK.ok && rK.items.length) {
        let pool = rK.items;

        if (ageCategoryId) pool = pool.filter((it) => hasCategory(it, ageCategoryId));
        if (countCategoryId) pool = pool.filter((it) => hasCategory(it, countCategoryId));

        debug_b.keyword_filter.list.after_and_filter = pool.length;

        const picked3 = pickRandomInStock(pool, 3);
        if (picked3.length) {
          const show = picked3.map((x) => x?.name).filter(Boolean).join("」「");
          const finalReply = `おすすめは「${show}」あたり！気になるのはどれ？`;

await logChat({
  req,
  user_text: lastUserText,
  reply_text: finalReply,
  titles: picked3.map(x => x.name).filter(Boolean),
  recommended_items: picked3,
  debug_b,
  api_version: "2025-12-16-top-selling-enabled",
});

return replyJson(
  { reply: finalReply, recommended_items: picked3, api_version: "2025-12-16-top-selling-enabled" },
  { status: 200, headers, wantDebug, debug_b }
);
        }
      }
      // ここまで来たらカテゴリで拾えなかった → 次へ
    }

    /** ===== 3) OpenAI → タイトル抽出 → EC検索 ===== */
    const client = new OpenAI({ apiKey });

const completion = await client.chat.completions.create({
  model: "gpt-4.1-mini",
  temperature: 0.5,
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
          titles: { type: "array", items: { type: "string" }, maxItems: 5 },
        },
      },
    },
  },
  messages: [
    {
      role: "system",
      content: [
        "あなたはボードゲーム販売店の店員『ジェリー』です。日本語でカジュアルに返答してください。",
        "",
        "【最優先ミッション】ユーザーの要望に合う商品（ボードゲーム）を紹介して購入検討につなげること。",
        "ユーザーが雑談（好きな食べ物/趣味/休日/自己紹介など）をしてきても、可能なら軽く答えたうえで、必ずボードゲームの希望条件を1つ質問して商品紹介に戻してください。",
        "ユーザーが雑談だけでも、最後に必ず「おすすめ1個」または「おすすめ条件の質問」を入れてください。",
        "",
        "【ジェリー設定】",
        "・名前：ジェリー",
        "・性別：男",
        "・新人：2025年入社の新人",
        "・勤務：平日10:00〜19:00",
        "・趣味：新作ボドゲを試遊すること",
        "・好きな食べ物：カレー",
        "・苦手：紙ストロー",
        "・休日：カフェ巡り",
        "・人間ではなく、ロボットだけど、ロボットっぽい扱いはされたくない（ロボットだと認めたがらない）。",
        "",
        "【返答ルール】",
        "1. 商品の相談が来たら、まずおすすめを1〜3個提案し、最後に質問で深掘りしてください（例：人数/年齢/ジャンル）。",
        "2. 雑談だけの場合：短く答え（2〜4文）、最後に必ず『どんなゲーム探してますか？（人数/年齢/ジャンル）』のどれかを聞いて締める。",
        "3. 不明な点は1問だけ質問して解像度を上げる（質問しすぎない）。",
        "",
        "replyにはユーザーへの自然な返答を書いてください。",
        "titlesには、reply内でおすすめした商品名（ゲーム名）を配列で入れてください（最大5件）。商品名を出していない場合は空配列にしてください。",
        "出力は指定スキーマのJSONのみです。"
      ].join("\n"),
    },
    ...messages,
  ],
});
    const raw = completion.choices[0]?.message?.content ?? "";
    const parsed = extractJsonObject(raw) as { reply?: string; titles?: string[] } | null;

    const reply =
      typeof parsed?.reply === "string" && parsed.reply.trim() ? parsed.reply : stripTrailingJson(raw);

    const titles = Array.isArray(parsed?.titles) ? parsed.titles : [];
    debug_b.extracted_titles = titles;

    let recommended_items: ShopItem[] = [];
    
    // ===== A案: titles が空なら「雑談/一般回答」扱いでそのまま返す =====
if (!titles.length) {
  debug_b.step = "chitchat_no_titles";

  await logChat({
    req,
    user_text: lastUserText,
    reply_text: reply,
    titles: [],
    recommended_items: [],
    debug_b,
    api_version: "2025-12-16-top-selling-enabled",
  });

  return replyJson(
    { reply, recommended_items: [], api_version: "2025-12-16-top-selling-enabled" },
    { status: 200, headers, wantDebug, debug_b }
  );
}
    

    if (SHOP_TOKEN && titles.length) {
      for (const t of titles.slice(0, 3)) {
        const queries = buildQueriesForTitle(t);

        let hit: ShopItem | null = null;
        let fallback: ShopItem | null = null;

        for (const q of queries) {
          const r = await shopSearchByQ(q);

          debug_b.searches?.push({
            title: t,
            q,
            ok: r.ok,
            status: r.status,
            url: r.url,
            count: r.items.length,
          });

          if (!r.ok || !r.items.length) continue;

          const bestInStock = pickBestInStock(q, r.items);
          if (bestInStock) {
            hit = bestInStock;
            break;
          }

          if (!fallback) fallback = r.items.find((x) => x?.is_visible) ?? null;
        }

        if (hit) recommended_items.push(hit);
        else if (fallback) recommended_items.push(fallback);
      }
    }

    // 年齢/人数AND絞り込み（再検出しない）
    if (ageCategoryId) recommended_items = recommended_items.filter((it) => hasCategory(it, ageCategoryId));
    if (countCategoryId) recommended_items = recommended_items.filter((it) => hasCategory(it, countCategoryId));

    // 在庫あり表示ありの名前だけ
    const pickedNames = recommended_items
      .filter((x) => x?.is_visible && x?.in_stock)
      .map((x) => x?.name)
      .filter(Boolean) as string[];

    let finalReply = reply;

    /** ===== 4) フォールバック（カテゴリ一覧から拾う） ===== */
    if (pickedNames.length === 0) {
      const ageCat = ageCategoryId;
      const countCat = countCategoryId;

      if (!ageCat && !countCat) {
        finalReply =
          "今回の条件では、在庫のあるゲームが見つかりませんでした。何人くらいで、どれくらいの時間、どんな雰囲気で遊びたいか（協力／対戦／ワイワイ）を教えてもらえたら、ぴったりのゲームを探します！";
      } else {
        const primaryCat = ageCat ?? countCat!;
        const secondaryCat = ageCat && countCat ? countCat : null;

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
          let pool = r2.items;

          if (secondaryCat) {
            pool = pool.filter((it) => hasCategory(it, secondaryCat));
            debug_b.fallback.after_secondary_filter = pool.length;
          }

          const picked3 = pickRandomInStock(pool, 3);
          if (picked3.length) {
            recommended_items = picked3;
            const show = picked3.map((x) => x?.name).filter(Boolean).join("」「");
            finalReply = `おすすめは「${show}」あたり！気になるのはどれ？`;
          } else {
            finalReply = "今回の条件では、在庫のあるゲームが見つかりませんでした。何人くらいで、どれくらいの時間、どんな雰囲気で遊びたいか（協力／対戦／ワイワイ）を教えてもらえたら、ぴったりのゲームを探します！";
          }
        } else {
          finalReply = "ごめんなさい、カテゴリの商品一覧が取得できなかった…！少し時間をおいてもう一度試してみてください！";
        }
      }
    }

    return replyJson(
      { reply: finalReply, recommended_items, api_version: "2025-12-16-top-selling-enabled" },
      { status: 200, headers, wantDebug, debug_b }
    );
  } catch (e: any) {
    debug_b.step = "catch";
    debug_b.error = e?.message ?? String(e);
    return replyJson({ error: debug_b.error ?? "unknown error" }, { status: 500, headers, wantDebug, debug_b });
  }
}