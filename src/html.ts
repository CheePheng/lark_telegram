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
