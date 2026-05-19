export interface WpPostPayload {
  title: string;
  excerpt: string;
  content: string;
  status: "publish" | "draft";
  featured_media: number | null;
}

export function buildWpContent(
  description: string | null,
  additionalDetails: string[],
): string {
  const parts: string[] = [];
  if (description) parts.push(`<p>${description}</p>`);
  if (additionalDetails.length > 0) {
    const items = additionalDetails.map((d) => `<li>${d}</li>`).join("\n");
    parts.push(`<ul>\n${items}\n</ul>`);
  }
  return parts.join("\n\n");
}

export function buildWpPayload(
  title: string,
  subtitle: string | null,
  description: string | null,
  additionalDetails: string[],
  featuredMediaId: number | null,
): WpPostPayload {
  return {
    content: buildWpContent(description, additionalDetails),
    excerpt: subtitle ?? "",
    featured_media: featuredMediaId,
    status: "publish",
    title,
  };
}
