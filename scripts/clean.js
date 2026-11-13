#!/usr/bin/env node
"use strict";

/**
 * clean.js — turns the crawled WordPress pages into a plain static site.
 *  - removes WP/Divi/Jetpack/CF7/WPForms/cookie-banner scripts, meta and links
 *  - downloads remaining remote assets (i0.wp.com, c0.wp.com, abano.be, gstatic fonts)
 *  - rewrites abano.be links to local paths (BASE_PATH prefix)
 *  - adds assets/site.js (mobile menu only) and un-hides animated elements
 * Idempotent: safe to re-run.
 */

const fetch   = require("node-fetch");
const fs      = require("fs-extra");
const path    = require("path");
const cheerio = require("cheerio");
const pLimit  = require("p-limit");

const ROOT      = path.resolve(".");
const ASSETS    = path.join(ROOT, "assets");
const BASE_PATH = "/Abano-Website";
const LIVE      = "https://www.abano.be";
const SKIP_DIRS = new Set(["node_modules", ".git", "scripts", ".github", "assets"]);
const limit     = pLimit(8);
const cache     = new Map(); // remote url -> local url (or null on failure)

// ── asset handling ───────────────────────────────────────────────────────────

function toLocal(raw) {
  let u;
  try { u = new URL(raw.replace(/&amp;/g, "&"), LIVE); } catch { return null; }
  const h = u.hostname;
  let remote, rel;
  if (h === "i0.wp.com" || h === "i1.wp.com" || h === "i2.wp.com") {
    // i0.wp.com/abano.be/wp-content/... -> original on abano.be
    const m = u.pathname.match(/^\/[^/]+(\/wp-content\/.*)$/); // host may be abano.be or an old staging mirror
    if (!m) return null;
    rel = m[1]; remote = `https://abano.be${rel}`;
  } else if (h === "abano.be" || h === "www.abano.be") {
    if (!/^\/wp-(content|includes)\//.test(u.pathname)) return null;
    rel = u.pathname; remote = `https://abano.be${rel}`;
  } else if (h === "fonts.gstatic.com") {
    rel = "/fonts" + u.pathname; remote = u.href;
  } else if (h === "c0.wp.com") {
    rel = u.pathname; remote = u.href;
  } else return null;
  return { remote, local: `/assets${rel}`, file: path.join(ASSETS, rel) };
}

async function localize(raw) {
  if (!raw || raw.startsWith("data:") || raw.startsWith("#")) return raw;
  const t = toLocal(raw);
  if (!t) return raw;
  const pub = BASE_PATH + t.local;
  if (cache.has(t.remote)) return cache.get(t.remote) ? pub : raw;
  const job = limit(async () => {
    try {
      if (!(await fs.pathExists(t.file))) {
        const res = await fetch(t.remote, { timeout: 30000 });
        if (!res.ok) throw new Error("HTTP " + res.status);
        await fs.outputFile(t.file, await res.buffer());
      }
      return true;
    } catch (e) {
      console.warn(`  ! ${t.remote} — ${e.message}`);
      return false;
    }
  });
  cache.set(t.remote, job.then(ok => { cache.set(t.remote, ok); return ok; }));
  const ok = await job;
  return ok ? pub : raw;
}

async function rewriteCSSUrls(css) {
  const re = /url\((['"]?)([^'")]+)\1\)/g;
  const found = [...css.matchAll(re)];
  const map = new Map();
  await Promise.all(found.map(async m => {
    if (!map.has(m[2])) map.set(m[2], await localize(m[2]));
  }));
  return css.replace(re, (all, q, u) => `url(${q}${map.get(u) ?? u}${q})`);
}

function rewriteLink(href) {
  if (!href) return href;
  const m = href.match(/^https?:\/\/(?:www\.)?abano\.be(\/[^]*)?$/i);
  if (!m) return href;
  const p = m[1] || "/";
  if (/^\/wp-(content|includes)\//.test(p)) return href; // handled by localize
  return remapPost(BASE_PATH + p);
}

// Posts live at /YYYY/MM/DD/slug/ but listing pages link to /news/slug/
let postDirs = null;
function remapPost(href) {
  const m = href.match(/^(\/Abano-Website)\/news\/([^/#?]+)\/?([#?].*)?$/);
  if (!m || m[2] === "page") return href;
  if (!postDirs) {
    postDirs = new Map();
    for (const y of fs.readdirSync(ROOT).filter(d => /^\d{4}$/.test(d)))
      for (const mo of fs.readdirSync(path.join(ROOT, y)))
        for (const d of fs.readdirSync(path.join(ROOT, y, mo)))
          for (const slug of fs.readdirSync(path.join(ROOT, y, mo, d)))
            postDirs.set(slug, `${y}/${mo}/${d}/${slug}`);
  }
  const dir = postDirs.get(m[2]);
  return dir ? `${m[1]}/${dir}/${m[3] || ""}` : href;
}

// ── per-page cleanup ─────────────────────────────────────────────────────────


async function clean(file) {
  const html = await fs.readFile(file, "utf8");
  const $ = cheerio.load(html, { decodeEntities: false });

  // scripts (everything; we add our own below) + noscript + speculation rules
  $("script, noscript").remove();

  // head noise
  $('link[rel="pingback"], link[rel="dns-prefetch"], link[rel="preconnect"], link[rel="alternate"], ' +
    'link[rel="https://api.w.org/"], link[rel="shortlink"], link[rel="EditURI"], link[rel="canonical"], ' +
    'link#contact-form-7-css, meta[name="generator"], meta[name="robots"], style#wpstats, ' +
    'style[id*="wpforms"], link[id*="wpforms"], link[href*="wpforms"], link[href*="contact-form-7"]').remove();
  $("style").each((_, el) => {
    const id = $(el).attr("id") || "";
    if (/^(wp-img-auto-sizes|wp-block|global-styles|classic-theme|wp-emoji)/.test(id)) $(el).remove();
  });
  $("img#wpstats, img[src*='pixel.wp.com']").remove();
  $(".hu-banner, #hu, [id^='hu-'], .mejs-container, .et_pb_section_video_bg, .et_pb_video_box").remove();
  $("#wpadminbar, .screen-reader-text.skip-link").remove();

  // forms: search -> removed, contact/apply forms -> pointer to live site
  $("form").each((_, f) => {
    const $f = $(f);
    const cls = $f.attr("class") || "";
    if (/wpforms|wpcf7/.test(cls) || $f.attr("id")?.startsWith("wpforms")) {
      const wrap = $f.closest(".wpforms-container, .wpcf7").length ? $f.closest(".wpforms-container, .wpcf7") : $f;
      wrap.replaceWith(`<p class="static-note">Please <a href="${LIVE}/contact/">contact us via abano.be</a>.</p>`);
    } else {
      $f.remove();
    }
  });

  // un-hide JS-animated elements
  $(".et_animated").each((_, el) => {
    $(el).removeClass("et_animated et_is_animating").removeAttr("style");
  });
  $("[style*='opacity: 0']").each((_, el) => {
    const s = ($(el).attr("style") || "").replace(/opacity:\s*0;?/g, "").replace(/transform:[^;]*;?/g, "");
    s.trim() ? $(el).attr("style", s) : $(el).removeAttr("style");
  });

  // links
  $("a[href]").each((_, el) => $(el).attr("href", remapPost(rewriteLink($(el).attr("href")))));

  // assets in attributes
  const jobs = [];
  $("[src], [href], [content], [data-src]").each((_, el) => {
    for (const a of ["src", "href", "content", "data-src"]) {
      const v = $(el).attr(a);
      if (v && /^(https?:)?\/\/(i\d|c0)\.wp\.com|abano\.be\/wp-(content|includes)|fonts\.gstatic/.test(v))
        jobs.push(localize(v).then(n => $(el).attr(a, n)));
    }
  });
  $("img, source").each((_, el) => {
    $(el).removeAttr("srcset").removeAttr("sizes").removeAttr("data-srcset");
  });
  $("[style]").each((_, el) => {
    const s = $(el).attr("style");
    if (s.includes("url(")) jobs.push(rewriteCSSUrls(s).then(n => $(el).attr("style", n)));
  });
  $("style").each((_, el) => {
    const s = $(el).html();
    if (s && s.includes("url(")) jobs.push(rewriteCSSUrls(s).then(n => $(el).html(n)));
  });
  await Promise.all(jobs);

  // our own tiny script (mobile menu)
  $("body").append(`<script src="${BASE_PATH}/assets/site.js"></script>`);

  let out = $.html();
  out = out.replace(/\s*<!--[\s\S]*?-->/g, m => (/^\s*<!--\[if/.test(m) ? m : ""));
  await fs.writeFile(file, out);
}

async function cleanCSS(file) {
  const css = await fs.readFile(file, "utf8");
  if (!/url\(/.test(css)) return;
  await fs.writeFile(file, await rewriteCSSUrls(css));
}

// ── main ─────────────────────────────────────────────────────────────────────

async function walk(dir, ext, out = []) {
  for (const e of await fs.readdir(dir)) {
    if (SKIP_DIRS.has(e) && dir === ROOT) continue;
    const p = path.join(dir, e);
    if ((await fs.stat(p)).isDirectory()) await walk(p, ext, out);
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

(async () => {
  await fs.outputFile(path.join(ASSETS, "site.js"), `(function () {
  var nav = document.querySelector(".mobile_nav");
  var menu = document.getElementById("mobile_menu");
  var bar = document.querySelector(".mobile_menu_bar_toggle");
  if (nav && menu && bar) {
    menu.style.display = "none";
    bar.addEventListener("click", function () {
      var open = nav.classList.toggle("opened");
      nav.classList.toggle("closed", !open);
      menu.style.display = open ? "block" : "none";
    });
  }
})();
`);
  const pages = await walk(ROOT, ".html");
  console.log(`Cleaning ${pages.length} pages…`);
  for (const p of pages) await clean(p);
  for (const c of await walk(ASSETS, ".css")) await cleanCSS(c);
  console.log("Done.");
})();
