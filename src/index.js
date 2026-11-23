import qrcode from "qrcode-generator";
import { qrToPng } from "./png.js";

// User agents treated as bots / link-preview fetchers. These scans are logged with is_bot=1
// but excluded from every count on the dashboard.
const BOT_RE = /bot|crawl|spider|preview|facebookexternalhit|WhatsApp|Slackbot|TelegramBot|Discordbot|LinkedInBot|Twitterbot|curl|wget/i;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const IST = "+330 minutes"; // Asia/Kolkata = UTC+5:30, no DST

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (path.startsWith("/r/")) return await handleRedirect(request, env, ctx, path.slice(3));
      if (path === "/admin" || path.startsWith("/admin/")) {
        if (!(await isAuthorized(request, env))) {
          return new Response("Authentication required", {
            status: 401,
            headers: { "WWW-Authenticate": 'Basic realm="QR Tracker Admin", charset="UTF-8"', "Cache-Control": "no-store" },
          });
        }
        return await handleAdmin(request, env, url, path);
      }
      if (path === "/") return new Response("OK", { headers: { "Content-Type": "text/plain" } });
      return notFound();
    } catch (err) {
      console.error(err);
      return new Response("Internal error", { status: 500 });
    }
  },
};

// ---------- redirect + logging ----------

async function handleRedirect(request, env, ctx, rawSlug) {
  const slug = decodeURIComponent(rawSlug).toLowerCase();
  if (!SLUG_RE.test(slug)) return notFound();
  const link = await env.DB.prepare("SELECT destination FROM links WHERE slug = ?").bind(slug).first();
  if (!link) return notFound();

  if (request.method === "GET") ctx.waitUntil(logScan(request, env, slug));

  // Build the response by hand so the Location header is exactly the stored string.
  return new Response(null, {
    status: 302,
    headers: { Location: link.destination, "Cache-Control": "no-store, max-age=0", "Referrer-Policy": "no-referrer-when-downgrade" },
  });
}

async function logScan(request, env, slug) {
  const ua = request.headers.get("User-Agent") || "";
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const referer = request.headers.get("Referer") || "";
  const visitor = await sha256Hex(`${ip}|${ua}|${env.SALT || ""}`);
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  await env.DB.prepare(
    "INSERT INTO scans (ts, slug, visitor_hash, user_agent, referer, is_bot) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(ts, slug, visitor, ua.slice(0, 512), referer.slice(0, 512), BOT_RE.test(ua) ? 1 : 0).run();
}

// ---------- auth ----------

async function isAuthorized(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const h = request.headers.get("Authorization") || "";
  if (!h.startsWith("Basic ")) return false;
  let decoded;
  try { decoded = atob(h.slice(6)); } catch { return false; }
  const i = decoded.indexOf(":");
  if (i < 0) return false;
  const user = decoded.slice(0, i), pass = decoded.slice(i + 1);
  // Compare hashes so the comparison is constant-time regardless of length.
  const [a, b] = await Promise.all([sha256Hex(`${user}:${pass}`), sha256Hex(`admin:${env.ADMIN_PASSWORD}`)]);
  let diff = 0;
  for (let k = 0; k < a.length; k++) diff |= a.charCodeAt(k) ^ b.charCodeAt(k);
  return diff === 0;
}

// ---------- admin ----------

async function handleAdmin(request, env, url, path) {
  const base = (env.PUBLIC_BASE_URL || url.origin).replace(/\/+$/, "");

  if (request.method === "POST") {
    // Basic Auth credentials are re-sent automatically by browsers, so block cross-site form posts.
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return new Response("Bad origin", { status: 403 });
    const form = await request.formData();

    if (path === "/admin/links") {
      const slug = String(form.get("slug") || "").trim().toLowerCase();
      const label = String(form.get("label") || "").trim().slice(0, 100);
      const dest = String(form.get("destination") || "").trim();
      if (!SLUG_RE.test(slug)) return adminPage(env, base, "Slug must be lowercase letters, digits, - or _ (max 64).");
      if (!isHttpUrl(dest)) return adminPage(env, base, "Destination must be a full http(s) URL.");
      const res = await env.DB.prepare("INSERT OR IGNORE INTO links (slug, label, destination) VALUES (?, ?, ?)")
        .bind(slug, label, dest).run();
      if (!res.meta.changes) return adminPage(env, base, `Slug "${slug}" already exists.`);
      return seeOther("/admin");
    }

    const m = path.match(/^\/admin\/links\/([^/]+)$/);
    if (m) {
      const slug = decodeURIComponent(m[1]);
      const dest = String(form.get("destination") || "").trim();
      if (!isHttpUrl(dest)) return adminPage(env, base, "Destination must be a full http(s) URL.");
      await env.DB.prepare("UPDATE links SET destination = ?, updated_at = datetime('now') WHERE slug = ?")
        .bind(dest, slug).run();
      return seeOther("/admin");
    }
    return notFound();
  }

  if (path === "/admin") return adminPage(env, base);

  let m = path.match(/^\/admin\/qr\/([^/]+)\.png$/);
  if (m) {
    const slug = decodeURIComponent(m[1]);
    const link = await env.DB.prepare("SELECT slug FROM links WHERE slug = ?").bind(slug).first();
    if (!link) return notFound();
    const qr = qrcode(0, "M");
    qr.addData(`${base}/r/${slug}`, "Byte");
    qr.make();
    const { png } = await qrToPng(qr.getModuleCount(), (r, c) => qr.isDark(r, c), { minSize: 1200, border: 4 });
    return new Response(png, {
      headers: {
        "Content-Type": "image/png",
        "Content-Disposition": `attachment; filename="qr-${slug}.png"`,
        "Cache-Control": "no-store",
      },
    });
  }

  m = path.match(/^\/admin\/links\/([^/]+)\/scans\.csv$/);
  if (m) return exportCsv(env, decodeURIComponent(m[1]));

  m = path.match(/^\/admin\/links\/([^/]+)$/);
  if (m) return detailsPage(env, base, decodeURIComponent(m[1]));

  return notFound();
}

async function adminPage(env, base, error = "") {
  const { results } = await env.DB.prepare(`
    SELECT l.slug, l.label, l.destination,
      (SELECT COUNT(*) FROM scans s WHERE s.slug = l.slug AND s.is_bot = 0) AS total,
      (SELECT COUNT(DISTINCT s.visitor_hash) FROM scans s WHERE s.slug = l.slug AND s.is_bot = 0) AS uniques,
      (SELECT COUNT(*) FROM scans s WHERE s.slug = l.slug AND s.is_bot = 0
         AND date(s.ts, '${IST}') = date('now', '${IST}')) AS today
    FROM links l ORDER BY l.created_at, l.slug`).all();

  const cards = results.map((l) => {
    const short = `${base}/r/${l.slug}`;
    return `<section class="card">
  <div class="head"><h2>${esc(l.label || l.slug)}</h2><code>${esc(l.slug)}</code></div>
  <p class="short"><a href="${esc(short)}" target="_blank" rel="noopener">${esc(short)}</a></p>
  <div class="stats">
    <div><b>${l.total}</b><span>total scans</span></div>
    <div><b>${l.uniques}</b><span>unique visitors</span></div>
    <div><b>${l.today}</b><span>today (IST)</span></div>
  </div>
  <form method="post" action="/admin/links/${encodeURIComponent(l.slug)}" class="row">
    <input type="url" name="destination" value="${esc(l.destination)}" required aria-label="Destination URL">
    <button type="submit">Update</button>
  </form>
  <div class="actions">
    <a class="btn" href="/admin/qr/${encodeURIComponent(l.slug)}.png" download>Download QR (PNG)</a>
    <a class="btn ghost" href="/admin/links/${encodeURIComponent(l.slug)}">Details</a>
  </div>
</section>`;
  }).join("\n");

  return html(layout("QR Tracker", `
<h1>QR Tracker</h1>
${error ? `<p class="error">${esc(error)}</p>` : ""}
${cards || "<p>No links yet.</p>"}
<section class="card">
  <h2>Create a new link</h2>
  <form method="post" action="/admin/links" class="stack">
    <label>Slug <input name="slug" required pattern="[a-z0-9][a-z0-9_\\-]{0,63}" placeholder="e.g. wss-flyer"></label>
    <label>Label <input name="label" placeholder="e.g. Flyer"></label>
    <label>Destination URL <input type="url" name="destination" required placeholder="https://..."></label>
    <button type="submit">Create link</button>
  </form>
</section>
<p class="muted">Bots and link previews (WhatsApp, Instagram/Facebook, Slack, etc.) are logged but not counted.</p>`), error ? 400 : 200);
}

async function detailsPage(env, base, slug) {
  const link = await env.DB.prepare("SELECT * FROM links WHERE slug = ?").bind(slug).first();
  if (!link) return notFound();

  const [daily, latest] = await Promise.all([
    env.DB.prepare(`SELECT date(ts, '${IST}') AS d, COUNT(*) AS n FROM scans
      WHERE slug = ? AND is_bot = 0 AND date(ts, '${IST}') > date('now', '${IST}', '-60 days')
      GROUP BY d`).bind(slug).all(),
    env.DB.prepare("SELECT ts, visitor_hash, user_agent, referer, is_bot FROM scans WHERE slug = ? ORDER BY id DESC LIMIT 100")
      .bind(slug).all(),
  ]);

  const counts = Object.fromEntries(daily.results.map((r) => [r.d, r.n]));
  const days = [];
  const todayIst = new Date(Date.now() + 330 * 60000);
  for (let i = 0; i < 60; i++) {
    const d = new Date(todayIst.getTime() - i * 86400000).toISOString().slice(0, 10);
    days.push([d, counts[d] || 0]);
  }
  const max = Math.max(1, ...days.map(([, n]) => n));
  const bars = days.map(([d, n]) => `<div class="bar"><span class="d">${d}</span><span class="track"><span class="fill" style="width:${(n / max) * 100}%"></span></span><span class="n">${n}</span></div>`).join("");

  const rows = latest.results.map((s) => `<tr${s.is_bot ? ' class="bot"' : ""}>
<td>${esc(istTime(s.ts))}</td><td><code>${esc(s.visitor_hash.slice(0, 10))}</code></td>
<td>${s.is_bot ? "bot" : ""}</td><td class="ua">${esc(s.user_agent || "")}</td><td class="ua">${esc(s.referer || "")}</td></tr>`).join("");

  return html(layout(`${link.slug} · QR Tracker`, `
<p><a href="/admin">&larr; All links</a></p>
<h1>${esc(link.label || link.slug)} <code>${esc(link.slug)}</code></h1>
<p class="short">${esc(`${base}/r/${link.slug}`)} &rarr; <span class="dest">${esc(link.destination)}</span></p>
<div class="actions">
  <a class="btn" href="/admin/links/${encodeURIComponent(link.slug)}/scans.csv">Export CSV</a>
  <a class="btn ghost" href="/admin/qr/${encodeURIComponent(link.slug)}.png" download>Download QR (PNG)</a>
</div>
<section class="card"><h2>Scans per day (last 60 days, IST, bots excluded)</h2><div class="bars">${bars}</div></section>
<section class="card"><h2>Latest 100 scans</h2>
<div class="tablewrap"><table><thead><tr><th>Time (IST)</th><th>Visitor</th><th>Bot</th><th>User agent</th><th>Referer</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5">No scans yet.</td></tr>'}</tbody></table></div></section>`));
}

async function exportCsv(env, slug) {
  const link = await env.DB.prepare("SELECT slug FROM links WHERE slug = ?").bind(slug).first();
  if (!link) return notFound();
  const { results } = await env.DB.prepare(
    "SELECT ts, slug, visitor_hash, user_agent, referer, is_bot FROM scans WHERE slug = ? ORDER BY id"
  ).bind(slug).all();
  const cell = (v) => {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // avoid spreadsheet formula injection
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [["timestamp_utc", "timestamp_ist", "slug", "visitor_hash", "user_agent", "referer", "is_bot"].join(",")];
  for (const r of results) {
    lines.push([r.ts, istTime(r.ts), r.slug, r.visitor_hash, r.user_agent, r.referer, r.is_bot].map(cell).join(","));
  }
  return new Response(lines.join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="scans-${slug}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

// ---------- helpers ----------

function layout(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1d2330;--muted:#6b7280;--line:#e3e6eb;--accent:#2f5bd3;--bar:#7c9cf0}
@media (prefers-color-scheme:dark){:root{--bg:#121418;--card:#1b1e24;--fg:#e7e9ee;--muted:#9aa1ad;--line:#2c3038;--accent:#7c9cf0;--bar:#4c6fd6}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:16px}h1{font-size:1.4rem;margin:8px 0 16px}h2{font-size:1.05rem;margin:0}
a{color:var(--accent)}code{font-size:.85em;background:var(--line);padding:1px 6px;border-radius:4px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:0 0 14px}
.head{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.short{margin:6px 0 12px;word-break:break-all}.dest{color:var(--muted)}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px}
.stats div{border:1px solid var(--line);border-radius:8px;padding:8px;text-align:center}
.stats b{display:block;font-size:1.4rem}.stats span{font-size:.8rem;color:var(--muted)}
.row{display:flex;gap:8px}.row input{flex:1;min-width:0}
.stack{display:grid;gap:10px;margin-top:10px}.stack label{display:grid;gap:4px;font-size:.9rem}
input{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
button,.btn{font:inherit;display:inline-block;padding:8px 14px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;text-decoration:none;cursor:pointer;white-space:nowrap}
.btn.ghost{background:transparent;color:var(--accent)}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
.error{background:#fde8e8;color:#9b1c1c;padding:10px;border-radius:6px}.muted{color:var(--muted);font-size:.85rem}
.bars{display:grid;gap:3px;margin-top:10px}.bar{display:grid;grid-template-columns:90px 1fr 36px;gap:8px;align-items:center;font-size:.8rem}
.track{background:var(--line);border-radius:3px;height:10px;overflow:hidden}.fill{display:block;height:100%;background:var(--bar)}.n{text-align:right}
.tablewrap{overflow-x:auto;margin-top:10px}table{border-collapse:collapse;width:100%;font-size:.8rem}
th,td{text-align:left;padding:6px;border-bottom:1px solid var(--line);vertical-align:top}td.ua{max-width:280px;word-break:break-all}tr.bot{color:var(--muted)}
</style></head><body><main>${body}</main></body></html>`;
}

function istTime(ts) {
  return new Date(ts.replace(" ", "T") + "Z").toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function isHttpUrl(s) {
  try { const u = new URL(s); return u.protocol === "https:" || u.protocol === "http:"; } catch { return false; }
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function html(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
function seeOther(loc) { return new Response(null, { status: 303, headers: { Location: loc } }); }
function notFound() { return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } }); }
