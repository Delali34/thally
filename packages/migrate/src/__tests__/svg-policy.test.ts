/** Parsed, allowlisted SVG policy, including the review's bypass payloads. */

import { describe, expect, it } from "vitest";

import { isPassiveSvg } from "../svg-policy.js";

const svg = (body: string, attributes = 'xmlns="http://www.w3.org/2000/svg"') =>
  Buffer.from(`<svg ${attributes} viewBox="0 0 24 24">${body}</svg>`);

describe("isPassiveSvg", () => {
  it("allows static drawing with in-document references", () => {
    expect(
      isPassiveSvg(
        Buffer.from(
          '<?xml version="1.0" encoding="UTF-8"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs><title>Acme</title><path d="M0 0h10" fill="url(#g)"/><use xlink:href="#g"/><text x="1" y="2">Acme &amp; Co</text></svg>',
        ),
      ),
    ).toBe(true);
  });

  it.each([
    ["namespace-prefixed script", '<s:script xmlns:s="http://www.w3.org/2000/svg">alert(1)</s:script>'],
    ["entity-encoded javascript href", '<a href="&#106;avascript:alert(1)"><path d="M0 0"/></a>'],
    ["entity-encoded use href", '<use href="&#106;avascript:alert(1)"/>'],
    ["animate rewriting href", '<animate attributeName="href" values="javascript:alert(1)"/>'],
    ["set rewriting href", '<set attributeName="xlink:href" to="javascript:alert(1)"/>'],
    ["script", "<script>alert(1)</script>"],
    ["foreignObject", "<foreignObject><div>x</div></foreignObject>"],
    ["event handler", '<path d="M0 0" onclick="alert(1)"/>'],
    ["external image", '<image href="https://evil.example/x.png"/>'],
    ["external use", '<use href="https://evil.example/s.svg#a"/>'],
    ["style element", "<style>@import url(https://evil.example/a.css)</style>"],
    ["inline style attribute", '<path style="fill:url(https://evil.example/a)"/>'],
    ["remote paint", '<path fill="url(https://evil.example/#a)"/>'],
    ["CSS EOF-closes remote paint URL", '<path fill="url(https://evil.example/#a"/>'],
    ["CSS EOF-closes transitive filter URL", '<use href="#a"/><defs><path id="a" filter="url(https://evil.example/filter.svg#f"/></defs>'],
    ["CSS escaped URL function", '<path fill="u\\72l(https://evil.example/#a)"/>'],
    ["entity alias to remote use", '<use href="#local"/><defs><use id="local" href="&#104;ttps://evil.example/s.svg#a"/></defs>'],
    ["transitive image", '<use href="#a"/><defs><g id="a"><use href="#b"/></g><g id="b"><image href="https://evil.example/x.png"/></g></defs>'],
    ["transitive CSS escape", '<use href="#a"/><defs><path id="a" fill="u\\000072l(https://evil.example/a)"/></defs>'],
    ["CDATA", "<text><![CDATA[x]]></text>"],
  ])("rejects %s", (_name, body) => {
    expect(isPassiveSvg(svg(body))).toBe(false);
  });

  it("rejects doctype entities, foreign namespaces, and non-SVG roots", () => {
    expect(
      isPassiveSvg(
        Buffer.from('<!DOCTYPE svg [<!ENTITY x "javascript:alert(1)">]><svg xmlns="http://www.w3.org/2000/svg"><path d="&x;"/></svg>'),
      ),
    ).toBe(false);
    expect(isPassiveSvg(svg("", 'xmlns="http://www.w3.org/1999/xhtml"'))).toBe(false);
    expect(isPassiveSvg(Buffer.from("<html><body/></html>"))).toBe(false);
    expect(isPassiveSvg(Buffer.from("<svg><g></svg>"))).toBe(false);
    expect(isPassiveSvg(Buffer.from('<svg/>unexpected text'))).toBe(false);
  });
});

describe("SVG encoding", () => {
  const body = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
  it("accepts UTF-8 with or without a declaration or BOM", () => {
    expect(isPassiveSvg(Buffer.from(body))).toBe(true);
    expect(isPassiveSvg(Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>${body}`))).toBe(true);
    expect(isPassiveSvg(Buffer.from(`<?xml version="1.0" encoding="utf8"?>${body}`))).toBe(true);
    expect(isPassiveSvg(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body)]))).toBe(true);
  });

  it.each([
    ["UTF-16 declaration", Buffer.from(`<?xml version="1.0" encoding="UTF-16"?>${body}`)],
    ["UTF-7 declaration", Buffer.from(`<?xml version="1.0" encoding="utf-7"?>${body}`)],
    ["ISO-8859-1 declaration", Buffer.from(`<?xml version="1.0" encoding="ISO-8859-1"?>${body}`)],
    ["UTF-16LE BOM", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, "utf16le")])],
    ["UTF-16BE BOM", Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(body, "utf16le").swap16()])],
    ["late declaration", Buffer.from(`${body}<?xml version="1.0"?>`)],
  ])("rejects %s", (_name, content) => {
    expect(isPassiveSvg(content)).toBe(false);
  });
});
