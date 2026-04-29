#!/usr/bin/env node
"use strict";

const fetch   = require("node-fetch");
const fs      = require("fs-extra");
const path    = require("path");
const cheerio = require("cheerio");
const pLimit  = require("p-limit");
const { URL } = require("url");

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
  // Remove all scripts but keep <noscript> for accessibility
  $("script").remove();
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

async function generateHomepage(navItems) {
  console.log("  Fetching live homepage...");
  const res = await fetch(BASE_URL, { timeout: 20000 });
  if (!res.ok) throw new Error(`Homepage: HTTP ${res.status}`);

  const $ = cheerio.load(await res.text());
  stripNoise($);

  // Collect and remove <style> blocks — we'll re-inline them
  const styles = [];
  $("style").each((_, el) => { styles.push($(el).html()); $(el).remove(); });
  siteStyles = styles.join("\n");

  // Collect and download linked stylesheets, relink to local paths
  const cssJobs = [];
  $('link[rel="stylesheet"][href]').each((_, el) => {
    cssJobs.push(limit(async () => {
      const href = $(el).attr("href");
      try {
        const abs = new URL(href, BASE_URL).href;
        if (isInternal(abs)) {
          const local = await downloadAsset(abs);
          // Also process @import / url() inside downloaded CSS
          const cssPath = path.join(ASSETS_DIR, new URL(abs).pathname);
          if (await fs.pathExists(cssPath)) {
            const raw       = await fs.readFile(cssPath, "utf8");
            const processed = await processCSSText(raw, abs);
            if (processed !== raw) await fs.writeFile(cssPath, processed);
          }
          $(el).attr("href", local);
        }
      } catch {}
    }));
  });
  await Promise.all(cssJobs);

  await localizeAssets($, BASE_URL);
  fixLinks($, BASE_URL);

  const title = $("title").text() || "Abano";
  $("title").remove(); // avoid duplicate; shell adds its own

  const out = `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="canonical" href="${BASE_URL}/">
  ${$("head").html() || ""}
  <style>${siteStyles}</style>
</head>
<body>
${$("body").html() || ""}
</body>
</html>`;

  await fs.writeFile(path.join(OUTPUT_DIR, "index.html"), out);
  console.log("  ✓ index.html");
}

// ─── HTML page crawling ───────────────────────────────────────────────────────

// Fetch one live page, strip noise, localize assets, write index.html
async function crawlPage(pagePath, navItems) {
  const liveURL = `${BASE_URL}${pagePath}`;
  const res = await fetch(liveURL, { timeout: 20000 });
  if (!res.ok) {
    console.warn(`  ⚠ ${liveURL} — HTTP ${res.status}, skipping`);
    return [];
  }

  const $ = cheerio.load(await res.text());
  stripNoise($);

  // Collect outbound internal links before we rewrite them
  const discovered = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    try {
      const abs = new URL(href, liveURL);
      if (abs.hostname.endsWith("abano.be")) {
        const p = abs.pathname.endsWith("/") ? abs.pathname : abs.pathname + "/";
        if (!CRAWL_SKIP.test(p)) discovered.push(p);
      }
    } catch {}
  });

  // Download linked stylesheets
  const cssJobs = [];
  $('link[rel="stylesheet"][href]').each((_, el) => {
    cssJobs.push(limit(async () => {
      const href = $(el).attr("href");
      try {
        const abs = new URL(href, liveURL).href;
        if (isInternal(abs)) $(el).attr("href", await downloadAsset(abs));
      } catch {}
    }));
  });
  await Promise.all(cssJobs);

  await localizeAssets($, liveURL);
  fixLinks($, liveURL);
  $("style").remove(); // re-inlined below via siteStyles

  const title = $("title").text() || pagePath;
  $("title").remove();

  const out = `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="canonical" href="${BASE_URL}${pagePath}">
  ${$("head").html() || ""}
  <style>${siteStyles}</style>
</head>
<body>
${$("body").html() || ""}
</body>
</html>`;

  const outDir = path.join(OUTPUT_DIR, ...pagePath.split("/").filter(Boolean));
  await fs.ensureDir(outDir);
  await fs.writeFile(path.join(outDir, "index.html"), out);

  return discovered;
}

// Spider all internal links starting from seed paths, skipping anything
// already exported by the WP REST API or already visited.
async function crawlMissingPages(knownPaths, navItems) {
  const visited = new Set(knownPaths);
  const queue   = ["/"];   // start from homepage, which will surface all nav links
  let   count   = 0;

  while (queue.length) {
    const pagePath = queue.shift();
    if (visited.has(pagePath)) continue;
    visited.add(pagePath);

    process.stdout.write(`  crawling ${pagePath} ...`);
    const discovered = await crawlPage(pagePath, navItems);
    count++;
    console.log(" ✓");

    for (const p of discovered) {
      if (!visited.has(p) && !queue.includes(p)) queue.push(p);
    }
  }

  return { visited, count };
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

  // Clean generated output but leave project source files (scripts/, package.json, etc.)
  const KEEP = new Set(["scripts", "node_modules", "package.json", "package-lock.json", ".git", ".gitignore"]);
  for (const entry of await fs.readdir(OUTPUT_DIR)) {
    if (!KEEP.has(entry)) await fs.remove(path.join(OUTPUT_DIR, entry));
  }
  await fs.ensureDir(ASSETS_DIR);

  // ── Navigation
  console.log("[1/7] Navigation...");
  const navItems = await fetchNavItems();

  // ── Homepage (also populates siteStyles used by every other page)
  console.log("[2/7] Homepage...");
  await generateHomepage(navItems);

  // ── WP content
  console.log("[3/7] Fetching posts...");
  const posts = await fetchAll("posts", { _embed: 1, orderby: "date", order: "desc" });
  console.log(`  ✓ ${posts.length} posts`);

  console.log("[4/7] Fetching pages...");
  const pages = await fetchAll("pages", { _embed: 1 });
  console.log(`  ✓ ${pages.length} pages`);

  // ── Render posts (concurrent, rate-limited)
  console.log("[5/7] Rendering posts...");
  await Promise.all(posts.map(post => limit(() => renderPost(post, "posts", navItems))));
  console.log(`  ✓ ${posts.length} posts rendered`);

  // ── Render pages
  console.log("[6/7] Rendering pages...");
  const skipSlugs = new Set(["home"]);
  for (const page of pages) {
    if (skipSlugs.has(page.slug) || page.link === `${BASE_URL}/`) continue;
    await renderPost(page, "pages", navItems);
  }
  const rendered = pages.filter(p => !skipSlugs.has(p.slug) && p.link !== `${BASE_URL}/`).length;
  console.log(`  ✓ ${rendered} pages rendered`);

  // ── Spider: find and export any pages not covered by the WP REST API
  console.log("[7/8] Spidering for missing pages...");
  const knownPaths = [
    "/",
    "/news/",
    ...posts.map(p => `/news/${p.slug}/`),
    ...pages.map(p => `/${p.slug}/`),
  ];
  const { count: crawled } = await crawlMissingPages(knownPaths, navItems);
  console.log(`  ✓ ${crawled} additional page(s) crawled`);

  // ── Blog index
  console.log("[8/8] Blog index, sitemap, static files...");
  await generateBlogIndex(posts, navItems);
  await generateSitemap(posts, pages);
  await writeStaticFiles(navItems);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsed}s — ${assetCache.size} assets → ./dist`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
