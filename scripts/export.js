#!/usr/bin/env node
"use strict";

const fetch      = require("node-fetch");
const fs         = require("fs-extra");
const path       = require("path");
const cheerio    = require("cheerio");
const pLimit     = require("p-limit");
const puppeteer  = require("puppeteer");
const { URL }    = require("url");

let browser; // shared Puppeteer instance

// ─── Config ───────────────────────────────────────────────────────────────────

const BASE_URL      = "https://www.abano.be";
const API_BASE      = `${BASE_URL}/wp-json/wp/v2`;
const LEGACY_PREFIX = "/Abano-Website";   // old GitHub Pages path prefix
const OUTPUT_DIR    = path.resolve(".");
const ASSETS_DIR    = path.join(OUTPUT_DIR, "assets");
const PER_PAGE      = 10;
const CONCURRENCY   = 6;

// Paths to skip during auto-discovery (feed, admin, API, asset URLs, etc.)
const CRAWL_SKIP = /^\/(wp-|feed|xmlrpc|sitemap|robots|_|assets|news\/page)/;

const limit      = pLimit(CONCURRENCY);
const assetCache = new Map(); // original URL → root-relative local path
let   siteStyles = "";        // critical CSS collected from live homepage

// ─── Asset downloading ────────────────────────────────────────────────────────

function isInternal(url) {
  try { return new URL(url).hostname.endsWith("abano.be"); }
  catch { return false; }
}

async function downloadAsset(rawUrl) {
  let abs;
  try { abs = new URL(rawUrl, BASE_URL).href; } catch { return rawUrl; }
  if (!isInternal(abs)) return rawUrl;
  if (assetCache.has(abs)) return assetCache.get(abs);

  // Reserve slot immediately so parallel calls don't double-download
  const parsed   = new URL(abs);
  const localRel = `/assets${parsed.pathname}`;
  assetCache.set(abs, localRel);

  try {
    const localAbs = path.join(ASSETS_DIR, parsed.pathname);
    await fs.ensureDir(path.dirname(localAbs));

    if (!await fs.pathExists(localAbs)) {
      const res = await fetch(abs, { timeout: 20000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fs.writeFile(localAbs, await res.buffer());
    }
  } catch (err) {
    console.warn(`  ⚠ Asset failed: ${abs} — ${err.message}`);
    assetCache.set(abs, abs); // fall back to original URL
    return abs;
  }

  return localRel;
}

// Rewrite url() references inside a CSS string and download them concurrently
async function processCSSText(css, baseUrl) {
  const URL_RE = /url\((['"]?)([^'")\s]+)\1\)/g;
  const jobs   = [];

  for (const m of css.matchAll(URL_RE)) {
    if (m[2].startsWith("data:")) continue;
    jobs.push({ original: m[0], quote: m[1], src: m[2] });
  }

  await Promise.all(jobs.map(job => limit(async () => {
    const local = await downloadAsset(new URL(job.src, baseUrl).href);
    css = css.replaceAll(job.original, `url(${job.quote}${local}${job.quote})`);
  })));

  return css;
}

// ─── Cheerio DOM helpers ──────────────────────────────────────────────────────

async function localizeAssets($, docUrl) {
  const tasks = [];

  // <img src>  — strip srcset/sizes to avoid broken variant references
  $("img[src]").each((_, el) => {
    tasks.push(limit(async () => {
      const local = await downloadAsset(new URL($(el).attr("src"), docUrl).href);
      $(el).attr("src", local).removeAttr("srcset").removeAttr("sizes");
    }));
  });

  // <link rel="stylesheet"> — download and relink internal sheets
  $('link[rel="stylesheet"][href]').each((_, el) => {
    tasks.push(limit(async () => {
      const href = $(el).attr("href");
      try {
        const abs = new URL(href, docUrl).href;
        if (isInternal(abs)) $(el).attr("href", await downloadAsset(abs));
      } catch {}
    }));
  });

  // inline style="" url() references
  $("[style]").each((_, el) => {
    tasks.push(limit(async () => {
      const processed = await processCSSText($(el).attr("style"), docUrl);
      $(el).attr("style", processed);
    }));
  });

  await Promise.all(tasks);
}

function fixLinks($, docUrl) {
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || /^(#|mailto:|tel:|javascript:)/.test(href)) return;
    try {
      const abs = new URL(href, docUrl);
      if (abs.hostname.endsWith("abano.be")) {
        let rel = abs.pathname + abs.search + abs.hash;
        if (rel.startsWith(LEGACY_PREFIX)) rel = rel.slice(LEGACY_PREFIX.length);
        $(el).attr("href", rel || "/");
      }
    } catch {}
  });
}

function stripNoise($) {
  const SELECTORS = [
    "#wpadminbar",
    ".cookie-banner", ".cookie-notice", "#cookie-notice",
    ".cc-window", ".cc-revoke",
    "#query-monitor",
    'link[rel="https://api.w.org/"]',
    'link[rel="wlwmanifest"]',
    'link[rel="EditURI"]',
    'link[rel="shortlink"]',
    'meta[name="generator"]',
  ];
  $(SELECTORS.join(", ")).remove();

  // Remove only external tracking/analytics scripts.
  // Keep inline scripts (Divi page config, icon data) so icon fonts render correctly.
  $("script[src]").each((_, el) => {
    const src = $(el).attr("src") || "";
    const isTracking = /google(tag|analytics|syndication)|facebook|hotjar|gtm\.|clarity|linkedin/i.test(src);
    const isWPAdmin  = /wp-emoji|wp-embed|admin-bar/i.test(src);
    if (isTracking || isWPAdmin) $(el).remove();
  });
}

// ─── Navigation ───────────────────────────────────────────────────────────────

async function fetchNavItems() {
  // 1. WP Menus REST API (requires WP REST API Menus plugin on the server)
  try {
    const r = await fetch(`${BASE_URL}/wp-json/menus/v1/menus`, { timeout: 8000 });
    if (r.ok) {
      const menus = await r.json();
      if (Array.isArray(menus) && menus.length) {
        const menu = menus.find(m => /primary|main|header|hoofd/i.test(m.slug)) || menus[0];
        const ir   = await fetch(`${BASE_URL}/wp-json/menus/v1/menus/${menu.id}`);
        if (ir.ok) {
          const data  = await ir.json();
          const items = (data.items || []).map(i => ({
            label: i.title,
            href:  new URL(i.url, BASE_URL).pathname,
          }));
          if (items.length) {
            console.log(`  ✓ Nav via WP Menus API (${items.length} items)`);
            return items;
          }
        }
      }
    }
  } catch {}

  // 2. Scrape <nav>/<header> links from the live homepage
  try {
    const r = await fetch(BASE_URL, { timeout: 12000 });
    if (r.ok) {
      const $     = cheerio.load(await r.text());
      const seen  = new Set();
      const items = [];
      $("nav a, header a").each((_, el) => {
        const label = $(el).text().trim();
        const href  = $(el).attr("href");
        if (!label || !href || href.startsWith("#")) return;
        try {
          const abs = new URL(href, BASE_URL);
          if (abs.hostname.endsWith("abano.be") && !seen.has(abs.pathname)) {
            seen.add(abs.pathname);
            items.push({ label, href: abs.pathname });
          }
        } catch {}
      });
      if (items.length) {
        console.log(`  ✓ Nav scraped from homepage (${items.length} items)`);
        return items;
      }
    }
  } catch {}

  // 3. Hardcoded fallback
  console.warn("  ⚠ Nav fallback: using hardcoded items");
  return [
    { label: "Home",      href: "/"           },
    { label: "Over ons",  href: "/over-ons/"  },
    { label: "Diensten",  href: "/diensten/"  },
    { label: "Nieuws",    href: "/news/"      },
    { label: "Contact",   href: "/contact/"   },
  ];
}

function buildNavHTML(navItems) {
  const lis = navItems
    .map(({ label, href }) => `      <li><a href="${href}">${label}</a></li>`)
    .join("\n");
  return `  <nav aria-label="Hoofdnavigatie">\n    <ul>\n${lis}\n    </ul>\n  </nav>`;
}

// ─── Page shell ───────────────────────────────────────────────────────────────

function buildPage({ title, head = "", bodyContent, navHTML, canonical = "" }) {
  const canonTag = canonical
    ? `\n  <link rel="canonical" href="${BASE_URL}${canonical}">` : "";
  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>${canonTag}${head}
  <style>${siteStyles}</style>
</head>
<body>
${navHTML}
  <main>
${bodyContent}
  </main>
  <footer>
    <p>&copy; ${new Date().getFullYear()} Abano</p>
  </footer>
</body>
</html>`;
}

// ─── Homepage ─────────────────────────────────────────────────────────────────

async function generateHomepage() {
  console.log("  Rendering live homepage with browser...");
  const page = await browser.newPage();

  await page.setRequestInterception(true);
  page.on("request", req => {
    const url = req.url();
    if (["image", "stylesheet", "font", "media"].includes(req.resourceType()) && isInternal(url))
      assetCache.has(url) || assetCache.set(url, null); // mark for download
    if (/google(tag|analytics)|facebook|hotjar|gtm\.|clarity|linkedin/i.test(url))
      req.abort();
    else
      req.continue();
  });

  await page.goto(BASE_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise(r => setTimeout(r, 800));

  await page.evaluate(() => {
    ["#wpadminbar", ".cookie-notice", "#cookie-notice", ".cc-window"].forEach(
      sel => document.querySelectorAll(sel).forEach(el => el.remove())
    );
    document.querySelectorAll("script[src]").forEach(s => {
      if (/google(tag|analytics)|facebook|hotjar|gtm\.|clarity|linkedin/i.test(s.src)) s.remove();
    });
  });

  const html = await page.content();
  await page.close();

  // Download all assets the homepage loaded
  const $ = cheerio.load(html);
  await localizeAssets($, BASE_URL);
  fixLinks($, BASE_URL);

  $("img[src], source[src]").each((_, el) => {
    const src   = $(el).attr("src");
    const local = src ? assetCache.get(new URL(src, BASE_URL).href) : null;
    if (local) $(el).attr("src", local).removeAttr("srcset").removeAttr("sizes");
  });
  $('link[rel="stylesheet"][href]').each((_, el) => {
    const href  = $(el).attr("href");
    const local = href ? assetCache.get(new URL(href, BASE_URL).href) : null;
    if (local) $(el).attr("href", local);
  });

  await fs.writeFile(path.join(OUTPUT_DIR, "index.html"), $.html());
  console.log("  ✓ index.html");
}

// ─── HTML page crawling (Puppeteer) ──────────────────────────────────────────

// Use a real browser to render each page so Divi JS runs fully.
// Intercepts every asset request and saves internal ones to disk.
// Writes index.html only when shouldWrite=true; always returns discovered links.
async function crawlPage(pagePath, navItems, shouldWrite = true) {
  const liveURL = `${BASE_URL}${pagePath}`;
  const page    = await browser.newPage();

  // Track assets requested by the page so we can download them
  const assetRequests = new Set();

  await page.setRequestInterception(true);
  page.on("request", req => {
    const url      = req.url();
    const type     = req.resourceType();
    const isAsset  = ["image", "stylesheet", "font", "media"].includes(type);

    if (isAsset && isInternal(url)) assetRequests.add(url);

    // Block tracking scripts to speed up rendering
    if (/google(tag|analytics)|facebook|hotjar|gtm\.|clarity|linkedin/i.test(url)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  let status = 200;
  try {
    const res = await page.goto(liveURL, { waitUntil: "networkidle2", timeout: 30000 });
    status = res?.status() ?? 200;
  } catch (err) {
    console.warn(`  ⚠ ${liveURL} — ${err.message}, skipping`);
    await page.close();
    return [];
  }

  if (status >= 400) {
    console.warn(`  ⚠ ${liveURL} — HTTP ${status}, skipping`);
    await page.close();
    return [];
  }

  // Wait for Divi animations / lazy content to settle
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise(r => setTimeout(r, 800));

  // Collect internal links for the crawler queue
  const discovered = await page.evaluate((base, skip) => {
    const skipRe = new RegExp(skip);
    return [...document.querySelectorAll("a[href]")]
      .map(a => {
        try {
          const u = new URL(a.href);
          if (!u.hostname.endsWith("abano.be")) return null;
          const p = u.pathname.endsWith("/") ? u.pathname : u.pathname + "/";
          return skipRe.test(p) ? null : p;
        } catch { return null; }
      })
      .filter(Boolean);
  }, BASE_URL, CRAWL_SKIP.source);

  // Strip noise from the live DOM before snapshotting
  await page.evaluate(() => {
    const remove = [
      "#wpadminbar", ".cookie-notice", "#cookie-notice",
      ".cc-window", ".cc-revoke", "#query-monitor",
    ];
    remove.forEach(sel => document.querySelectorAll(sel).forEach(el => el.remove()));

    // Remove tracking scripts only
    document.querySelectorAll("script[src]").forEach(s => {
      if (/google(tag|analytics)|facebook|hotjar|gtm\.|clarity|linkedin/i.test(s.src))
        s.remove();
    });
  });

  // Get the fully-rendered HTML
  const html = await page.content();
  await page.close();

  // Download all intercepted assets concurrently
  await Promise.all([...assetRequests].map(u => limit(() => downloadAsset(u))));

  // Post-process with cheerio: rewrite asset URLs to local paths
  const $ = cheerio.load(html);
  fixLinks($, liveURL);

  // Rewrite src/href of downloaded assets to local paths
  $("img[src], source[src]").each((_, el) => {
    const src  = $(el).attr("src");
    const local = src ? assetCache.get(new URL(src, liveURL).href) : null;
    if (local) $(el).attr("src", local).removeAttr("srcset").removeAttr("sizes");
  });

  $('link[rel="stylesheet"][href]').each((_, el) => {
    const href  = $(el).attr("href");
    const local = href ? assetCache.get(new URL(href, liveURL).href) : null;
    if (local) $(el).attr("href", local);
  });

  const out = $.html();

  if (shouldWrite) {
    const outDir = path.join(OUTPUT_DIR, ...pagePath.split("/").filter(Boolean));
    await fs.ensureDir(outDir);
    await fs.writeFile(path.join(outDir, "index.html"), out);
  }

  return [...new Set(discovered)];
}

// ─── WordPress sitemap reader ─────────────────────────────────────────────────

// Parse all <loc> values from a sitemap XML string.
// Handles both plain <loc>https://…</loc> and CDATA-wrapped <loc><![CDATA[https://…]]></loc>
function parseLocsFromXML(xml) {
  return [...xml.matchAll(/<loc>(?:<!\[CDATA\[)?\s*(https?:\/\/[^\]<\s]+)\s*(?:\]\]>)?<\/loc>/gi)]
    .map(m => m[1].trim())
    .filter(u => isInternal(u));
}

async function fetchWPSitemapURLs() {
  const candidates = [
    `${BASE_URL}/wp-sitemap.xml`,
    `${BASE_URL}/sitemap_index.xml`,
    `${BASE_URL}/sitemap.xml`,
  ];

  for (const url of candidates) {
    try {
      const res = await fetch(url, { timeout: 10000 });
      if (!res.ok) continue;
      const xml = await res.text();
      if (!xml.includes("<loc>")) continue;

      // Decide: sitemap index (contains child .xml refs) or regular sitemap
      const isSitemapIndex = xml.includes("<sitemapindex") || xml.includes("<sitemap>");

      let pageLocs = [];

      if (isSitemapIndex) {
        // Extract child sitemap URLs using the CDATA-aware parser
        const childUrls = parseLocsFromXML(xml).filter(u => u.endsWith(".xml"));

        for (const childUrl of childUrls) {
          // Skip attachment/tag/category sitemaps — only pages and posts matter
          if (/attachment|post_tag|category/i.test(childUrl)) continue;
          try {
            const cr = await fetch(childUrl, { timeout: 10000 });
            if (!cr.ok) continue;
            const childXml = await cr.text();
            // Only keep non-.xml locs (actual HTML pages)
            pageLocs = pageLocs.concat(
              parseLocsFromXML(childXml).filter(u => !u.endsWith(".xml"))
            );
          } catch {}
        }
      } else {
        pageLocs = parseLocsFromXML(xml).filter(u => !u.endsWith(".xml"));
      }

      const paths = [...new Set(
        pageLocs.map(u => { try { return new URL(u).pathname; } catch { return null; } })
               .filter(Boolean)
      )];

      if (paths.length) {
        console.log(`  ✓ Sitemap: ${paths.length} page URLs from ${url}`);
        return paths;
      }
    } catch {}
  }

  console.warn("  ⚠ No sitemap found — falling back to homepage link discovery only");
  return [];
}

// ─── Crawler ──────────────────────────────────────────────────────────────────

// Crawl all pages not yet written to disk.
// Seeds from the WP sitemap so JS-rendered nav links are never missed.
// Uses actual file existence — not an assumed list — to decide whether to write.
async function crawlMissingPages(navItems) {
  const sitemapPaths = await fetchWPSitemapURLs();

  const seedPaths = sitemapPaths.length ? [...sitemapPaths] : ["/"];
  if (!seedPaths.includes("/")) seedPaths.push("/");

  const visited = new Set();
  const queue   = [...seedPaths];
  let   count   = 0;

  while (queue.length) {
    const pagePath = queue.shift();
    if (visited.has(pagePath) || CRAWL_SKIP.test(pagePath)) continue;
    visited.add(pagePath);

    // Check disk — don't trust a pre-computed list
    const segments   = pagePath.split("/").filter(Boolean);
    const indexFile  = path.join(OUTPUT_DIR, ...segments, "index.html");
    const needsWrite = !await fs.pathExists(indexFile);

    process.stdout.write(`  ${needsWrite ? "+" : "~"} ${pagePath} ...`);

    const discovered = await crawlPage(pagePath, navItems, needsWrite);
    if (needsWrite) count++;
    console.log(" ✓");

    for (const p of discovered) {
      if (!visited.has(p) && !queue.includes(p)) queue.push(p);
    }
  }

  return { count };
}

// ─── WP REST API helpers ──────────────────────────────────────────────────────

async function fetchAll(endpoint, params = {}) {
  let page = 1;
  const results = [];
  const qs      = new URLSearchParams({ per_page: 100, ...params });

  while (true) {
    qs.set("page", page);
    const res = await fetch(`${API_BASE}/${endpoint}?${qs}`, { timeout: 20000 });
    if (!res.ok) break;
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) break;
    results.push(...data);
    const totalPages = parseInt(res.headers.get("X-WP-TotalPages") || "1", 10);
    if (page >= totalPages) break;
    page++;
  }
  return results;
}

// ─── Post / page renderer ─────────────────────────────────────────────────────

async function renderPost(post, type, navItems) {
  const slug      = post.slug || `id-${post.id}`;
  const rawHTML   = post.content?.rendered || "";
  const $         = cheerio.load(rawHTML);

  await localizeAssets($, BASE_URL);
  fixLinks($, BASE_URL);

  const canonical = type === "pages" ? `/${slug}/` : `/news/${slug}/`;
  const outDir    = type === "pages"
    ? path.join(OUTPUT_DIR, slug)
    : path.join(OUTPUT_DIR, "news", slug);

  await fs.ensureDir(outDir);
  await fs.writeFile(
    path.join(outDir, "index.html"),
    buildPage({
      title:       post.title?.rendered || slug,
      bodyContent: `  <article>\n    <h1>${post.title?.rendered || slug}</h1>\n    ${$.html()}\n  </article>`,
      navHTML:     buildNavHTML(navItems),
      canonical,
    }),
  );
}

// ─── Blog index with pagination ───────────────────────────────────────────────

function buildPagination(current, total, base) {
  if (total <= 1) return "";
  const prev = current > 1
    ? `<a href="${current === 2 ? `${base}/` : `${base}/page/${current - 1}/`}" rel="prev">&laquo; Vorige</a>` : "";
  const next = current < total
    ? `<a href="${base}/page/${current + 1}/" rel="next">Volgende &raquo;</a>` : "";

  const pages = Array.from({ length: total }, (_, i) => i + 1).map(i => {
    const href = i === 1 ? `${base}/` : `${base}/page/${i}/`;
    return i === current
      ? `<span class="current" aria-current="page">${i}</span>`
      : `<a href="${href}">${i}</a>`;
  });

  return `\n  <nav class="pagination" aria-label="Paginering">\n    ${[prev, ...pages, next].filter(Boolean).join(" ")}\n  </nav>`;
}

async function generateBlogIndex(posts, navItems) {
  const totalPages = Math.ceil(posts.length / PER_PAGE);

  for (let p = 1; p <= totalPages; p++) {
    const slice = posts.slice((p - 1) * PER_PAGE, p * PER_PAGE);

    const cards = await Promise.all(slice.map(async post => {
      const slug  = post.slug || `id-${post.id}`;
      const thumb = post._embedded?.["wp:featuredmedia"]?.[0]?.source_url;
      const img   = thumb
        ? `<img src="${await downloadAsset(thumb)}" alt="" loading="lazy">`
        : "";
      const date  = post.date ? new Date(post.date).toLocaleDateString("nl-BE") : "";
      return `    <article class="post-card">
      ${img}
      <div class="post-card-body">
        <time datetime="${post.date || ""}">${date}</time>
        <h2><a href="/news/${slug}/">${post.title?.rendered || slug}</a></h2>
        ${post.excerpt?.rendered || ""}
        <a href="/news/${slug}/" class="read-more">Lees meer &rarr;</a>
      </div>
    </article>`;
    }));

    const prevLink = p > 1
      ? `\n  <link rel="prev" href="${BASE_URL}${p === 2 ? "/news/" : `/news/page/${p - 1}/`}">` : "";
    const nextLink = p < totalPages
      ? `\n  <link rel="next" href="${BASE_URL}/news/page/${p + 1}/">` : "";

    const canonical = p === 1 ? "/news/" : `/news/page/${p}/`;
    const outDir    = p === 1
      ? path.join(OUTPUT_DIR, "news")
      : path.join(OUTPUT_DIR, "news", "page", String(p));

    await fs.ensureDir(outDir);
    await fs.writeFile(
      path.join(outDir, "index.html"),
      buildPage({
        title:       p === 1 ? "Nieuws" : `Nieuws — pagina ${p}`,
        head:        `${prevLink}${nextLink}`,
        bodyContent: `  <h1>Nieuws</h1>\n  <div class="posts-grid">\n${cards.join("\n")}\n  </div>${buildPagination(p, totalPages, "/news")}`,
        navHTML:     buildNavHTML(navItems),
        canonical,
      }),
    );
  }
  console.log(`  ✓ Blog index (${totalPages} page(s) of ${posts.length} posts)`);
}

// ─── Sitemap ──────────────────────────────────────────────────────────────────

async function generateSitemap(posts, pages) {
  const entries = [
    { loc: "/",       changefreq: "weekly",  priority: "1.0" },
    { loc: "/news/",  changefreq: "daily",   priority: "0.9" },
    ...posts.map(p => ({
      loc:        `/news/${p.slug}/`,
      lastmod:    p.modified?.split("T")[0],
      changefreq: "monthly",
      priority:   "0.7",
    })),
    ...pages.map(p => ({
      loc:        `/${p.slug}/`,
      lastmod:    p.modified?.split("T")[0],
      changefreq: "monthly",
      priority:   "0.6",
    })),
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.map(({ loc, lastmod, changefreq, priority }) =>
  `  <url>\n    <loc>${BASE_URL}${loc}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ""}
    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`
).join("\n")}
</urlset>`;

  await fs.writeFile(path.join(OUTPUT_DIR, "sitemap.xml"), xml);
  console.log("  ✓ sitemap.xml");
}

// ─── Static helper files ──────────────────────────────────────────────────────

async function writeStaticFiles(navItems) {
  // robots.txt
  await fs.writeFile(path.join(OUTPUT_DIR, "robots.txt"),
    `User-agent: *\nAllow: /\nSitemap: ${BASE_URL}/sitemap.xml\n`);

  // 404.html
  await fs.writeFile(
    path.join(OUTPUT_DIR, "404.html"),
    buildPage({
      title:       "Pagina niet gevonden — Abano",
      bodyContent: "  <h1>404 — Pagina niet gevonden</h1>\n  <p><a href=\"/\">Terug naar de homepage</a></p>",
      navHTML:     buildNavHTML(navItems),
    }),
  );

  // netlify.toml — production-ready Netlify config
  await fs.writeFile(
    path.join(process.cwd(), "netlify.toml"),
`[build]
  publish = "dist"

# ── Redirects ────────────────────────────────────────────────────────────────
[[redirects]]
  from   = "/blog/*"
  to     = "/news/:splat"
  status = 301

[[redirects]]
  from   = "/Abano-Website/*"
  to     = "/:splat"
  status = 301

[[redirects]]
  from   = "/news/page/1/"
  to     = "/news/"
  status = 301

[[redirects]]
  from   = "/*"
  to     = "/404.html"
  status = 404

# ── Cache headers ─────────────────────────────────────────────────────────────
[[headers]]
  for = "/assets/*"
  [headers.values]
    Cache-Control = "public, max-age=31536000, immutable"

[[headers]]
  for = "/*.html"
  [headers.values]
    Cache-Control        = "public, max-age=0, must-revalidate"
    X-Frame-Options      = "DENY"
    X-Content-Type-Options = "nosniff"
    Referrer-Policy      = "strict-origin-when-cross-origin"
`);

  // _redirects — same rules in Netlify plain format
  await fs.writeFile(
    path.join(OUTPUT_DIR, "_redirects"),
`/blog/*            /news/:splat  301
/Abano-Website/*   /:splat       301
/news/page/1/      /news/        301
/*                 /404.html     404
`);

  console.log("  ✓ robots.txt, 404.html, netlify.toml, _redirects");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  console.log("Abano static export\n");

  // Clean generated output, keep project source files
  const KEEP = new Set(["scripts", "node_modules", "package.json", "package-lock.json", ".git", ".gitignore"]);
  for (const entry of await fs.readdir(OUTPUT_DIR)) {
    if (!KEEP.has(entry)) await fs.remove(path.join(OUTPUT_DIR, entry));
  }
  await fs.ensureDir(ASSETS_DIR);

  // Launch browser once and reuse for all pages
  browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });

  try {
    // [1] Navigation
    console.log("[1/5] Navigation...");
    const navItems = await fetchNavItems();

    // [2] Homepage
    console.log("[2/5] Homepage...");
    await generateHomepage();

    // [3] Post metadata for blog index only
    console.log("[3/5] Fetching post metadata...");
    const posts = await fetchAll("posts", {
      _embed: 1,
      orderby: "date",
      order:   "desc",
      _fields: "id,slug,title,excerpt,date,modified,_links,_embedded",
    });
    console.log(`  ✓ ${posts.length} posts`);

    // [4] Blog index
    console.log("[4/5] Blog index...");
    await generateBlogIndex(posts, navItems);

    // [5] Crawl every URL — browser executes Divi JS so layout is pixel-perfect
    console.log("[5/5] Crawling all pages from sitemap...");
    const { count } = await crawlMissingPages(navItems);
    console.log(`  ✓ ${count} page(s) written`);

  } finally {
    await browser.close();
  }

  // Sitemap + static files
  const pages = await fetchAll("pages", { _fields: "slug,modified" });
  await generateSitemap(posts, pages);
  await writeStaticFiles(navItems);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s — ${assetCache.size} assets downloaded`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
