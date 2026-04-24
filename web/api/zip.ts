import type { VercelRequest, VercelResponse } from "@vercel/node";
// Archiver types are not always present in Vercel builds.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import archiver from "archiver";
import chromiumLambda from "@sparticuz/chromium";
import { chromium } from "playwright-core";

function sanitizeFilename(name: string) {
  const cleaned = String(name)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length ? cleaned : "file";
}

function filenameFromUrl(url: string) {
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

function createLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    active--;
    const fn = queue.shift();
    if (fn) fn();
  };

  return async <T,>(fn: () => Promise<T>) =>
    await new Promise<T>((resolve, reject) => {
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

async function collectImageUrls(page: any): Promise<string[]> {
  const urls: string[] = await page.evaluate(() => {
    const out = new Set<string>();

    const addMaybe = (u: string | null) => {
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
      for (const m of bg.matchAll(/url\((['"]?)(.*?)\1\)/g)) addMaybe(m[2] || null);
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

function pickFocusedUrls(pageUrl: string, allUrls: string[]) {
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

export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const url = String(req.query.url ?? "");
  if (!url) return res.status(400).json({ error: "Missing url" });

  const timeoutMs = Math.min(120_000, Math.max(5_000, Number(req.query.timeoutMs ?? 45_000)));
  const overallTimeoutMs = Math.min(240_000, Math.max(5_000, Number(req.query.overallTimeoutMs ?? 120_000)));
  const concurrency = Math.min(12, Math.max(1, Number(req.query.concurrency ?? 10)));

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

  const startedAt = Date.now();
  const remaining = () => Math.max(0, overallTimeoutMs - (Date.now() - startedAt));

  try {
    // Prepare response headers before streaming.
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err: unknown) => {
      try {
        // eslint-disable-next-line no-console
        console.error(err);
        res.end();
      } catch {
        // ignore
      }
    });
    archive.pipe(res);

    const execPath = await chromiumLambda.executablePath();
    const browser = await chromium.launch({
      args: chromiumLambda.args,
      defaultViewport: chromiumLambda.defaultViewport,
      executablePath: execPath || undefined,
      headless: true,
    });

    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.setDefaultTimeout(Math.min(timeoutMs, overallTimeoutMs));

      const seenFromNetwork = new Set<string>();
      page.on("response", (r: any) => {
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
      const finalUrls = pickFocusedUrls(url, all);

      const usedNames = new Set<string>();
      let idx = 1;
      const limit = createLimiter(concurrency);

      const filePromises = finalUrls.map((imgUrl) =>
        limit(async () => {
          const left = remaining();
          if (left <= 0) return null;

          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), Math.min(timeoutMs, left));
          try {
            const r = await fetch(imgUrl, {
              signal: controller.signal,
              headers: { "user-agent": "Mozilla/5.0 (vercel-zip)" },
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
      );

      const files = await Promise.all(filePromises);
      for (const f of files) {
        if (!f) continue;
        archive.append(f.buf, { name: f.name });
      }

      if (remaining() <= 0) {
        archive.append(`Timeout after ${overallTimeoutMs}ms\n`, { name: "_TIMEOUT.txt" });
      }
    } finally {
      await browser.close().catch(() => {});
    }

    await archive.finalize();
  } catch (e: any) {
    // If headers already sent, just end stream.
    if (res.headersSent) {
      try {
        res.end();
      } catch {
        // ignore
      }
      return;
    }
    return res.status(500).json({ error: String(e?.message ?? e) });
  }
}

