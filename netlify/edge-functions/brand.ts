// Rewrites the highest-impact branding elements in index.html/login.html
// (title, meta description, crest, name/location text, and the two raw
// brand colours) to match the requesting hostname's own society, BEFORE
// the HTML reaches the browser. Without this, every society's page loads
// with Gytte Lane's branding baked into the static HTML first, then the
// client-side applyBranding()/applyLoginPageBranding() swaps it a moment
// later — a visible flash of the wrong club on every single page load.
//
// Deliberately does NOT replicate the full branding pipeline (the derived
// HSL accent shades index.html's adjustLightness() computes, or the
// footer text) — that would mean keeping two copies of the same logic in
// sync forever. Client-side branding still runs exactly as before and
// corrects those lower-impact/lower-fold details a moment later; this only
// needs to cover what's visible in the very first paint.
//
// Same-origin, anon-key, RLS-gated `societies` SELECT the client already
// relies on — no elevated privileges, and no tenant data (events, scores,
// players) is ever touched here.

const SUPABASE_URL = "https://noldemdyjbwfqxkuxmvy.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_pzqpKakNbZYprPW8XzGVNg_U9pL0Nsw";

const CACHE_TTL_MS = 5 * 60 * 1000;
// Per-hostname cache, module-scope so it survives across requests on a warm
// edge instance. Not Netlify Blobs/KV — that would add a new import this
// function can't be tested locally before deploying, for a cache that only
// needs to survive a few minutes on an instance that's already warm. Worst
// case on a cold start is one extra Supabase round-trip, not a broken page.
const cache = new Map();

async function fetchOne(query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/societies?${query}&select=*&limit=1`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

// Same custom_domain -> subdomain -> oldest-society-fallback precedence as
// index.html's loadData() / login.html's resolveSociety().
async function resolveSociety(hostname) {
  const cached = cache.get(hostname);
  if (cached && cached.expires > Date.now()) return cached.soc;

  let soc = null;
  try {
    soc = await fetchOne(`custom_domain=eq.${encodeURIComponent(hostname)}`);
    if (!soc) {
      const subdomain = hostname.split(".")[0];
      soc = await fetchOne(`subdomain=eq.${encodeURIComponent(subdomain)}`);
    }
    if (!soc) soc = await fetchOne("order=created_at.asc");
  } catch {
    soc = null;
  }

  cache.set(hostname, { soc, expires: Date.now() + CACHE_TTL_MS });
  return soc;
}

// Same generator as index.html's placeholderCrestDataUri() — a society's
// first initial on its own colours. Needed here too: without a real
// uploaded logo_url, the edge function previously had nothing to put in
// #site-crest/#login-crest, so the static Gytte Lane crest kept showing
// until client JS swapped it a moment later — exactly the flash this file
// exists to prevent, just for the logo instead of the name/colours.
function placeholderCrestDataUri(soc) {
  const letter = esc((soc.name || "?").trim()[0]?.toUpperCase() || "?");
  const bg = soc.primary_colour || "#4B1320";
  const fg = soc.secondary_colour || "#B8862F";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="16" fill="${bg}"/><text x="50" y="66" font-size="50" font-family="Arial,sans-serif" font-weight="700" fill="${fg}" text-anchor="middle">${letter}</text></svg>`;
  return "data:image/svg+xml;base64," + btoa(svg);
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// [\s\S]*? (not [^<]*) so this still matches correctly even when the
// existing element contains its own markup (login.html's society-name div
// has a <br> in its static fallback content).
function replaceInner(html, openTag, closeTag, value) {
  const re = new RegExp(escapeRegExp(openTag) + "[\\s\\S]*?" + escapeRegExp(closeTag));
  return html.replace(re, openTag + value + closeTag);
}

function replaceAttr(html, prefix, suffix, value) {
  const re = new RegExp(escapeRegExp(prefix) + "[^\"]*" + escapeRegExp(suffix));
  return html.replace(re, prefix + value + suffix);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default async (request, context) => {
  const response = await context.next();

  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || !contentType.includes("text/html")) return response;

  const url = new URL(request.url);
  let soc;
  try {
    soc = await resolveSociety(url.hostname);
  } catch {
    return response;
  }
  if (!soc) return response;

  try {
    let html = await response.text();
    const name = soc.name || "Golf Society";
    const primary = soc.primary_colour || "#4B1320";
    const secondary = soc.secondary_colour || "#B8862F";
    const isLogin = url.pathname.endsWith("/login.html");

    const titleSuffix = isLogin ? "Sign in" : (soc.location || "");
    html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(name)}${titleSuffix ? " — " + esc(titleSuffix) : ""}</title>`);

    const crestSrc = soc.logo_url || placeholderCrestDataUri(soc);

    if (isLogin) {
      html = replaceAttr(html, '<img id="login-crest" src="', '"', crestSrc);
      html = replaceInner(html, '<div class="society-name" id="login-society-name">', "</div>", esc(name));
      const locBits = [soc.location, soc.founded ? `Est. ${soc.founded}` : null].filter(Boolean).join(" · ");
      html = replaceInner(html, '<div class="society-loc" id="login-society-loc">', "</div>", esc(locBits));
      // --acc drives the pills/buttons/links; the body background gradient
      // is a plain hardcoded CSS rule (not a custom property) in this file,
      // so it needs its own override rule, not just a variable. 180deg, not
      // a tilted angle — a tilted gradient reaches further down on one side
      // than the other, invisible over a full screen but very visible as a
      // left/right mismatch across the narrow iOS status bar row (same bug
      // already fixed in login.html's own CSS and applyLoginPageBranding(),
      // missed here since this inline override runs before either loads and
      // — being later in the document — wins the cascade over both).
      const style = `<style>:root{--acc:${secondary};} body{background:linear-gradient(180deg, ${primary} 0%, #000000 100%);}</style>`;
      html = html.replace("</head>", `${style}</head>`);
    } else {
      html = replaceAttr(html, '<img id="site-crest" src="', '"', crestSrc);
      html = replaceInner(html, '<h1 id="site-name">', "</h1>", esc(name));
      html = replaceInner(html, '<p id="site-location">', "</p>", esc(soc.location || ""));
      const foundedPart = soc.founded ? ` Founded ${soc.founded}.` : "";
      html = html.replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${esc(name)}${soc.location ? ", " + esc(soc.location) : ""}.${foundedPart} Events, results, committee, gallery and news.">`);
      const style = `<style>:root{--ink:${primary};--brass:${secondary};}</style>`;
      html = html.replace("</head>", `${style}</head>`);
    }

    const headers = new Headers(response.headers);
    headers.delete("content-length"); // body length changed — let the runtime recompute it
    return new Response(html, { status: response.status, headers });
  } catch {
    return response;
  }
};

export const config = { path: ["/", "/index.html", "/login.html"] };
// touch: force fresh edge instance after logo_url transparency fix 1788895869
