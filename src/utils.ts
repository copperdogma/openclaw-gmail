export function parseEmailAddress(fromHeader: string): string {
  const m = fromHeader.match(/<([^>]+)>/);
  const email = (m?.[1] ?? fromHeader).trim();
  return email.toLowerCase();
}

export function headerValue(headers: any[] | undefined, name: string): string {
  const n = name.toLowerCase();
  const h = (headers ?? []).find((x) => String(x?.name ?? "").toLowerCase() === n);
  return String(h?.value ?? "");
}

export function decodeB64Url(s: string): string {
  try {
    const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
    return Buffer.from(normalized + pad, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function stripHtml(html: string): string {
  let text = html;
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/&nbsp;/gi, " ");
  text = text.replace(/&amp;/gi, "&");
  text = text.replace(/&lt;/gi, "<");
  text = text.replace(/&gt;/gi, ">");
  text = text.replace(/&quot;/gi, '"');
  text = text.replace(/&#39;/gi, "'");
  text = text.replace(/&#(\d+);/g, (_, n) => {
    try { return String.fromCharCode(Number(n)); } catch { return ""; }
  });
  text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, n) => {
    try { return String.fromCharCode(parseInt(n, 16)); } catch { return ""; }
  });
  text = text.replace(/[\t\r]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export function extractBody(payload: any): string {
  if (!payload) return "";
  // Prefer direct body.data
  const data = payload?.body?.data;
  if (typeof data === "string" && data.trim()) return decodeB64Url(data.trim());

  // Otherwise traverse parts and prefer text/plain, then text/html
  const parts: any[] = Array.isArray(payload?.parts) ? payload.parts : [];
  let html = "";
  for (const part of parts) {
    const mime = String(part?.mimeType ?? "").toLowerCase();
    const pData = part?.body?.data;
    if (typeof pData !== "string" || !pData.trim()) continue;
    const decoded = decodeB64Url(pData.trim());
    if (!decoded) continue;
    if (mime === "text/plain") return decoded;
    if (mime === "text/html" && !html) html = decoded;
  }
  return html ? stripHtml(html) : "";
}
