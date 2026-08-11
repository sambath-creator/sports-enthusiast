import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_ANON_KEY env vars.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─────────────────────────────────────────────────────────────
// Fetch helper
// ─────────────────────────────────────────────────────────────

async function fetchText(url, opts = {}) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: opts.headers || {},
      redirect: "follow",
    });
    clearTimeout(timeout);
    if (!res.ok) return { ok: false, status: res.status, text: "" };
    const text = await res.text();
    return { ok: true, status: res.status, text };
  } catch (err) {
    return { ok: false, status: 0, text: "", error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// Auto‑Discovery of streams
// ─────────────────────────────────────────────────────────────

// Extract all .m3u8 links from a webpage
async function discoverM3U8Links(url) {
  const result = await fetchText(url, { timeoutMs: 20000 });
  if (!result.ok) return [];

  const matches = [...result.text.matchAll(/https?:\/\/[^"' ]+\.m3u8/gi)];
  return matches.map(m => m[0]);
}

// Extract YouTube channels from curated GitHub M3U repos
async function discoverYouTubeChannelsFromRepo(repoUrl) {
  const result = await fetchText(repoUrl, { timeoutMs: 20000 });
  if (!result.ok) return [];

  const matches = [...result.text.matchAll(/https:\/\/www\.youtube\.com\/@[\w-]+/gi)];
  return matches.map(m => m[0]);
}

// Insert newly discovered sources into Supabase
async function autoInsertSources(newSources) {
  if (newSources.length === 0) return;

  const rows = newSources.map(src => ({
    name: src.name,
    source_type: src.type,
    source_url: src.url,
    group_name: src.group || "Cricket",
    country: src.country || null,
    discovered_from: src.discovered_from || null,
    is_active: true
  }));

  const { error } = await supabase.from("sources").insert(rows);
  if (error) {
    console.error("Failed to auto-insert sources:", error.message);
  } else {
    console.log(`Auto-added ${rows.length} new sources.`);
  }
}

// Main auto-discovery pipeline
async function autoDiscoverSources() {
  const discovered = [];

  // TouchCric
  const touchLinks = await discoverM3U8Links("https://touchcric.is");
  for (const link of touchLinks) {
    discovered.push({
      name: "TouchCric Auto",
      type: "hls",
      url: link,
      discovered_from: "touchcric"
    });
  }

  // SmartCric
  const smartLinks = await discoverM3U8Links("https://smartcric.is");
  for (const link of smartLinks) {
    discovered.push({
      name: "SmartCric Auto",
      type: "hls",
      url: link,
      discovered_from: "smartcric"
    });
  }

  // FreeHit
  const freeHitLinks = await discoverM3U8Links("https://freehit.eu");
  for (const link of freeHitLinks) {
    discovered.push({
      name: "FreeHit Auto",
      type: "hls",
      url: link,
      discovered_from: "freehit"
    });
  }

  // Curated GitHub repos (Option C)
  const curatedRepos = [
    "https://raw.githubusercontent.com/iptv-org/iptv/master/channels/cricket.m3u",
    "https://raw.githubusercontent.com/iptv-org/iptv/master/channels/sports.m3u"
  ];

  for (const repo of curatedRepos) {
    const ytLinks = await discoverYouTubeChannelsFromRepo(repo);
    for (const link of ytLinks) {
      discovered.push({
        name: "YouTube Auto",
        type: "youtube_channel",
        url: link,
        discovered_from: "github"
      });
    }
  }

  await autoInsertSources(discovered);
}

// ─────────────────────────────────────────────────────────────
// YouTube helpers (unchanged)
// ─────────────────────────────────────────────────────────────

function isCricketBroadcastTitle(title) {
  if (!title) return false;

  const gamingTerms = /\b(gameplay|gaming|video game|cricket 24|cricket 22|cricket 19|roblox|minecraft|fortnite|efootball|football manager|pes|fifa)\b/i;
  const cricketTerms = /\b(cricket|t20|odi|test match|wicket|batter|bowler|innings)\b/i;

  return cricketTerms.test(title) && !gamingTerms.test(title);
}

async function checkYouTubeChannel(channelUrl) {
  const liveShortcut = channelUrl.replace(/\/$/, "") + "/live";
  const result = await fetchText(liveShortcut, { timeoutMs: 20000 });

  if (!result.ok) {
    const pageResult = await fetchText(channelUrl, { timeoutMs: 20000 });
    if (!pageResult.ok) return null;
    return parseYouTubePage(pageResult.text, channelUrl);
  }

  const watchMatch = result.text.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
  const titleMatch =
    result.text.match(/"title":"([^"]+)"/) ||
    result.text.match(/<title>([^<]+)<\/title>/);

  const hasLiveBadge =
    result.text.includes('"style":"LIVE"') ||
    result.text.includes('"label":"Live"') ||
    result.text.includes('"isLive":true') ||
    result.text.includes('"badgeStyle":"LIVE"');

  if (watchMatch && hasLiveBadge) {
    const videoId = watchMatch[1];
    return {
      isLive: true,
      videoId,
      title: titleMatch ? titleMatch[1] : "Live Cricket",
      streamUrl: `https://www.youtube.com/watch?v=${videoId}`,
    };
  }

  return parseYouTubePage(result.text, channelUrl);
}

function parseYouTubePage(html) {
  const liveMatch = html.match(/"isLive":true.*?"videoId":"([a-zA-Z0-9_-]{11})"/s);
  const liveMatch2 = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"[^}]*?"isLive":true/s);
  const titleMatch = html.match(/"title":"([^"]*(?:[Ll]ive|CRICKET|cricket|match|Match)[^"]*)"/);

  const videoId = (liveMatch && liveMatch[1]) || (liveMatch2 && liveMatch2[1]);
  if (videoId) {
    return {
      isLive: true,
      videoId,
      title: titleMatch ? titleMatch[1] : "Live Cricket",
      streamUrl: `https://www.youtube.com/watch?v=${videoId}`,
    };
  }

  return { isLive: false, videoId: null, title: null, streamUrl: null };
}

// ─────────────────────────────────────────────────────────────
// HLS checker
// ─────────────────────────────────────────────────────────────

async function checkHlsStream(streamUrl) {
  const result = await fetchText(streamUrl, { timeoutMs: 15000 });
  if (!result.ok) {
    return { isLive: false, error: `HTTP ${result.status}` };
  }
  const text = result.text.trim();
  if (text.startsWith("#EXTM3U")) {
    return { isLive: true };
  }
  return { isLive: false, error: "Not a valid M3U8 response" };
}

// ─────────────────────────────────────────────────────────────
// Source checker
// ─────────────────────────────────────────────────────────────

async function checkSource(source) {
  let isLive = false;
  let streamUrl = null;
  let title = null;
  let error = null;

  if (source.source_type === "youtube_channel" || source.source_type === "youtube_live") {
    const result = await checkYouTubeChannel(source.source_url);
    if (result && result.isLive && isCricketBroadcastTitle(result.title)) {
      isLive = true;
      streamUrl = result.streamUrl;
      title = result.title;
    } else if (result && result.isLive) {
      error = "Rejected: title does not identify a real cricket broadcast";
    } else if (result && !result.isLive) {
      error = "No active live stream";
    } else {
      error = "Failed to fetch channel page";
    }
  }

  else if (source.source_type === "hls") {
    const target = source.stream_url || source.source_url;
    const result = await checkHlsStream(target);
    isLive = result.isLive;
    if (isLive) streamUrl = target;
    else error = result.error;
  }

  else if (source.source_type === "icc_tv" || source.source_type === "web") {
    streamUrl = source.source_url;
    isLive = true;
  }

  await supabase.from("stream_checks").insert({
    source_id: source.id,
    status: isLive ? "ok" : "fail",
    error: error || null,
  });

  if (isLive && streamUrl && streamUrl !== source.stream_url) {
    await supabase
      .from("sources")
      .update({ stream_url: streamUrl })
      .eq("id", source.id);
  }

  return {
    ...source,
    isLive,
    stream_url: isLive ? streamUrl : null,
    resolvedTitle: title,
  };
}

// ─────────────────────────────────────────────────────────────
// M3U generator
// ─────────────────────────────────────────────────────────────

function generateM3U(sources) {
  let m3u = "#EXTM3U\n";
  m3u += `# Updated: ${new Date().toISOString()}\n`;
  m3u += `# Sources: ${sources.length} live streams\n`;
  m3u += `# Auto-generated daily.\n\n`;

  for (const s of sources) {
    const title = s.resolvedTitle || s.name;
    const logo = s.logo_url || "";
    const group = s.group_name || "Cricket";

    m3u += `#EXTINF:-1 tvg-id="${s.id}" tvg-name="${s.name}" tvg-logo="${logo}" group-title="${group}"`;
    if (s.country) m3u += ` tvg-country="${s.country}"`;
    if (s.language) m3u += ` tvg-language="${s.language}"`;
    m3u += `,${title}\n`;
    m3u += `${s.stream_url}\n\n`;
  }

  return m3u;
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Auto-discovery phase ===");
  await autoDiscoverSources();

  console.log("=== Cricket M3U Playlist Generator ===");

  const { data: sources, error } = await supabase
    .from("sources")
    .select("*")
    .eq("is_active", true)
    .order("name");

  if (error) {
    console.error("Failed to fetch sources:", error.message);
    process.exit(1);
  }

  console.log(`Found ${sources.length} active sources.\n`);

  const liveSources = [];

  for (const source of sources) {
    process.stdout.write(`Checking: ${source.name}... `);
    const checked = await checkSource(source);

    if (checked.isLive) {
      console.log(`LIVE — ${checked.stream_url}`);
      liveSources.push(checked);
    } else {
      console.log(`offline — ${checked.error || "no stream"}`);
    }
  }

  console.log(`\n${liveSources.length} of ${sources.length} sources are currently live.`);

  if (liveSources.length === 0) {
    console.log("No live streams found. Adding ICC.tv reference.");
    const iccTv = sources.find((s) => s.source_type === "icc_tv");
    if (iccTv) {
      liveSources.push({
        ...iccTv,
        isLive: true,
        stream_url: iccTv.source_url,
        resolvedTitle: iccTv.name,
      });
    }
  }

  const m3uContent = generateM3U(liveSources);
  const outputPath = resolve(__dirname, "playlist.m3u");
  writeFileSync(outputPath, m3uContent, "utf-8");
  console.log(`Playlist written to: ${outputPath}`);

  const summary = {
    generated_at: new Date().toISOString(),
    total_sources: sources.length,
    live_count: liveSources.length,
    live_sources: liveSources.map((s) => ({
      name: s.name,
      stream_url: s.stream_url,
      country: s.country,
      group_name: s.group_name,
    })),
  };
  const summaryPath = resolve(__dirname, "playlist-status.json");
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf-8");
  console.log(`Status summary written to: ${summaryPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
