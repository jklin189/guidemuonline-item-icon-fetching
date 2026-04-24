import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

function parseArgs(argv) {
  const args = {
    url: "https://guidemuonline.com/items/weapons/sword",
    outDir: "",
    concurrency: 8,
    timeoutMs: 45_000,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") args.url = String(argv[++i] ?? "");
    else if (a === "--out") args.outDir = path.resolve(String(argv[++i] ?? ""));
    else if (a === "--concurrency") args.concurrency = Number(argv[++i] ?? args.concurrency);
    else if (a === "--timeoutMs") args.timeoutMs = Number(argv[++i] ?? args.timeoutMs);
  }

  if (!args.url) throw new Error("Missing --url");
  if (!args.outDir) args.outDir = outDirFromUrl(args.url);
  if (!Number.isFinite(args.concurrency) || args.concurrency <= 0) args.concurrency = 8;
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) args.timeoutMs = 45_000;
  return args;
}

function sanitizeFilename(name) {
  const cleaned = name
    .replaceAll(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replaceAll(/\s+/g, " ")
    .trim();
  return cleaned.length ? cleaned : "file";
}

function outDirFromUrl(url) {
  const base = path.resolve(process.cwd(), "downloads/guidemu");
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const itemsIdx = parts.indexOf("items");
    const tail = (itemsIdx >= 0 ? parts.slice(itemsIdx) : parts.slice(-1)).map(sanitizeFilename);
    if (tail.length) return path.join(base, ...tail);
  } catch {
    // ignore
  }
  return path.join(base, "items", "weapons", "unknown");
}

function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    // Firebase storage URLs often include the object path in `o=...` or directly in pathname.
    const o = u.searchParams.get("o");
    if (o) {
      const decoded = decodeURIComponent(o);
      const base = decoded.split("/").pop() || "image.webp";
      return sanitizeFilename(base);
    }

    const last = decodeURIComponent(u.pathname.split("/").pop() || "image.webp");
    return sanitizeFilename(last);
  } catch {
    return "image.webp";
  }
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function downloadToFile(url, outPath) {
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (download-weapon-images)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const body = res.body;
  if (!body) throw new Error(`Empty body for ${url}`);
  await pipeline(Readable.fromWeb(body), fs.createWriteStream(outPath));
}

function createLimiter(concurrency) {
  let active = 0;
  /** @type {Array<() => void>} */
  const queue = [];

  const next = () => {
    active--;
    const fn = queue.shift();
    if (fn) fn();
  };

  return async (fn) =>
    await new Promise((resolve, reject) => {
      const run = async () => {
        active++;
        try {
          resolve(await fn());
        } catch (e) {
          reject(e);
        } finally {
          next();
        }
      };

      if (active < concurrency) run();
      else queue.push(run);
    });
}

async function collectImageUrls(page) {
  // Collect from <img src>, <img srcset>, and inline/background styles.
  const urls = await page.evaluate(() => {
    const out = new Set();

    const addMaybe = (u) => {
      if (!u) return;
      try {
        const abs = new URL(u, location.href).toString();
        out.add(abs);
      } catch {
        // ignore
      }
    };

    for (const img of document.querySelectorAll("img")) {
      addMaybe(img.getAttribute("src"));
      const srcset = img.getAttribute("srcset");
      if (srcset) {
        for (const part of srcset.split(",")) {
          const candidate = part.trim().split(/\s+/)[0];
          addMaybe(candidate);
        }
      }
    }

    for (const el of document.querySelectorAll("*")) {
      const style = window.getComputedStyle(el);
      const bg = style?.backgroundImage;
      if (!bg || bg === "none") continue;
      // background-image: url("...") or url(...)
      for (const m of bg.matchAll(/url\\((['\"]?)(.*?)\\1\\)/g)) addMaybe(m[2]);
    }

    for (const a of document.querySelectorAll("a[href]")) {
      // Some SPAs store images in hrefs/data-attrs; this is cheap to capture.
      addMaybe(a.getAttribute("href"));
    }

    for (const el of document.querySelectorAll("[data-src],[data-srcset],[data-lazy],[data-original]")) {
      addMaybe(el.getAttribute("data-src"));
      addMaybe(el.getAttribute("data-lazy"));
      addMaybe(el.getAttribute("data-original"));
      const ds = el.getAttribute("data-srcset");
      if (ds) {
        for (const part of ds.split(",")) {
          const candidate = part.trim().split(/\\s+/)[0];
          addMaybe(candidate);
        }
      }
    }

    return Array.from(out);
  });

  // Heuristic filter: keep only Firebase storage item images if present;
  // otherwise keep all images (still downloadable).
  const firebase = urls.filter((u) => u.includes("firebasestorage.googleapis.com"));
  return firebase.length ? firebase : urls;
}

async function main() {
  const { url, outDir, concurrency, timeoutMs } = parseArgs(process.argv.slice(2));

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch (e) {
    console.error(
      [
        "Missing dependency: playwright",
        "",
        "Install it from the repo root (or server/):",
        "  npm i -D playwright",
        "  npx playwright install chromium",
        "",
        `Then run:\n  node download-weapon-images.mjs --url ${url}`,
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  await ensureDir(outDir);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Capture any image URLs that occur in network requests as well (covers lazy loading).
  /** @type {Set<string>} */
  const seenFromNetwork = new Set();
  page.on("response", (res) => {
    const u = res.url();
    if (u.includes("firebasestorage.googleapis.com") || /\.(webp|png|jpg|jpeg|gif)(\\?|$)/i.test(u)) {
      seenFromNetwork.add(u);
    }
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  // Wait a bit for client-side data fetch + initial render.
  await page.waitForTimeout(1500);

  // Try scrolling to trigger lazy-load.
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.scrollBy(0, Math.max(400, window.innerHeight)));
    await page.waitForTimeout(400);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(800);

  const domUrls = await collectImageUrls(page);
  const all = Array.from(new Set([...domUrls, ...seenFromNetwork]));

  // Try to focus on current weapons folder images (when present).
  const weaponSlug = (() => {
    try {
      const u = new URL(url);
      const parts = u.pathname.split("/").filter(Boolean);
      return parts.at(-1) || "";
    } catch {
      return "";
    }
  })();
  const focusedNeedle = weaponSlug
    ? `assets%2Fitems%2Fweapons%2F${encodeURIComponent(weaponSlug)}%2F`
    : "";
  const focused = focusedNeedle ? all.filter((u) => u.includes(focusedNeedle)) : [];
  const finalUrls = focused.length ? focused : all.filter((u) => u.includes("firebasestorage.googleapis.com"));

  if (!finalUrls.length) {
    console.error("No downloadable Firebase image URLs found. The site may have changed.");
    await browser.close();
    process.exitCode = 2;
    return;
  }

  const limit = createLimiter(concurrency);
  let ok = 0;
  let skipped = 0;
  let failed = 0;

  await Promise.all(
    finalUrls.map((imgUrl) =>
      limit(async () => {
        const name = filenameFromUrl(imgUrl);
        const outPath = path.join(outDir, name);
        try {
          await fsp.access(outPath, fs.constants.F_OK);
          skipped++;
          return;
        } catch {
          // continue
        }

        try {
          await downloadToFile(imgUrl, outPath);
          ok++;
        } catch (e) {
          failed++;
          console.error(`Failed: ${imgUrl}\n  ${String(e?.message ?? e)}`);
        }
      }),
    ),
  );

  await browser.close();

  console.log(
    [
      "Done.",
      `- url: ${url}`,
      `- out: ${outDir}`,
      `- downloaded: ${ok}`,
      `- skipped (already exists): ${skipped}`,
      `- failed: ${failed}`,
    ].join("\n"),
  );

  if (failed) process.exitCode = 3;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

