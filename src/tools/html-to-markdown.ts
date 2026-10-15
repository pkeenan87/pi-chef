// Small hand-written HTML -> markdown converter for web_fetch. Not a full HTML parser: it tokenises
// tags, drops non-content subtrees, prefers <main>/<article>, and renders a readable subset.

export interface MarkdownResult {
  title: string;
  markdown: string;
}

const DROP = new Set(["script", "style", "nav", "footer", "header", "aside", "noscript", "svg", "iframe", "template", "head"]);
const BLOCK = new Set(["p", "div", "section", "article", "main", "form", "fieldset", "figure", "figcaption", "details", "summary", "dl", "dt", "dd", "address"]);

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", copy: "©", laquo: "«", raquo: "»", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      return String.fromCodePoint(code);
    }
    return NAMED[body.toLowerCase()] ?? match;
  });
}

type Token = { kind: "text"; text: string } | { kind: "open" | "close"; name: string; attrs: string };

function tokenize(html: string): Token[] {
  const source = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<!(?!-)[^>]*>/g, "");
  const tokens: Token[] = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    if (match.index > last) tokens.push({ kind: "text", text: source.slice(last, match.index) });
    const name = match[2]!.toLowerCase();
    tokens.push({ kind: match[1] ? "close" : "open", name, attrs: match[3] ?? "" });
    last = re.lastIndex;
    // Raw-text elements: skip content verbatim so "<" inside scripts cannot confuse the tokenizer.
    if (!match[1] && (name === "script" || name === "style")) {
      const end = new RegExp(`</${name}\\s*>`, "i");
      const rest = source.slice(last);
      const found = end.exec(rest);
      const stop = found ? found.index : rest.length;
      last += stop;
      re.lastIndex = last;
    }
  }
  if (last < source.length) tokens.push({ kind: "text", text: source.slice(last) });
  return tokens;
}

function attr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const m = re.exec(attrs);
  const value = m ? (m[1] ?? m[2] ?? m[3]) : undefined;
  return value === undefined ? undefined : decodeEntities(value);
}

function dropSubtrees(tokens: Token[]): Token[] {
  const out: Token[] = [];
  let skip: string | undefined;
  let depth = 0;
  for (const token of tokens) {
    if (skip) {
      if (token.kind !== "text" && token.name === skip) {
        if (token.kind === "open") depth += 1;
        else if (--depth === 0) skip = undefined;
      }
      continue;
    }
    if (token.kind === "open" && DROP.has(token.name) && token.name !== "head") {
      skip = token.name;
      depth = 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

function pickMain(tokens: Token[]): Token[] {
  for (const name of ["main", "article"]) {
    const start = tokens.findIndex((t) => t.kind === "open" && t.name === name);
    if (start < 0) continue;
    let depth = 0;
    for (let i = start; i < tokens.length; i++) {
      const t = tokens[i]!;
      if (t.kind === "text" || t.name !== name) continue;
      depth += t.kind === "open" ? 1 : -1;
      if (depth === 0) return tokens.slice(start + 1, i);
    }
    return tokens.slice(start + 1);
  }
  return tokens;
}

function absolute(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#") || /^(javascript|data|mailto|tel):/i.test(trimmed)) return undefined;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return undefined;
  }
}

export function htmlToMarkdown(html: string, baseUrl: string): MarkdownResult {
  const all = tokenize(html);
  let title = "";
  for (let i = 0; i < all.length; i++) {
    const t = all[i]!;
    if (t.kind === "open" && t.name === "title") {
      const next = all[i + 1];
      if (next?.kind === "text") title = decodeEntities(next.text).replace(/\s+/g, " ").trim();
      break;
    }
  }
  const tokens = pickMain(dropSubtrees(all));

  let out = "";
  const lists: { ordered: boolean; n: number }[] = [];
  const links: (string | undefined)[] = [];
  let pre = 0;
  let cellStart = -1;
  let row: string[] = [];
  let rowHasTh = false;
  let tableRows = 0;
  let inTitle = false;
  const block = (gap = "\n\n") => {
    if (out.length === 0) return;
    out = out.replace(/[ \t]+$/, "");
    if (gap === "\n\n") out = out.replace(/\n*$/, "\n\n");
    else if (!out.endsWith("\n")) out += "\n";
  };

  for (const token of tokens) {
    if (token.kind === "text") {
      if (inTitle) continue;
      const decoded = decodeEntities(token.text);
      if (pre > 0) out += decoded;
      else {
        const collapsed = decoded.replace(/\s+/g, " ");
        out += /\s$/.test(out) || out.length === 0 ? collapsed.replace(/^ /, "") : collapsed;
      }
      continue;
    }
    const { name } = token;
    if (token.kind === "open") {
      if (name === "title") inTitle = true;
      else if (/^h[1-6]$/.test(name)) {
        block();
        out += `${"#".repeat(Number(name[1]))} `;
      } else if (name === "br") out += pre > 0 ? "\n" : "  \n";
      else if (name === "hr") {
        block();
        out += "---\n\n";
      } else if (name === "ul" || name === "ol") {
        if (lists.length === 0) block();
        lists.push({ ordered: name === "ol", n: 0 });
      } else if (name === "li") {
        const list = lists[lists.length - 1];
        block("\n");
        out += `${"  ".repeat(Math.max(0, lists.length - 1))}${list?.ordered ? `${++list.n}. ` : "- "}`;
      } else if (name === "a") {
        const href = absolute(attr(token.attrs, "href"), baseUrl);
        links.push(href);
        if (href) out += "[";
      } else if (name === "pre") {
        block();
        out += "```\n";
        pre += 1;
      } else if (name === "code") {
        if (pre === 0) out += "`";
      } else if (name === "strong" || name === "b") out += "**";
      else if (name === "em" || name === "i") out += "*";
      else if (name === "blockquote") {
        block();
        out += "> ";
      } else if (name === "table") {
        block();
        tableRows = 0;
      } else if (name === "tr") {
        row = [];
        rowHasTh = false;
      } else if (name === "td" || name === "th") {
        if (name === "th") rowHasTh = true;
        cellStart = out.length;
      } else if (name === "img") {
        const alt = attr(token.attrs, "alt");
        if (alt) out += alt;
      } else if (BLOCK.has(name) || name === "tbody" || name === "thead") block();
      continue;
    }
    // close
    if (name === "title") inTitle = false;
    else if (/^h[1-6]$/.test(name)) block();
    else if (name === "ul" || name === "ol") {
      lists.pop();
      if (lists.length === 0) block();
    } else if (name === "a") {
      const href = links.pop();
      if (href) out += `](${href})`;
    } else if (name === "pre") {
      pre = Math.max(0, pre - 1);
      out = out.replace(/\n*$/, "\n") + "```\n\n";
    } else if (name === "code") {
      if (pre === 0) out += "`";
    } else if (name === "strong" || name === "b") out += "**";
    else if (name === "em" || name === "i") out += "*";
    else if (name === "td" || name === "th") {
      if (cellStart >= 0) {
        row.push(out.slice(cellStart).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim());
        out = out.slice(0, cellStart);
        cellStart = -1;
      }
    } else if (name === "tr") {
      if (row.length > 0) {
        out += `| ${row.join(" | ")} |\n`;
        if (tableRows === 0 && rowHasTh) out += `|${row.map(() => " --- ").join("|")}|\n`;
        tableRows += 1;
      }
    } else if (name === "table") block();
    else if (name === "p" || name === "blockquote" || BLOCK.has(name)) block();
    else if (name === "li") block("\n");
  }

  const markdown = out
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, markdown };
}
