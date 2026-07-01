/**
 * Convert the HTML body Fin returns into plain text suitable for a Telegram
 * message. Telegram supports a limited HTML subset, but plain text is the most
 * robust choice for a demo. Swap to Telegram HTML parse_mode later if desired.
 */
export function htmlToPlainText(html: string): string {
  if (!html) return "";
  let text = html;

  // Links: <a href="URL">label</a> -> "label (URL)"
  text = text.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gis, (_m, url, label) => {
    const clean = stripTags(label).trim();
    return clean && clean !== url ? `${clean} (${url})` : url;
  });

  // Block / break elements -> newlines
  text = text.replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<li[^>]*>/gi, "• ");

  // Drop all remaining tags
  text = stripTags(text);

  // Decode common entities
  text = decodeEntities(text);

  // Collapse excess whitespace
  text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return text;
}

/** Pull <img src> URLs out of Fin's HTML reply (entity-decoded) so we can relay
 *  images to Telegram/Lark separately from the plain-text body. */
export function extractImageUrls(html: string): string[] {
  if (!html) return [];
  const urls: string[] = [];
  const re = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    urls.push(decodeEntities(m[1]));
  }
  return urls;
}

export interface FinAnswer {
  text: string; // main answer text (images, empty citations, and the Source line removed)
  imageUrls: string[]; // inline image URLs, entity-decoded
  source: { label: string; url: string } | null; // labelled "Source" link, if present
}

/** Split a Fin answer's HTML into card-friendly parts (to render ONE Lark card instead of
 *  separate text + image messages): main text, image URLs, and the labelled Source link. */
export function parseFinAnswer(html: string): FinAnswer {
  const imageUrls = extractImageUrls(html);

  let source: { label: string; url: string } | null = null;
  const sm = /Source:\s*(?:<br\s*\/?>\s*)*<a[^>]*href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/i.exec(html);
  if (sm) source = { url: decodeEntities(sm[1]), label: decodeEntities(sm[2]).trim() };

  const stripped = html
    .replace(/<img[^>]*>/gi, "") // images become card img elements
    .replace(/<a\b[^>]*class="[^"]*inline-citation[^"]*"[^>]*>\s*<\/a>/gi, "") // empty inline citations
    .replace(/<p>(?:(?!<\/p>)[\s\S])*?Source:[\s\S]*?<\/p>/i, ""); // Source becomes its own element

  return { text: htmlToPlainText(stripped), imageUrls, source };
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}
