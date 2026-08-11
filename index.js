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
// Mobile User-Agent Fetch
// ─────────────────────────────────────────────────────────────

async function fetchText(url, opts = {}) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20000);

    const mobileUA =
      "Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36";

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": mobileUA,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": url,
        "Origin": url,
        ...opts.headers
      },
      redirect: "follow"
    });

    clearTimeout(timeout);

    if (!res.ok) {
      return { ok: false, status: res.status, text: "" };
    }

    const text = await res.text();
    return { ok: true, status: res.status, text };
  } catch (err) {
    return { ok: false, status: 0, text: "", error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────
// HTML Extraction Helpers
// ─────────────────────────────────────────────────────────────

// Extract match links from landing page
function extractMatchLinks(html, baseUrl) {
  const links = [];
  const regex = /href="([^"]+)"/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const href = match[1];

    if (
      href.includes("/live/") ||
      href.includes("/watch/") ||
      href.includes("/stream/")
    ) {
      const fullUrl = href.startsWith("http") ? href : baseUrl + href;
      links.push(fullUrl);
    }
  }

  return [...new Set(links)];
}

// Extract iframe URLs from match pages
function extractIframeLinks(html) {
  const links = [];
  const regex = /<iframe[^>]+src="([^"]+)"/gi;
  let match;

  while ((match = regex.exec(html)) !== null) {
    links.push(match[1]);
  }

  return [...new Set(links)];
}

// Extract .m3u8 links from iframe pages
function extractM3U8Links(html) {
  const matches = [...html.matchAll(/https?:\/\/[^"' ]+\.m3u8/gi)];
  return [...new Set(matches.map(m => m[0]))];
}

// ─────────────────────────────────────────────────────────────
// Hybrid Scraper (Landing → Match → Iframe → .m3u8)
// ─────────────────────────────────────────────────────────────

async function scrapeSite(baseUrl) {
  const discovered = [];

  // Step 1: fetch landing page
  const landing = await fetchText(baseUrl);
  if (!landing.ok) return discovered;

  // Step 2: extract match links
  const matchLinks = extractMatchLinks(landing.text, baseUrl);

  for (const matchUrl of matchLinks) {
    const matchPage = await fetchText(matchUrl);
    if (!matchPage.ok) continue;

    // Step 3: extract iframe URLs
    const iframeLinks = extractIframeLinks(matchPage.text);

    for (const iframeUrl of iframeLinks) {
      const iframePage = await fetchText(iframeUrl);
      if (!iframePage.ok) continue;

      // Step 4: extract m3u8 links
      const m3u8Links = extractM3U8Links(iframePage.text);

      for (const m3u8 of m3u8Links) {
        discovered.push({
          name: "Auto Stream",
          type: "hls",
          url: m3u8,
          discovered_from: baseUrl
        });
      }
    }
  }

  return discovered;
}

// ─────────────────────────────────────────────────────────────
// Curated GitHub Repo Scraper (YouTube Channels Only)
// ─────────────────────────────────────────────────────────────

async function discoverYouTubeChannelsFromRepo(repoUrl) {
  const result = await fetchText(repoUrl, { timeoutMs: 20000 });
  if (!result.ok) return [];

  const matches = [...result.text.matchAll(/https:\/\/www\.youtube\.com\/@[\w-]+/gi)];
  return [...new Set(matches.map(m => m[0]))];
}

// ─────────────────────────────────────────────────────────────
// Supabase Auto‑Insert (with duplicate removal)
// ─────────────────────────────────────────────────────────────

async function autoInsertSources(newSources) {
  if (newSources.length === 0) return;

  const unique = [];
  const seen = new Set();

  for (const src of newSources) {
    if (!seen.has(src.url)) {
      seen.add(src.url);
      unique.push(src);
    }
  }

  const rows = unique.map(src => ({
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

// ─────────────────────────────────────────────────────────────
// Auto‑Discovery Pipeline
// ─────────────────────────────────────────────────────────────

async function autoDiscoverSources() {
  const discovered = [];

  // Hybrid scraper sites
  const sites = [
    "https://touchcric.is",
    "https://smartcric.is",
    "https://freehit.eu"
  ];

  for (const site of sites) {
    console.log(`Scraping: ${site}`);
    const found = await scrapeSite(site);
    discovered.push(...found);
  }

  // Curated GitHub repos
  const curatedRepos = [
    "https://raw.githubusercontent.com/iptv-org/iptv/master/channels/cricket.m3u",
    "https://raw.githubusercontent.com/iptv-org/iptv/master/channels/sports.m3u"
  ];

  for (const repo of curatedRepos) {
    console.log(`Scanning GitHub repo: ${repo}`);
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
// YouTube Helpers
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
    return parseYouTubePage(pageResult.text);
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
      streamUrl: `https://www.youtube.com/watch?v=${videoId}`
    };
  }

  return parseYouTubePage(result.text);
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
      streamUrl: `https://www.youtube.com/watch?v=${videoId}`
    };
  }

  return { isLive: false, videoId: null, title: null, streamUrl: null };
}

// ─────────────────────────────────────────────────────────────
// HLS Checker
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
// Source Checker (YouTube + HLS + ICC + Web)
// ─────────────────────────────────────────────────────────────

async function checkSource(source) {
  let isLive = false;
  let streamUrl = null;
  let title = null;
  let error = null;

  // YouTube
  if (source.source_type === "youtube_channel" || source.source_type === "youtube_live") {
    const result = await checkYouTubeChannel(source.source_url);

    if (result && result.isLive && isCricketBroadcastTitle(result.title)) {
      isLive = true;
      streamUrl = result.streamUrl;
      title = result.title;
    } else if (result && result.isLive) {
      error = "Rejected: not a cricket broadcast";
    } else if (result && !result.isLive) {
      error = "No active live stream";
    } else {
      error = "Failed to fetch YouTube channel";
    }
  }

  // HLS
  else if (source.source_type === "hls") {
    const target = source.stream_url || source.source_url;
    const result = await checkHlsStream(target);

    isLive = result.isLive;
    if (isLive) streamUrl = target;
    else error = result.error;
  }

  // ICC.tv or Web (always considered live)
  else if (source.source_type === "icc_tv" || source.source_type === "web") {
    streamUrl = source.source_url;
    isLive = true;
  }

  // Log check result
  await supabase.from("stream_checks").insert({
    source_id: source.id,
    status: isLive ? "ok" : "fail",
    error: error || null
  });

  // Update stream_url if changed
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
    resolvedTitle: title
  };
}

// ─────────────────────────────────────────────────────────────
// M3U Playlist Generator (with duplicate removal)
// ─────────────────────────────────────────────────────────────

function generateM3U(sources) {
  const unique = [];
  const seen = new Set();

  for (const s of sources) {
    if (!seen.has(s.stream_url)) {
      seen.add(s.stream_url);
      unique.push(s);
    }
  }

  let m3u = "#EXTM3U\n";
  m3u += `# Updated: ${new Date().toISOString()}\n`;
  m3u += `# Sources: ${unique.length} live streams\n\n`;

  for (const s of unique) {
    const title = s.resolvedTitle || s.name;
    const logo = s.logo_url || "";
    const group = s.group_name || "Cricket";

    m3u += `#EXTINF:-1 tvg-id="${s.id}" tvg-name="${s.name}" tvg-logo="${logo}" group-title="${group}",${title}\n`;
    m3u += `${s.stream_url}\n\n`;
  }

  return m3u;
}

// ─────────────────────────────────────────────────────────────
// Main Execution Pipeline
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
        resolvedTitle: iccTv.name
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
      group_name: s.group_name
    }))
  };

  const summaryPath = resolve(__dirname, "playlist-status.json");
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf-8");
  console.log(`Status summary written to: ${summaryPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
