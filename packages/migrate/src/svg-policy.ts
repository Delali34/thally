/**
 * Allowlist policy for imported SVG files.
 *
 * An SVG served from the docs origin and opened directly is a full document:
 * script, event handlers, `javascript:` links, animations that rewrite
 * `href`, foreign HTML, and remote references all run or load there. Regular
 * expressions miss namespace prefixes and entity-encoded values, so the file
 * is parsed as XML with entities decoded. It passes only if every element and
 * attribute is on a fixed allowlist of static drawing primitives, and every
 * reference stays inside the document. Anything else, including a
 * DOCTYPE, CDATA, or a parser error, sends the file to review.
 */

import { Parser } from "htmlparser2";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";

/** Static drawing elements; no script, style, animation, link, or image. */
const ALLOWED_ELEMENTS = new Set([
  "svg", "g", "defs", "symbol", "use", "title", "desc",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "textpath",
  "lineargradient", "radialgradient", "stop",
  "clippath", "mask", "pattern", "marker",
  "filter", "feblend", "fecolormatrix", "fecomponenttransfer", "fecomposite",
  "feconvolvematrix", "fediffuselighting", "fedisplacementmap",
  "fedistantlight", "fedropshadow", "feflood", "fefunca", "fefuncb",
  "fefuncg", "fefuncr", "fegaussianblur", "femerge", "femergenode",
  "femorphology", "feoffset", "fepointlight", "fespecularlighting",
  "fespotlight", "fetile", "feturbulence",
]);

/** Geometry, paint, text, gradient, and filter attributes (lowercased). */
const ALLOWED_ATTRIBUTES = new Set([
  "xmlns", "xmlns:xlink", "xml:space", "version", "baseprofile",
  "id", "class", "viewbox", "preserveaspectratio", "width", "height",
  "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry",
  "d", "points", "pathlength", "transform", "transform-origin",
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width",
  "stroke-opacity", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset",
  "opacity", "color", "display", "visibility", "overflow",
  "clip-path", "clip-rule", "clippathunits", "mask", "maskunits",
  "maskcontentunits", "filter", "filterunits", "primitiveunits",
  "marker-start", "marker-mid", "marker-end", "markerwidth", "markerheight",
  "markerunits", "refx", "refy", "orient",
  "patternunits", "patterncontentunits", "patterntransform",
  "gradientunits", "gradienttransform", "spreadmethod", "fx", "fy", "fr",
  "offset", "stop-color", "stop-opacity",
  "font-family", "font-size", "font-weight", "font-style", "font-variant",
  "letter-spacing", "word-spacing", "text-anchor", "dominant-baseline",
  "alignment-baseline", "baseline-shift", "text-decoration", "dx", "dy",
  "rotate", "textlength", "lengthadjust", "startoffset", "writing-mode",
  "direction", "unicode-bidi", "shape-rendering", "text-rendering",
  "image-rendering", "color-interpolation", "color-interpolation-filters",
  "vector-effect", "paint-order", "mix-blend-mode", "isolation",
  "in", "in2", "result", "stddeviation", "mode", "type", "values",
  "tablevalues", "slope", "intercept", "amplitude", "exponent",
  "operator", "k1", "k2", "k3", "k4", "radius", "scale",
  "xchannelselector", "ychannelselector", "basefrequency", "numoctaves",
  "seed", "stitchtiles", "flood-color", "flood-opacity", "lighting-color",
  "surfacescale", "diffuseconstant", "specularconstant",
  "specularexponent", "kernelmatrix", "kernelunitlength", "order",
  "divisor", "bias", "targetx", "targety", "edgemode", "preservealpha",
  "azimuth", "elevation", "z", "pointsatx", "pointsaty", "pointsatz",
  "limitingconeangle", "aria-hidden", "aria-label", "role", "focusable",
  // Validated below: only in-document fragment references.
  "href", "xlink:href",
]);

/** Paint and reference values may point only at in-document fragments. */
function hasExternalReference(value: string): boolean {
  // CSS escapes can spell url()/schemes without their literal bytes. Drawing
  // attributes do not need escapes, so reject them rather than parse CSS twice.
  if (value.includes("\\")) return true;
  const compact = value.replace(/[\u0000- ]/gu, "").toLowerCase();
  if (/(?:java|vb)script:|data:|expression\(|@import|<|>/u.test(compact)) {
    return true;
  }
  for (const match of compact.matchAll(/url\(([^)]*)\)/gu)) {
    if (!/^["']?#[a-z0-9_.:-]+["']?$/u.test(match[1])) return true;
  }
  // CSS consumes an unterminated url() through EOF and browsers can still load
  // it. A balanced-match loop alone therefore misses an external paint server.
  return compact.replace(/url\(([^)]*)\)/gu, "").includes("url(");
}

/**
 * Only UTF-8 is accepted: a UTF-16/32 byte order mark or a declared
 * non-UTF-8 encoding would make browsers read different markup than the
 * policy parsed.
 */
function utf8SvgText(content: Buffer): string | null {
  const hasUtf8Bom =
    content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf;
  const body = hasUtf8Bom ? content.subarray(3) : content;
  if (
    (body[0] === 0xfe && body[1] === 0xff) ||
    (body[0] === 0xff && body[1] === 0xfe) ||
    (body[0] === 0x00 && body[1] === 0x00) ||
    body.includes(0x00)
  ) {
    return null;
  }
  const text = body.toString("utf8");
  if (text.includes("\uFFFD")) return null;
  const declaration = /^<\?xml\b[^>]*\?>/iu.exec(text);
  if (declaration) {
    const encoding = /\bencoding\s*=\s*["']([^"']*)["']/iu.exec(declaration[0]);
    if (encoding && !/^utf-?8$/iu.test(encoding[1].trim())) return null;
  } else if (/<\?xml\b/iu.test(text)) {
    // A declaration anywhere but the very start is malformed XML.
    return null;
  }
  return text;
}

/** True when an SVG uses only static, self-contained drawing features. */
export function isPassiveSvg(content: Uint8Array): boolean {
  const text = utf8SvgText(Buffer.from(content.buffer, content.byteOffset, content.byteLength));
  if (text === null) return false;
  let isPassive = true;
  let depth = 0;
  let sawRoot = false;
  // Start offsets of open elements: an implied close is legitimate only for
  // a self-closing tag (same token); otherwise the markup is malformed.
  const openStarts: Array<number> = [];
  const fail = () => {
    isPassive = false;
  };
  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const element = name.toLowerCase();
        if (depth === 0) {
          if (sawRoot || element !== "svg") fail();
          sawRoot = true;
        }
        depth += 1;
        openStarts.push(parser.startIndex);
        // Prefixed names (`s:script`) are rejected outright: the allowlist
        // is defined for the SVG namespace only.
        if (element.includes(":") || !ALLOWED_ELEMENTS.has(element)) fail();
        for (const [rawName, value] of Object.entries(attributes)) {
          const attribute = rawName.toLowerCase();
          if (!ALLOWED_ATTRIBUTES.has(attribute)) {
            fail();
            continue;
          }
          if (attribute === "xmlns" && value !== SVG_NAMESPACE) fail();
          if (attribute === "xmlns:xlink" && value !== XLINK_NAMESPACE) fail();
          if (
            (attribute === "href" || attribute === "xlink:href") &&
            !/^#[A-Za-z0-9_.:-]+$/u.test(value.trim())
          ) {
            fail();
          }
          if (hasExternalReference(value)) fail();
        }
      },
      onclosetag(_name, isImplied) {
        depth -= 1;
        const start = openStarts.pop();
        if (isImplied && start !== parser.startIndex) fail();
      },
      // DOCTYPE (and with it custom entities) or any other declaration other
      // than the XML prolog.
      onprocessinginstruction(name) {
        if (name.toLowerCase() !== "?xml") fail();
      },
      oncdatastart: fail,
      ontext(value) { if (depth === 0 && value.trim()) fail(); },
      onerror: fail,
    },
    { xmlMode: true, decodeEntities: true, recognizeSelfClosing: true },
  );
  try {
    parser.write(text);
    parser.end();
  } catch {
    return false;
  }
  return isPassive && sawRoot && depth === 0;
}
