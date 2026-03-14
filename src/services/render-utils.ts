export const escapeXml = (value: string): string =>
  value.replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

export const uniqueValues = (values: string[], limit: number): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = value.trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
    if (result.length >= limit) break;
  }
  return result;
};

const fitEscapedText = (value: string, maxEscapedLength: number): string => {
  const source = value.trim();
  if (!source || maxEscapedLength <= 0) return "";
  if (escapeXml(source).length <= maxEscapedLength) return source;

  let low = 0;
  let high = source.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (escapeXml(source.slice(0, mid)).length <= maxEscapedLength) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return source.slice(0, low).trimEnd();
};

export interface RenderXmlListSectionOptions {
  itemCharLimit?: number;
  remaining?: number;
  includeEmpty?: boolean;
}

export const renderXmlListSection = (
  tag: string,
  itemTag: string,
  values: string[],
  options: RenderXmlListSectionOptions = {},
): string => {
  const { itemCharLimit, remaining, includeEmpty = false } = options;
  const open = `<${tag}>`;
  const close = `</${tag}>`;

  if (remaining !== undefined && open.length + close.length > remaining) {
    return "";
  }

  let body = "";
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;

    const limited = itemCharLimit
      ? normalized.slice(0, itemCharLimit)
      : normalized;
    const itemOpen = `<${itemTag}>`;
    const itemClose = `</${itemTag}>`;
    const content = remaining === undefined ? limited : fitEscapedText(
      limited,
      remaining - open.length - close.length - body.length - itemOpen.length -
        itemClose.length,
    );
    if (!content) break;

    body += `${itemOpen}${escapeXml(content)}</${itemTag}>`;
  }

  if (!body) return includeEmpty ? `${open}${close}` : "";
  return `${open}${body}${close}`;
};

export interface RenderXmlSingleSectionOptions {
  valueCharLimit?: number;
  remaining?: number;
}

export const renderXmlSingleSection = (
  tag: string,
  itemTag: string,
  value: string | undefined,
  options: RenderXmlSingleSectionOptions = {},
): string => {
  if (!value) return "";

  const { valueCharLimit, remaining } = options;
  const normalized = value.trim();
  if (!normalized) return "";

  const limited = valueCharLimit
    ? normalized.slice(0, valueCharLimit)
    : normalized;
  const open = `<${tag}><${itemTag}>`;
  const close = `</${itemTag}></${tag}>`;
  const content = remaining === undefined
    ? limited
    : fitEscapedText(limited, remaining - open.length - close.length);
  if (!content) return "";

  const section = `${open}${escapeXml(content)}${close}`;
  return remaining === undefined || section.length <= remaining ? section : "";
};
