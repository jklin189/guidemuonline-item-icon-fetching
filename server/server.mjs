import express from "express";
import cors from "cors";
import archiver from "archiver";

function sanitizeFilename(name) {
  const cleaned = String(name)
    .replaceAll(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replaceAll(/\s+/g, " ")
    .trim();
  return cleaned.length ? cleaned : "file";
}

function filenameFromUrl(url) {
  try {
    const u = new URL(url);
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

async function collectImageUrls(page) {
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
      for (const m of bg.matchAll(/url\((['"]?)(.*?)\1\)/g)) addMaybe(m[2]);
    }

    for (const a of document.querySelectorAll("a[href]")) addMaybe(a.getAttribute("href"));

    for (const el of document.querySelectorAll("[data-src],[data-srcset],[data-lazy],[data-original]")) {
      addMaybe(el.getAttribute("data-src"));
      addMaybe(el.getAttribute("data-lazy"));
      addMaybe(el.getAttribute("data-original"));
      const ds = el.getAttribute("data-srcset");
      if (ds) {
        for (const part of ds.split(",")) {
          const candidate = part.trim().split(/\s+/)[0];
          addMaybe(candidate);
        }
      }
    }

    return Array.from(out);
  });

  const firebase = urls.filter((u) => u.includes("firebasestorage.googleapis.com"));
  return firebase.length ? firebase : urls;
}

function pickFocusedUrls({ pageUrl, allUrls }) {
  const weaponSlug = (() => {
    try {
      const u = new URL(pageUrl);
      const parts = u.pathname.split("/").filter(Boolean);
      return parts.at(-1) || "";
    } catch {
      return "";
    }
  })();

  const focusedNeedle = weaponSlug ? `assets%2Fitems%2Fweapons%2F${encodeURIComponent(weaponSlug)}%2F` : "";
  const focused = focusedNeedle ? allUrls.filter((u) => u.includes(focusedNeedle)) : [];
  const firebaseOnly = allUrls.filter((u) => u.includes("firebasestorage.googleapis.com"));
  return focused.length ? focused : firebaseOnly.length ? firebaseOnly : allUrls;
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

const app = express();
app.use(
  cors({
    origin: true,
    exposedHeaders: ["Content-Disposition"],
  }),
);
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/api/scrape", async (req, res) => {
  const url = String(req.query.url ?? "");
  const timeoutMs = Math.min(120_000, Math.max(5_000, Number(req.query.timeoutMs ?? 45_000)));
  const overallTimeoutMs = Math.min(180_000, Math.max(5_000, Number(req.query.overallTimeoutMs ?? timeoutMs)));
  if (!url) return res.status(400).json({ error: "Missing url" });

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return res.status(500).json({
      error: "Missing dependency: playwright. Run: cd server && npm i && npx playwright install chromium",
    });
  }

  const startedAt = Date.now();
  const remaining = () => Math.max(0, overallTimeoutMs - (Date.now() - startedAt));

  /** @type {import('playwright').Browser | null} */
  let browser = null;

  const run = async () => {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(Math.min(timeoutMs, overallTimeoutMs));

    const seenFromNetwork = new Set();
    page.on("response", (r) => {
      const u = r.url();
      if (u.includes("firebasestorage.googleapis.com") || /\.(webp|png|jpg|jpeg|gif)(\?|$)/i.test(u)) {
        seenFromNetwork.add(u);
      }
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.min(timeoutMs, remaining()) });

    const initialPause = Math.min(1500, remaining());
    if (initialPause) await page.waitForTimeout(initialPause);

    // Scroll budgeted by remaining time. (400ms per iteration)
    const maxScrollIters = Math.min(10, Math.floor(remaining() / 450));
    for (let i = 0; i < maxScrollIters; i++) {
      await page.evaluate(() => window.scrollBy(0, Math.max(400, window.innerHeight)));
      const pause = Math.min(400, remaining());
      if (!pause) break;
      await page.waitForTimeout(pause);
    }

    const backToTopPause = Math.min(800, remaining());
    if (backToTopPause) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(backToTopPause);
    }

    const domUrls = await collectImageUrls(page);
    const all = Array.from(new Set([...domUrls, ...seenFromNetwork]));
    const finalUrls = pickFocusedUrls({ pageUrl: url, allUrls: all });

    const images = finalUrls.map((u) => ({ url: u, filename: filenameFromUrl(u) }));
    return { url, count: images.length, images };
  };

  try {
    const out = await Promise.race([
      run(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Overall timeout after ${overallTimeoutMs}ms`)), overallTimeoutMs),
      ),
    ]);
    return res.json(out);
  } catch (e) {
    const msg = String(e?.message ?? e);
    const code = msg.toLowerCase().includes("timeout") ? 504 : 500;
    return res.status(code).json({ error: msg });
  } finally {
    if (browser) {
      // Avoid hanging the HTTP response on a stuck browser close.
      const close = browser.close().catch(() => {});
      await Promise.race([close, new Promise((r) => setTimeout(r, 2000))]);
    }
  }
});

app.get("/api/zip", async (req, res) => {
  const url = String(req.query.url ?? "");
  const timeoutMs = Math.min(120_000, Math.max(5_000, Number(req.query.timeoutMs ?? 45_000)));
  const overallTimeoutMs = Math.min(240_000, Math.max(5_000, Number(req.query.overallTimeoutMs ?? 120_000)));
  const concurrency = Math.min(12, Math.max(1, Number(req.query.concurrency ?? 6)));
  if (!url) return res.status(400).json({ error: "Missing url" });

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return res.status(500).json({
      error: "Missing dependency: playwright. Run: cd server && npm i && npx playwright install",
    });
  }

  const startedAt = Date.now();
  const remaining = () => Math.max(0, overallTimeoutMs - (Date.now() - startedAt));

  /** @type {import('playwright').Browser | null} */
  let browser = null;

  const scrapeUrls = async () => {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(Math.min(timeoutMs, overallTimeoutMs));

    const seenFromNetwork = new Set();
    page.on("response", (r) => {
      const u = r.url();
      if (u.includes("firebasestorage.googleapis.com") || /\.(webp|png|jpg|jpeg|gif)(\?|$)/i.test(u)) {
        seenFromNetwork.add(u);
      }
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.min(timeoutMs, remaining()) });
    const initialPause = Math.min(1500, remaining());
    if (initialPause) await page.waitForTimeout(initialPause);

    const maxScrollIters = Math.min(10, Math.floor(remaining() / 450));
    for (let i = 0; i < maxScrollIters; i++) {
      await page.evaluate(() => window.scrollBy(0, Math.max(400, window.innerHeight)));
      const pause = Math.min(400, remaining());
      if (!pause) break;
      await page.waitForTimeout(pause);
    }

    const backToTopPause = Math.min(800, remaining());
    if (backToTopPause) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(backToTopPause);
    }

    const domUrls = await collectImageUrls(page);
    const all = Array.from(new Set([...domUrls, ...seenFromNetwork]));
    return pickFocusedUrls({ pageUrl: url, allUrls: all });
  };

  try {
    const finalUrls = /** @type {string[]} */ (
      await Promise.race([
        scrapeUrls(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Overall timeout after ${overallTimeoutMs}ms`)), overallTimeoutMs),
        ),
      ])
    );

    const zipName = (() => {
      try {
        const u = new URL(url);
        const parts = u.pathname.split("/").filter(Boolean);
        const slug = parts.at(-1) || "icons";
        return `${sanitizeFilename(slug)}.zip`;
      } catch {
        return "icons.zip";
      }
    })();

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      try {
        console.error(err);
        if (!res.headersSent) res.status(500);
        res.end();
      } catch {
        // ignore
      }
    });

    archive.pipe(res);

    // Download each image and append to zip.
    // Use Buffer (not streaming) to avoid hanging on stalled network streams.
    // Do downloads concurrently to reduce total time.
    const usedNames = new Set();
    let idx = 1;
    const limit = createLimiter(concurrency);
    const files = await Promise.all(
      finalUrls.map((imgUrl) =>
        limit(async () => {
          const left = remaining();
          if (left <= 0) return null;

          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), Math.min(timeoutMs, left));
          try {
            const r = await fetch(imgUrl, {
              signal: controller.signal,
              headers: { "user-agent": "Mozilla/5.0 (weapon-zip)" },
            });
            if (!r.ok) return null;

            let name = filenameFromUrl(imgUrl);
            if (!name.toLowerCase().match(/\.(webp|png|jpe?g|gif)$/i)) name = `${name}.img`;
            name = sanitizeFilename(name);
            if (usedNames.has(name)) {
              const dot = name.lastIndexOf(".");
              const base = dot >= 0 ? name.slice(0, dot) : name;
              const ext = dot >= 0 ? name.slice(dot) : "";
              name = `${base}-${idx++}${ext}`;
            }
            usedNames.add(name);

            const ab = await r.arrayBuffer();
            return { name, buf: Buffer.from(ab) };
          } catch {
            return null;
          } finally {
            clearTimeout(t);
          }
        }),
      ),
    );

    for (const f of files) {
      if (!f) continue;
      archive.append(f.buf, { name: f.name });
    }

    if (remaining() <= 0) {
      archive.append(`Timeout after ${overallTimeoutMs}ms\n`, { name: "_TIMEOUT.txt" });
    }

    await archive.finalize();
  } catch (e) {
    const msg = String(e?.message ?? e);
    const code = msg.toLowerCase().includes("timeout") ? 504 : 500;
    return res.status(code).json({ error: msg });
  } finally {
    if (browser) {
      const close = browser.close().catch(() => {});
      await Promise.race([close, new Promise((r) => setTimeout(r, 2000))]);
    }
  }
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`server listening on http://localhost:${port}`);
});

