import { describe, expect, it } from "vitest";
import { createWebFetcher, isBlockedAddress, type FetchTransport, type LookupFn } from "../src/tools/web-fetch.js";
import { htmlToMarkdown } from "../src/tools/html-to-markdown.js";

const PUBLIC = "93.184.216.34";
const publicLookup: LookupFn = async () => [{ address: PUBLIC, family: 4 }];

function body(text: string | Uint8Array[]): AsyncIterable<Uint8Array> {
  const chunks = typeof text === "string" ? [new TextEncoder().encode(text)] : text;
  return (async function* () {
    for (const c of chunks) yield c;
  })();
}

function respond(status: number, headers: Record<string, string>, content: string | Uint8Array[] = ""): Awaited<ReturnType<FetchTransport>> {
  return { status, headers, body: body(content), destroy() {} };
}

function setup(handler: (url: URL, n: number) => ReturnType<typeof respond>, lookup: LookupFn = publicLookup, extra: object = {}) {
  const calls: { url: string; address: string; headers: Record<string, string> }[] = [];
  const transport: FetchTransport = async (url, opts) => {
    calls.push({ url: url.toString(), address: opts.address, headers: opts.headers });
    return handler(url, calls.length);
  };
  return { calls, fetchPage: createWebFetcher({ lookup, transport, ...extra }) };
}

const html = (s: string) => respond(200, { "content-type": "text/html; charset=utf-8" }, s);

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "::1", "::", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "64:ff9b::a00:1", "2002:7f00:1::", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "64:ff9b:1::a00:1",
  ])("blocks %s", (a) => expect(isBlockedAddress(a)).toBe(true));
  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows %s", (a) => expect(isBlockedAddress(a)).toBe(false));
});

describe("web_fetch guards", () => {
  it.each([
    "http://localhost/x", "http://foo.localhost/", "http://metadata.google.internal/", "http://svc.internal/", "http://127.0.0.1/", "http://[::1]/",
    "http://169.254.169.254/latest/meta-data", "http://[::ffff:127.0.0.1]/", "http://2130706433/", "http://0x7f.1/", "http://10.0.0.5:8080/", "file:///etc/passwd", "ftp://example.com/",
  ])("blocks %s without connecting", async (url) => {
    const { fetchPage, calls } = setup(() => html("x"));
    await expect(fetchPage(url)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("blocks hostnames resolving to private addresses (any record)", async () => {
    const { fetchPage, calls } = setup(() => html("x"), async () => [{ address: PUBLIC, family: 4 }, { address: "10.0.0.1", family: 4 }]);
    await expect(fetchPage("https://evil.example/")).rejects.toThrow(/non-public/);
    expect(calls).toHaveLength(0);
  });

  it("pins the connection to the validated IP and sends no cookies or auth", async () => {
    const { fetchPage, calls } = setup(() => html("<p>hi</p>"));
    await fetchPage("https://example.com/");
    expect(calls[0]!.address).toBe(PUBLIC);
    expect(Object.keys(calls[0]!.headers).map((k) => k.toLowerCase())).not.toEqual(expect.arrayContaining(["cookie", "authorization"]));
    expect(calls[0]!.headers["user-agent"]).toMatch(/web-fetch/);
  });

  it("follows redirects and re-checks each hop", async () => {
    const { fetchPage, calls } = setup((url) =>
      url.pathname === "/a" ? respond(302, { location: "/b" }) : url.pathname === "/b" ? respond(301, { location: "http://169.254.169.254/latest" }) : html("secret"),
    );
    await expect(fetchPage("https://example.com/a")).rejects.toThrow(/Blocked address/);
    expect(calls.map((c) => c.url)).toEqual(["https://example.com/a", "https://example.com/b"]);
  });

  it("returns the final URL after a safe redirect", async () => {
    const { fetchPage } = setup((url) => (url.pathname === "/a" ? respond(302, { location: "/b" }) : html("<title>T</title><p>ok</p>")));
    const r = await fetchPage("https://example.com/a");
    expect(r.finalUrl).toBe("https://example.com/b");
    expect(r.title).toBe("T");
  });

  it("limits redirects to 5", async () => {
    const { fetchPage, calls } = setup(() => respond(302, { location: "/loop" }));
    await expect(fetchPage("https://example.com/loop")).rejects.toThrow(/Too many redirects/);
    expect(calls).toHaveLength(6);
  });

  it("enforces the size limit while streaming", async () => {
    const big = Array.from({ length: 5 }, () => new Uint8Array(1000));
    const { fetchPage } = setup(() => respond(200, { "content-type": "text/plain" }, big), publicLookup, { maxBytes: 3000 });
    await expect(fetchPage("https://example.com/")).rejects.toThrow(/too large/);
  });

  it("rejects an oversized content-length up front", async () => {
    const { fetchPage } = setup(() => respond(200, { "content-type": "text/plain", "content-length": "99999999" }, "x"));
    await expect(fetchPage("https://example.com/")).rejects.toThrow(/too large/);
  });

  it("times out", async () => {
    const transport: FetchTransport = (_u, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const fetchPage = createWebFetcher({ lookup: publicLookup, transport, timeoutMs: 20 });
    await expect(fetchPage("https://example.com/")).rejects.toThrow(/Timed out/);
  });

  it("refuses binaries and PDFs, allows json/xml/markdown", async () => {
    for (const [type, ok] of [["image/png", false], ["application/octet-stream", false], ["application/json", true], ["application/xml", true], ["text/markdown", true]] as const) {
      const { fetchPage } = setup(() => respond(200, { "content-type": type }, "{}"));
      if (ok) await expect(fetchPage(`https://example.com/${type}`)).resolves.toBeTruthy();
      else await expect(fetchPage(`https://example.com/${type}`)).rejects.toThrow(/Unsupported content type/);
    }
    const { fetchPage } = setup(() => respond(200, { "content-type": "application/pdf" }, "%PDF"));
    await expect(fetchPage("https://example.com/a.pdf")).rejects.toThrow("PDF not supported");
  });

  it("errors on HTTP failures", async () => {
    const { fetchPage } = setup(() => respond(404, {}));
    await expect(fetchPage("https://example.com/")).rejects.toThrow(/HTTP 404/);
  });

  it("redacts secrets in output", async () => {
    const { fetchPage } = setup(() => respond(200, { "content-type": "text/plain" }, "key sk-ant-abcdefghijklmnop end"));
    const r = await fetchPage("https://example.com/");
    expect(r.slice).not.toContain("sk-ant-abcdefghijklmnop");
  });

  it("pages with start_char and reports truncation", async () => {
    const { fetchPage } = setup(() => respond(200, { "content-type": "text/plain" }, "abcdefghij"));
    const first = await fetchPage("https://example.com/", { maxChars: 4 });
    expect(first).toMatchObject({ slice: "abcd", truncated: true, nextStart: 4, total: 10 });
    const second = await fetchPage("https://example.com/", { startChar: first.nextStart, maxChars: 100 });
    expect(second).toMatchObject({ slice: "efghij", truncated: false });
  });

  it("caches by URL for 10 minutes", async () => {
    let t = 1000;
    const { fetchPage, calls } = setup(() => respond(200, { "content-type": "text/plain" }, "x"), publicLookup, { now: () => t });
    await fetchPage("https://example.com/");
    t += 9 * 60_000;
    expect((await fetchPage("https://example.com/")).cached).toBe(true);
    expect(calls).toHaveLength(1);
    t += 2 * 60_000;
    expect((await fetchPage("https://example.com/")).cached).toBe(false);
    expect(calls).toHaveLength(2);
  });
});

describe("htmlToMarkdown", () => {
  const page = `<!doctype html><html><head><title>My &amp; Page</title><style>p{color:red}</style></head><body>
    <header>SITE HEADER</header><nav><a href="/x">NAV</a></nav>
    <main><h1>Title</h1><p>Hello <strong>world</strong>, see <a href="/docs/a?x=1">docs</a> and <a href="javascript:void(0)">js</a>.</p>
    <h2>List</h2><ul><li>one</li><li>two <code>x()</code></li></ul><ol><li>a</li><li>b</li></ol>
    <pre><code>const a = 1;\n  if (a) { b(); }</code></pre>
    <table><tr><th>K</th><th>V</th></tr><tr><td>a</td><td>1</td></tr></table>
    <script>var secret = "<p>no</p>";</script><svg><text>SVG</text></svg><noscript>NOSCRIPT</noscript></main>
    <aside>SIDEBAR</aside><footer>FOOTER</footer></body></html>`;
  const { title, markdown } = htmlToMarkdown(page, "https://example.com/base/");

  it("extracts title and prefers main", () => {
    expect(title).toBe("My & Page");
    for (const dropped of ["SITE HEADER", "NAV", "SIDEBAR", "FOOTER", "SVG", "NOSCRIPT", "color:red", "secret"]) expect(markdown).not.toContain(dropped);
  });
  it("keeps headings, emphasis, absolute links", () => {
    expect(markdown).toContain("# Title");
    expect(markdown).toContain("## List");
    expect(markdown).toContain("**world**");
    expect(markdown).toContain("[docs](https://example.com/docs/a?x=1)");
    expect(markdown).not.toContain("javascript:");
  });
  it("renders lists, code blocks and tables", () => {
    expect(markdown).toMatch(/- one\n- two `x\(\)`/);
    expect(markdown).toMatch(/1\. a\n2\. b/);
    expect(markdown).toContain("```\nconst a = 1;\n  if (a) { b(); }\n```");
    expect(markdown).toContain("| K | V |\n| --- | --- |\n| a | 1 |");
  });
  it("collapses whitespace and decodes entities", () => {
    const r = htmlToMarkdown("<p>a   \n  b &lt;c&gt; &#65;</p>\n\n\n<p>d</p>", "https://e.com/");
    expect(r.markdown).toBe("a b <c> A\n\nd");
  });
});
