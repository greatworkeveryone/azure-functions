export interface WpPostPayload {
  title: string;
  excerpt: string;
  content: string;
  status: "publish" | "draft";
  featured_media: number | null;
}

/** Converts ^N notation to HTML superscript, e.g. "m^2" → "m<sup>2</sup>". */
function applyMarkup(text: string): string {
  return text.replace(/\^(\d+)/g, "<sup>$1</sup>");
}

/** Wraps text in <p> tags, splitting on blank lines and converting single
 *  newlines to <br> so line breaks survive the WordPress round-trip. */
function textToHtmlParagraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${applyMarkup(para).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

export function buildWpContent(
  description: string | null,
  additionalDetails: string[],
): string {
  const parts: string[] = [];
  if (description) parts.push(textToHtmlParagraphs(description));
  if (additionalDetails.length > 0) {
    const items = additionalDetails.map((d) => `<li>${applyMarkup(d)}</li>`).join("\n");
    parts.push(`<ul>\n${items}\n</ul>`);
  }
  return parts.join("\n\n");
}

export function buildWpPayload(
  title: string,
  buildingName: string | null,
  description: string | null,
  additionalDetails: string[],
  featuredMediaId: number | null,
): WpPostPayload {
  return {
    content: buildWpContent(description, additionalDetails),
    excerpt: buildingName ?? "",
    featured_media: featuredMediaId,
    status: "publish",
    title,
  };
}
