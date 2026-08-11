import { createClient } from "@supabase/supabase-js";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";


const __dirname = dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_ANON_KEY env vars.");
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);


// ─── YouTube helpers ──────────────────────────────────────────────

/**
 * Fetch a URL and return the response text, or null on failure.
 */
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

/**
 * Given a YouTube channel handle URL (https://www.youtube.com/@handle),
 * resolve the channel ID and check whether the channel is currently live.
 * Returns { isLive, videoId, title, streamUrl } or null.
 *
 * We use the public channel page HTML which contains a liveBadge indicator
 * and a /watch?v= link for any active live stream.
 */
function isCricketBroadcastTitle(title) {
  if (!title) return false;

  const gamingTerms = /\b(gameplay|gaming|video game|cricket 24|cricket 22|cricket 19|roblox|minecraft|fortnite|efootball|football manager|pes|fifa)\b/i;
  const cricketTerms = /\b(cricket|t20|odi|test match|wicket|batter|bowler|innings)\b/i;

  return cricketTerms.test(title) && !gamingTerms.test(title);
}

async function checkYouTubeChannel(channelUrl) {
  // Try /live shortcut — YouTube redirects to the active live stream if one exists.
  const liveShortcut = channelUrl.replace(/\/$/, "") + "/live";
  const result = await fetchText(liveShortcut, { timeoutMs: 20000 });

  if (!result.ok) {
    // Fall back to the channel page itself
    const pageResult = await fetchText(channelUrl, { timeoutMs: 20000 });
    if (!pageResult.ok) return null;
    return parseYouTubePage(pageResult.text, channelUrl);
  }

  // If we got redirected to a watch URL, extract the video ID
  const watchMatch = result.text.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
  const titleMatch =
    result.text.match(/"title":"([^"]+)"/) ||
    result.text.match(/<title>([^<]+)<\/title>/);

  // Check for live indicator
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

  // Also try parsing the full channel page
  return parseYouTubePage(result.text, channelUrl);
}

/**
 * Parse a YouTube channel page HTML to find a live stream.
 */
function parseYouTubePage(html, channelUrl) {
  // Look for live stream entries in the rendered tabs
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

/**
 * Check an HLS stream URL — do a HEAD or GET request and verify it returns
 * something that looks like an M3U8 playlist.
 */
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

// ─── Health check + M3U generation ────────────────────────────────

/**
 * Check a single source and record the result in stream_checks.
 * Returns the updated source with stream_url filled in if live.
 */
async function checkSource(source) {
  let isLive = false;
  let streamUrl = null;
  let title = null;
  let error = null;
  let httpStatus = null;

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
  } else if (source.source_type === "hls") {
    const target = source.stream_url || source.source_url;
    const result = await checkHlsStream(target);
    isLive = result.isLive;
    if (isLive) streamUrl = target;
    else error = result.error;
  } else if (source.source_type === "icc_tv" || source.source_type === "web") {
    // For ICC.tv and web sources, we include them as a reference entry.
    // ICC.tv requires a browser session to resolve actual stream URLs,
    // so we include the page URL as a playable link.
    streamUrl = source.source_url;
    isLive = true; // Include as a reference; user opens the page to watch.
  }

  // Record health check
  const { error: insertError } = await supabase.from("stream_checks").insert({
    source_id: source.id,
    status: isLive ? "ok" : "fail",
    error: error || null,
  });

  if (insertError) {
    console.error(`  Failed to record check for ${source.name}:`, insertError.message);
  }

  // Update source stream_url if we found a live stream
  if (isLive && streamUrl && streamUrl !== source.stream_url) {
    const { error: updateError } = await supabase
      .from("sources")
      .update({ stream_url: streamUrl })
      .eq("id", source.id);
    if (updateError) {
      console.error(`  Failed to update stream_url for ${source.name}:`, updateError.message);
    }
  }

  return {
    ...source,
    isLive,
    stream_url: isLive ? streamUrl : null,
    resolvedTitle: title,
  };
}

/**
 * Generate the M3U playlist content from a list of live sources.
 */
function generateM3U(sources) {
  let m3u = "#EXTM3U\n";
  m3u += `# Updated: ${new Date().toISOString()}\n`;
  m3u += `# Sources: ${sources.length} live streams\n`;
  m3u += `# This playlist contains only official, free-to-air cricket streams.\n`;
  m3u += `# Auto-generated daily. Dead links are automatically excluded.\n\n`;

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

/**
 * Main: fetch all active sources, check each one, generate M3U, write to disk.
 */
async function main() {
  const args = process.argv.slice(2);
  const isUpdate = args.includes("--update") || args.includes("--build") || args.length === 0;

  console.log("=== Cricket M3U Playlist Generator ===");
  console.log(`Mode: ${isUpdate ? "update (check all sources)" : "unknown — defaulting to update"}`);
  console.log();

  // Fetch all active sources
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
    console.log("No live streams found. Writing a minimal playlist with ICC.tv reference.");
    // Always include ICC.tv as a reference entry even if nothing is live
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

  // Generate M3U
  const m3uContent = generateM3U(liveSources);
  const outputPath = resolve(__dirname, "playlist.m3u");
  writeFileSync(outputPath, m3uContent, "utf-8");
  console.log(`\nPlaylist written to: ${outputPath}`);
  console.log(`File size: ${(m3uContent.length / 1024).toFixed(1)} KB`);

  // Also write a JSON summary for debugging
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
