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

/** Convert Fin's HTML to Lark Markdown (`lark_md`): <b>→**bold**, <a href>Title</a>→[Title](URL)
 *  (empty-label links like inline citations are dropped), block tags → newlines. */
export function htmlToLarkMd(html: string): string {
  if (!html) return "";
  let t = html;
  t = t.replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag, inner) => `**${stripTags(inner).trim()}**`);
  t = t.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, url, label) => {
    const clean = stripTags(label).trim();
    return clean ? `[${clean}](${url})` : ""; // drop empty citations (no label)
  });
  t = t.replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<li[^>]*>/gi, "• ");
  t = stripTags(t);
  t = decodeEntities(t);
  return t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export interface FinAnswer {
  text: string; // plain text (Telegram caption / fallback), citations + Source(s) + images removed
  textMd: string; // Lark Markdown (lark_md) version of the same body
  imageUrls: string[]; // inline image URLs, entity-decoded
  sources: Array<{ label: string; url: string }>; // ALL labelled links from the Source(s) section
}

/** Split a Fin answer's HTML into parts for a single combined message: body (plain + lark_md),
 *  image URLs, and ALL "Source(s)" links (deduped). Empty inline citations are dropped so no raw
 *  URLs leak into the body. Handles both "Source:" and "Sources:". */
export function parseFinAnswer(html: string): FinAnswer {
  const imageUrls = extractImageUrls(html);

  // Pull the trailing "Source(s):" paragraph and every labelled link inside it.
  const sources: Array<{ label: string; url: string }> = [];
  const seen = new Set<string>();
  const block = /<p>(?:(?!<\/p>)[\s\S])*?Sources?:[\s\S]*?<\/p>/i.exec(html);
  if (block) {
    const re = /<a[^>]*href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block[0])) !== null) {
      const url = decodeEntities(m[1]);
      if (!seen.has(url)) {
        seen.add(url);
        sources.push({ url, label: decodeEntities(m[2]).trim() });
      }
    }
  }

  // Body = html minus images, minus empty citations, minus the Source(s) paragraph.
  let frag = html.replace(/<img[^>]*>/gi, "").replace(/<a\b[^>]*>\s*<\/a>/gi, "");
  if (block) frag = frag.replace(block[0], "");

  return { text: htmlToPlainText(frag), textMd: htmlToLarkMd(frag), imageUrls, sources };
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
