/* =====================================================================
 * AI進化レーダー — 毎日の自動取得スクリプト（GitHub Actions が実行）
 * ---------------------------------------------------------------------
 * 各AIツールのRSS/Googleニュースフィードを取得し、ノイズを除外して
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
  fs.writeFileSync("data.json", JSON.stringify(out, null, 2));
  console.error("WROTE data.json with", out.length, "items");
})();
