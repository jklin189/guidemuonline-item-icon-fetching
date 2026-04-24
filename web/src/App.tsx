import { useMemo, useState } from "react";
import "./App.css";

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

const ZIP_CONCURRENCY = 10;

async function downloadZipViaFetch(pageUrl: string, signal?: AbortSignal) {
  const res = await fetch(
    `/api/zip?url=${encodeURIComponent(pageUrl)}&concurrency=${ZIP_CONCURRENCY}`,
    { signal },
  );
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) msg = j.error;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }

  const cd = res.headers.get("content-disposition") || "";
  const m = cd.match(/filename="([^"]+)"/i);
  const filename = m?.[1] || "icons.zip";

  const body = res.body;
  if (!body) throw new Error("Empty response body");
  const reader = body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];

  // Read stream fully (so we know when it ends).
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }

  const blob = new Blob(chunks, { type: "application/zip" });
  const objectUrl = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function App() {
  const [url, setUrl] = useState("https://guidemuonline.com/items/weapons/sword");
  const [error, setError] = useState<string>("");
  const [zipping, setZipping] = useState(false);

  const canFetch = useMemo(() => {
    try {
      // eslint-disable-next-line no-new
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }, [url]);

  async function onDownloadZip() {
    setZipping(true);
    setError("");
    try {
      const ac = new AbortController();
      const t = window.setTimeout(() => ac.abort(), 10 * 60_000);
      try {
        await downloadZipViaFetch(url, ac.signal);
      } finally {
        window.clearTimeout(t);
      }
      await nextFrame();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      // Hide only after stream ends + save triggered.
      setZipping(false);
    }
  }

  return (
    <div className="page">
      <div className="stack">
        <header className="header">
          <div className="title">Guidemuonline icon fetching</div>
          <div className="subtitle">Paste URL, fetch icons, download.</div>
        </header>

        <section className="panel">
          <label className="label">
            Page URL
            <input
              className="input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://guidemuonline.com/items/weapons/sword"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <div className="row">
            <button className="btn" onClick={onDownloadZip} disabled={!canFetch || zipping}>
              {zipping ? "Preparing ZIP…" : "Download ZIP"}
            </button>
            <div className="meta">
              <span className="hint">Downloads a ZIP from local `/api/zip`.</span>
            </div>
          </div>

          {zipping ? (
            <div className="loadingRow" role="status" aria-live="polite">
              <div className="spinner" aria-hidden="true" />
              <div>Building ZIP…</div>
            </div>
          ) : null}

          {error ? <div className="error">{error}</div> : null}
        </section>
      </div>
    </div>
  );
}

export default App;
