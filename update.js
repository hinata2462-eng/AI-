/* =====================================================================
 * AI進化レーダー — 毎日の自動取得スクリプト（GitHub Actions が実行）
 * ---------------------------------------------------------------------
 * AIツールやAI関連分野のRSS/Googleニュースフィードを取得し、ノイズを除外して
 * data.json を生成する。依存ライブラリ無し（Node 18+ の標準 fetch）。
 * 実行: node update.js  →  data.json を書き出す
 * ===================================================================== */
const fs = require("fs");

// 各ツール。feeds=検証済みフィード（公式RSS＋GoogleニュースRSS）、match=その記事が本当にそのツールの話か判定する正規表現
const TOOLS = [
  { name: "ChatGPT / OpenAI", match: /chatgpt|openai/i, feeds: [
    "https://news.google.com/rss/search?q=OpenAI%20ChatGPT%20when:7d&hl=ja&gl=JP&ceid=JP:ja",
    "https://openai.com/news/rss.xml" ] },
  { name: "Claude / Claude Code", match: /claude|anthropic/i, feeds: [
    "https://news.google.com/rss/search?q=Anthropic%20Claude%20when:7d&hl=ja&gl=JP&ceid=JP:ja",
    "https://github.com/anthropics/claude-code/releases.atom" ] },
  { name: "Gemini", match: /gemini/i, feeds: [
    "https://news.google.com/rss/search?q=Google%20Gemini%20AI%20when:7d&hl=ja&gl=JP&ceid=JP:ja",
    "https://blog.google/products-and-platforms/products/gemini/rss/" ] },
  { name: "v0", match: /\bv0\b|vercel/i, feeds: [
    "https://news.google.com/rss/search?q=Vercel%20v0%20when:7d&hl=en-US&gl=US&ceid=US:en",
    "https://vercel.com/changelog/rss.xml" ] },
  { name: "Cursor", match: /cursor/i, feeds: [
    "https://cursor.com/changelog/rss.xml",
    "https://news.google.com/rss/search?q=Cursor%20AI%20code%20editor%20when:7d&hl=ja&gl=JP&ceid=JP:ja" ] },
  { name: "Suno", match: /suno/i, feeds: [
    "https://news.google.com/rss/search?q=Suno%20%E9%9F%B3%E6%A5%BD%20AI%20when:7d&hl=ja&gl=JP&ceid=JP:ja" ] },
  { name: "Runway", match: /runway/i, feeds: [
    "https://news.google.com/rss/search?q=Runway%20AI%20video%20when:7d&hl=en-US&gl=US&ceid=US:en" ] },
  { name: "Canva", match: /canva/i, feeds: [
    "https://news.google.com/rss/search?q=Canva%20AI%20when:7d&hl=ja&gl=JP&ceid=JP:ja" ] },
  { name: "NotebookLM", match: /notebooklm|ノートブックlm/i, feeds: [
    "https://news.google.com/rss/search?q=Google%20NotebookLM%20when:7d&hl=ja&gl=JP&ceid=JP:ja",
    "https://blog.google/innovation-and-ai/products/notebooklm/rss/" ] },
];
const PER_TOOL = 6; // 1ツールあたり最新何件まで残すか

// ノイズ（広告・セール・ランキング記事・求人など）を落とす正規表現
const NOISE = /(セール|キャンペーン|クーポン|プレゼント|無料配布|値引き|%\s*オフ|％\s*オフ|\d+\s*%\s*off|kindle|割引|まとめ買い|求人|採用情報|転職|ランキング|おすすめ\d*\s*選|\d+\s*選|ベスト\d+|top\s*\d+|best\s+\d+\b|\bsale\b|\bdiscount\b|\bcoupon\b|\bgiveaway\b)/i;

function isOfficial(url) { return !/news\.google\.com/i.test(url); }
// 採用判定：公式フィードは無条件採用。ニュースは「ツール名を含む」かつ「ノイズでない」もののみ。
function keep(item, tool) {
  if (item.official) return true;
  const text = item.title + " " + (item.desc || "");
  if (!tool.match.test(text)) return false;
  if (NOISE.test(item.title)) return false;
  return true;
}

/* =====================================================================
 * ②AI厳選（Claude API・任意）
 * GitHub Secret の ANTHROPIC_API_KEY があれば、Claudeが各記事を
 * 「一般の利用者に役立つか」判定→不要を除外→日本語に翻訳＋要約。
 * 鍵が無い/失敗した場合は静かにスキップし、ルール厳選の結果をそのまま使う。
 * ===================================================================== */
const AI_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8"; // 安く済ませたいなら "claude-haiku-4-5"
const AI_MAX = 12; // AIが選ぶ最大件数

async function callClaude(system, user) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: AI_MODEL,
      max_tokens: 8000,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error("Anthropic HTTP " + res.status + ": " + (await res.text()).slice(0, 300));
  const data = await res.json();
  if (data.stop_reason === "refusal") throw new Error("refusal");
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}

function parseJsonArray(text) {
  if (!text) return null;
  const a = text.indexOf("["), b = text.lastIndexOf("]");
  if (a < 0 || b <= a) return null;
  try { const arr = JSON.parse(text.slice(a, b + 1)); return Array.isArray(arr) ? arr : null; }
  catch (e) { return null; }
}

async function aiCurate(items) {
  if (!process.env.ANTHROPIC_API_KEY) { console.error("ANTHROPIC_API_KEY 未設定 → AI厳選スキップ（ルール厳選のまま）"); return null; }
  const list = items.map((it, i) => ({ i, tool: it.tool, title: it.title, excerpt: (it.raw_excerpt || "").toString().slice(0, 180) }));
  const system =
    "あなたは、AIに詳しくない人にも理解できる日本語で伝えるAIニュース編集者です。" +
    "製品アップデート、新機能、使い方、料金変更だけでなく、AI政策、規制、著作権、補助金・助成金、AI関連企業・株式、研究、セキュリティ、半導体など、利用者の仕事や生活に影響する情報を重視してください。" +
    "広告、別テーマの誤ヒット、根拠の薄い記事、同じ内容の重複記事は除外してください。専門用語をそのまま使わず、必要な場合は短い説明を添えてください。";
  const user =
    "次のAI関連ニュース候補(JSON)から、一般の利用者が知っておく価値のあるものだけを重要な順に最大" + AI_MAX + "件選んでください。\n" +
    "出力は次の形式のJSON配列だけ（前置き・説明・コードフェンスは一切不要）:\n" +
    '[{"i":元番号, "title_ja":"日本語の短いタイトル", "summary_ja":"30〜70字の日本語の一言要約", "detail_ja":"180〜300字、5〜7文のやさしい日本語で説明。①何のニュースか ②以前と何が違うか ③専門用語の意味 ④利用者にどんな影響があるか ⑤まず何を確認・試せばよいか、の順に書く。中学生が初めて読んでも分かる言葉を使い、1文を短くする", "importance":"S|A|B"}]\n' +
    "英語は必ず自然な日本語に翻訳。detail_jaは題名とexcerptを根拠に書く。元記事に無い具体的な数字・日付・固有名詞・効果は創作しない。分からない点は断定しない。役立たないものは選ばない。\n候補:\n" +
    JSON.stringify(list);

  let text;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { text = await callClaude(system, user); break; }
    catch (e) { console.error("AI厳選 試行" + (attempt + 1) + " 失敗:", String(e.message || e).slice(0, 200)); }
  }
  const arr = parseJsonArray(text);
  if (!arr || !arr.length) return null;

  const out = [];
  for (const e of arr) {
    const idx = Number(e && e.i);
    if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) continue;
    const src = items[idx];
    const titleJa = (e.title_ja || "").toString().trim() || src.title;
    const sumJa = (e.summary_ja || "").toString().trim();
    const detailJa = (e.detail_ja || "").toString().trim();
    out.push({ tool: src.tool, title: titleJa, source_url: src.source_url, published_at: src.published_at, raw_excerpt: sumJa || src.raw_excerpt, detail: detailJa });
  }
  console.error("AI厳選: " + out.length + "件に厳選・翻訳（model=" + AI_MODEL + "）");
  return out.length ? out : null;
}

function decode(s) {
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  const map = { "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&#x27;": "'", "&amp;": "&" };
  for (const k in map) s = s.split(k).join(map[k]);
  return s.replace(/&nbsp;|&#160;| /g, " ");
}
function stripTags(s) { return decode(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
function tag(block, name) {
  const m = block.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "i"));
  return m ? decode(m[1]).trim() : "";
}
function atomLink(block) { const m = block.match(/<link[^>]*href="([^"]+)"/i); return m ? m[1] : ""; }
function toIso(raw) { if (!raw) return null; const d = new Date(raw); return isNaN(d) ? null : d.toISOString(); }

function parseFeed(xml, official) {
  let blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi);
  if (!blocks) blocks = xml.match(/<entry\b[\s\S]*?<\/entry>/gi);
  if (!blocks) return [];
  const out = [];
  for (const b of blocks) {
    const title = stripTags(tag(b, "title"));
    if (!title) continue;
    const link = tag(b, "link") || atomLink(b);
    const dateRaw = tag(b, "pubDate") || tag(b, "published") || tag(b, "updated");
    const desc = stripTags(tag(b, "description") || tag(b, "summary") || tag(b, "content")).slice(0, 500);
    out.push({ title, link, date: toIso(dateRaw), desc, official });
  }
  return out;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (AI-Radar bot)" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return await res.text();
}

(async () => {
  const out = [];
  for (const t of TOOLS) {
    let items = [];
    for (const url of t.feeds) {
      try { items = items.concat(parseFeed(await fetchText(url), isOfficial(url))); }
      catch (e) { console.error("  fetch fail", url, String(e.message || e).slice(0, 60)); }
    }
    const before = items.length;
    let kept = items.filter(it => keep(it, t));              // ★ノイズ除外（厳選①）
    // そのツールの記事が全部消えたら、ツール名一致だけ緩めてノイズ除外のみで救済（例: Sunoは見出しに"Suno"が無い事が多い）
    if (kept.length === 0 && before > 0) kept = items.filter(it => it.official || !NOISE.test(it.title));
    items = kept;
    const seen = new Set();
    items = items.filter(it => { const k = it.title.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    items.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    for (const it of items.slice(0, PER_TOOL)) {
      out.push({
        tool: t.name, title: it.title, source_url: it.link || "",
        published_at: it.date || new Date().toISOString(), raw_excerpt: it.desc || "",
      });
    }
    console.error("OK", t.name, "kept", Math.min(items.length, PER_TOOL), "/ fetched", before);
  }
  out.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));

  // ②AI厳選（任意・失敗時はルール厳選のまま）
  let final = out;
  try {
    const curated = await aiCurate(out);
    if (curated && curated.length) {
      curated.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
      final = curated;
    }
  } catch (e) {
    console.error("AI厳選で例外（ルール厳選のまま）:", String(e.message || e).slice(0, 200));
  }

  fs.writeFileSync("data.json", JSON.stringify(final, null, 2));
  console.error("WROTE data.json with", final.length, "items");
})();
