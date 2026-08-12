import puppeteer from "puppeteer";

const SITES = [
  "https://touchcric.is",
  "https://smartcric.is",
  "https://freehit.eu/free/", // Note the trailing slash! Important to avoid redirect to blog.
  "https://crichd.tv",
  "https://cricfree.live",
  "https://mylivecricket.in"
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
    
    // We will use a Set to capture streams for the current site to avoid duplicates
    const siteStreams = new Set();
    
    // Set up the request listener for this site
    const requestHandler = async (request) => {
      try {
        const url = request.url();
        if (url.includes(".m3u8") || url.includes("playlist")) {
          console.log("INTERCEPTED REQUEST:", url);
          siteStreams.add(url);
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
        // Look for typical match links (Touchcric style)
        document.querySelectorAll('a').forEach(a => {
          if (a.href.includes('/live/') || a.href.includes('/stream/') || a.href.includes('/watch/')) {
            items.push({ text: a.innerText.trim(), href: a.href, type: 'link' });
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

          // HOP 2 — Quality selection (if present)
          const qualityButtons = await page.$$eval("button", btns =>
            btns.map(b => b.innerText.trim()).filter(Boolean)
          );

          const preferred = ["High", "Medium", "Low"];
          let qualityToClick = preferred.find(q => qualityButtons.includes(q));

          if (qualityToClick) {
            console.log(`Found quality buttons. Selecting quality: ${qualityToClick}`);
            await page.evaluate((text) => {
              const btns = Array.from(document.querySelectorAll("button"));
              const btn = btns.find(b => b.innerText.trim() === text);
              if (btn) btn.click();
            }, qualityToClick);
            
            // Wait for video page after quality selection
            await sleep(5000);
          } else {
            console.log("No quality buttons found. Assuming direct to stream page.");
          }

          // HOP 3 — Video page
          // Inject script to steal the URL
          const allFrames = page.frames();
          for (const frame of allFrames) {
            try {
              const interceptedUrl = await frame.evaluate(() => {
                return new Promise((resolve) => {
                  // Check if it's already in the source tag
                  const source = document.querySelector('source');
                  if (source && source.src && source.src.includes('.m3u8')) {
                    return resolve(source.src);
                  }
                  
                  // If Hls exists, override loadSource
                  if (window.Hls && window.Hls.prototype) {
                    const originalLoadSource = window.Hls.prototype.loadSource;
                    window.Hls.prototype.loadSource = function(url) {
                      resolve(url); // We got it!
                      return originalLoadSource.apply(this, arguments);
                    };
                    
                    // Also try to trigger play just in case it's waiting for it
                    if (window.jQuery) {
                      window.jQuery('video').trigger('play');
                    } else {
                      const v = document.querySelector('video');
                      if (v) {
                        v.dispatchEvent(new Event('play'));
                        v.play().catch(()=>{});
                      }
                    }
                  } else {
                    // Try to find it in the HTML as fallback
                    const html = document.body.innerHTML;
                    const matches = html.match(/https?:\/\/[^"']+\.m3u8[^"']*/i);
                    if (matches) resolve(matches[0]);
                    else resolve(null);
                  }
                  
                  // Timeout after 5 seconds
                  setTimeout(() => resolve(null), 5000);
                });
              });
              
              if (interceptedUrl) {
                console.log("Intercepted m3u8 directly from JS!", interceptedUrl);
                siteStreams.add(interceptedUrl);
              }
            } catch (err) {
              // Ignore cross-origin errors if web security is enabled
            }
          }

          for (const frame of allFrames) {
            try {
              // Look for video tags
              const videoSrc = await frame.$eval("video", v => v.src).catch(() => null);
              if (videoSrc && videoSrc.includes(".m3u8")) {
                siteStreams.add(videoSrc);
              }

              // Look for script-based players
              const html = await frame.content().catch(() => "");
              const m3u8Matches = html.match(/https?:\/\/[^"']+\.m3u8/gi);
              if (m3u8Matches) {
                m3u8Matches.forEach(url => siteStreams.add(url));
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
    for (let m3u8 of siteStreams) {
      if (m3u8.includes("unknown")) {
        m3u8 = m3u8.replace("unknown", "1freecdn.xyz");
      }
      discovered.push({
        name: "Auto Stream",
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
