import puppeteer from "puppeteer";

const SITES = [
  "https://touchcric.is",
  "https://smartcric.is",
  "https://freehit.eu/free/",
  "https://crichd.mobile",
  "https://cricstream.me",
  "https://webcric.com",
  "https://crictime.com"
];

const MOBILE_EMULATION = {
  viewport: {
    width: 390,
    height: 844,
    isMobile: true,
    hasTouch: true
  },
  userAgent:
    "Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36"
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export async function runPuppeteerScraper() {
  const browser = await puppeteer.launch({
    // Use standard headless to evade basic detection
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--disable-blink-features=AutomationControlled" // Evade basic bot detection
    ]
  });

  const page = await browser.newPage();
  
  // Evasion scripts
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  
  await page.setUserAgent(MOBILE_EMULATION.userAgent);
  await page.setViewport(MOBILE_EMULATION.viewport);

  const discovered = [];

  for (const site of SITES) {
    console.log(`\n=== Puppeteer scraping: ${site} ===`);
    
    // We will use a Map to capture streams and their associated match names
    const siteStreams = new Map();
    let currentMatchName = "Auto Stream";
    
    // Set up the request listener for this site
    const requestHandler = async (request) => {
      try {
        const url = request.url();
        if (url.includes(".m3u8") || url.includes("playlist")) {
          console.log("INTERCEPTED REQUEST:", url);
          siteStreams.set(url, currentMatchName);
        }
      } catch (_) {}
    };
    
    page.on("request", requestHandler);

    try {
      // HOP 1 — Load homepage
      await page.goto(site, { waitUntil: "networkidle2", timeout: 30000 });
      await sleep(5000); 

      // Extract match links or buttons
      const matches = await page.evaluate(() => {
        const items = [];
        // Look for typical match links
        document.querySelectorAll("a").forEach(a => {
          const text = a.innerText.trim();
          const href = a.href.toLowerCase();
          
          // Exclude unwanted links
          if (!text || text.length < 3 || href.includes("telegram") || href.includes("betting") || href.includes("casino") || href.includes("app")) return;
          
          // Check if it looks like a match link
          if (
            href.includes("/live") || 
            href.includes("/watch") || 
            href.includes("match") ||
            href.includes("stream") ||
            href.includes(".php?id=") ||
            href.includes("cricfree.live/live") ||
            href.includes("crichd.tv/watch") ||
            text.toLowerCase().includes("vs") ||
            text.toLowerCase().includes("v/s") ||
            text.toLowerCase().includes("league") ||
            text.toLowerCase().includes("t20")
          ) {
            items.push({ text, href: a.href, type: 'link' });
          }
        });
        
        // Look for buttons with match names (Freehit style)
        document.querySelectorAll('button').forEach(b => {
          const t = b.innerText.trim();
          if (t && t.includes('Vs') || t.includes('League') || t.includes('Hundred')) {
            items.push({ text: t, href: null, type: 'button' });
          }
        });
        return items;
      });

      // Deduplicate matches by text/href
      const uniqueMatches = [];
      const seen = new Set();
      for (const m of matches) {
        const key = m.href || m.text;
        if (!seen.has(key)) {
          seen.add(key);
          uniqueMatches.push(m);
        }
      }

      console.log(`Found ${uniqueMatches.length} match elements on ${site}`);

      // Loop through all matches
      for (const match of uniqueMatches) {
        try {
          console.log(`\nTrying match: ${match.text}`);
          currentMatchName = match.text;

          // Navigate to starting page
          await page.goto(site, { waitUntil: "networkidle2", timeout: 30000 });
          await sleep(3000);

          // Click match
          if (match.type === 'link' && match.href) {
            await page.goto(match.href, { waitUntil: "networkidle2", timeout: 30000 });
          } else {
            const clicked = await page.evaluate((text) => {
              const btns = Array.from(document.querySelectorAll("button"));
              const btn = btns.find(b => b.innerText.trim() === text);
              if (btn) {
                btn.click();
                return true;
              }
              return false;
            }, match.text);
            
            if (!clicked) {
              console.log(`Match button "${match.text}" not found, skipping.`);
              continue;
            }
          }

          // Wait for navigation and potential quality buttons to appear
          await sleep(5000);

          // HOP 2 — Source/Quality selection (if present)
          const availableButtons = await page.$$eval("button, a.btn, a.button", btns =>
            btns.map(b => b.innerText.trim()).filter(Boolean)
          );

          const keywords = ["High", "Medium", "Low", "Watch", "Play", "Source"];
          const buttonsToClick = availableButtons.filter(btnText => 
            keywords.some(k => btnText.toLowerCase().includes(k.toLowerCase()))
          );

          if (buttonsToClick.length > 0) {
            console.log(`Found source/quality buttons: ${buttonsToClick.join(', ')}`);
            for (const btnText of buttonsToClick) {
              try {
                console.log(`Clicking: ${btnText}`);
                await page.evaluate((text) => {
                  const elements = Array.from(document.querySelectorAll("button, a.btn, a.button"));
                  const el = elements.find(e => e.innerText.trim() === text);
                  if (el) el.click();
                }, btnText);
                // Wait for potential iframe load
                await sleep(4000);
              } catch (e) {
                console.log(`Navigation occurred or element lost while clicking ${btnText}`);
                break; // If page navigated away, stop clicking other buttons
              }
            }
          } else {
            console.log("No source/quality buttons found. Assuming direct to stream page.");
          }

          // Trigger playback to generate network requests
          const allFrames = page.frames();
          for (const frame of allFrames) {
            try {
              await frame.evaluate(() => {
                if (window.jQuery) {
                  window.jQuery('video').trigger('play');
                  window.jQuery('video').trigger('touchstart');
                }
                const v = document.querySelector('video');
                if (v) {
                  v.dispatchEvent(new Event('play'));
                  v.dispatchEvent(new Event('touchstart'));
                  v.play().catch(()=>{});
                }
              });
            } catch (err) {}
          }
          
          // Wait 4 seconds to allow the player to update `ea` and fetch the real stream
          await sleep(4000);

          for (const frame of allFrames) {
            try {
              // Look for video tags
              const videoSrc = await frame.$eval("video", v => v.src).catch(() => null);
              if (videoSrc && videoSrc.includes(".m3u8")) {
                siteStreams.set(videoSrc, currentMatchName);
              }

              // Look for script-based players
              const html = await frame.content().catch(() => "");
              const m3u8Matches = html.match(/https?:\/\/[^"']+\.m3u8/gi);
              if (m3u8Matches) {
                m3u8Matches.forEach(url => siteStreams.set(url, currentMatchName));
              }
            } catch (_) {}
          }
          
        } catch (err) {
          console.log(`Match failed: ${match.text}`, err.message);
        }
      }
    } catch (err) {
      console.log(`Site failed: ${err.message}`);
    } finally {
      // Remove the response listener
      page.off("request", requestHandler);
    }
    
    // Add collected streams to discovered array
    for (let [m3u8, mName] of siteStreams.entries()) {
      if (m3u8.includes("unknown")) {
        m3u8 = m3u8.replace("unknown", "1freecdn.xyz");
      }
      
      const host = new URL(site).hostname.replace("www.", "");
      
      discovered.push({
        name: host,
        type: "hls",
        url: m3u8,
        discovered_from: site
      });
    }
    console.log(`=> Discovered ${siteStreams.size} streams from ${site}`);
  }

  await browser.close();
  return discovered;
}
