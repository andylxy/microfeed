import {describe, expect, it} from "vitest";

import {renderTcmMarkers, type TcmMarkerStyle} from "@/shared/TcmMarkers";

const STYLES: TcmMarkerStyle[] = [
  {code: "u", color: "#0000FF", smallFont: false, linkType: 1},
  {code: "f", color: "#0000FF", smallFont: false, linkType: 2},
  {code: "g", color: "rgba(0, 128, 255, 0.90)", smallFont: false, linkType: 3},
  {code: "w", color: "#1CB55C", smallFont: true, linkType: 0},
  {code: "a", color: "#808080", smallFont: true, linkType: 0},
  {code: "m", color: "#FF0000", smallFont: false, linkType: 0},
  {code: "x", color: "#EA8E3B", smallFont: false, linkType: 0},
];

const HREFS = {
  1: (name: string) => `/yao/${encodeURIComponent(name)}`,
  2: (name: string) => `/fang/${encodeURIComponent(name)}`,
  3: (name: string) => `/term/${encodeURIComponent(name)}`,
};

function render(body: string): string {
  return renderTcmMarkers(body, STYLES, {resolveHref: (t, n) => HREFS[t as 1 | 2 | 3]?.(n)});
}

describe("renderTcmMarkers", () => {
  it("renders a colour span; small-font markers add the 0.7em rule", () => {
    expect(render("$u{桂枝}")).toBe(
      '<a href="/yao/%E6%A1%82%E6%9E%9D"><span class="mf-mk mf-mk-u" ' +
      'style="color:#0000FF" data-tcm-kind="1" data-tcm-name="桂枝">桂枝</span></a>',
    );
    expect(render("$w{三两}")).toBe(
      '<span class="mf-mk mf-mk-w" style="color:#1CB55C;font-size:0.7em">三两</span>',
    );
  });

  it("linkable markers become anchors through the resolver", () => {
    expect(render("$f{桂枝汤}")).toBe(
      '<a href="/fang/%E6%A1%82%E6%9E%9D%E6%B1%A4">' +
      '<span class="mf-mk mf-mk-f" style="color:#0000FF" data-tcm-kind="2" ' +
      'data-tcm-name="桂枝汤">桂枝汤</span></a>',
    );
  });

  it("without a resolver, linkable markers fall back to data attributes", () => {
    const html = renderTcmMarkers("$u{桂枝}", STYLES);
    expect(html).toContain('data-tcm-kind="1"');
    expect(html).toContain('data-tcm-name="桂枝"');
    expect(html).not.toContain("<a ");
  });

  it("renders nested markers recursively (the old app rendered these literally)", () => {
    const html = render("$a{$q{《千金》}校语}");
    expect(html).toContain('class="mf-mk mf-mk-a"');
    expect(html).toContain('class="mf-mk mf-mk-unknown"');
    expect(html).toContain("《千金》");
    expect(html).toContain("校语");
    expect(html).not.toContain("$q{");
  });

  it("keeps malformed markers instead of dropping text ($m{{虚者})", () => {
    const html = render("前文$m{{虚者}后文");
    expect(html).toContain("前文");
    expect(html).toContain("后文");
    expect(html).toContain("{虚者");
    expect(html).not.toContain("$m{");
  });

  it("strips the shell of unknown markers into a grey span", () => {
    expect(render("$z{神秘}")).toBe(
      '<span class="mf-mk mf-mk-unknown" style="color:#808080">神秘</span>',
    );
  });

  it("returns the body unchanged when no styles are loaded", () => {
    const body = "<p>$u{桂枝}</p>";
    expect(renderTcmMarkers(body, [])).toBe(body);
  });

  it("leaves HTML tags verbatim — marker syntax inside attributes stays intact", () => {
    const body = '<a href="/x/$u{桂枝}">link</a>';
    expect(render(body)).toBe(body);
  });

  it("returns empty and marker-free input unchanged", () => {
    expect(renderTcmMarkers("", STYLES)).toBe("");
    expect(render("plain 伤寒论 text")).toBe("plain 伤寒论 text");
  });

  it("tolerates a marker that never closes at the end of the body", () => {
    const html = render("前文$u{桂枝");
    expect(html).toContain("前文");
    expect(html).toContain("桂枝");
    expect(html).not.toContain("$u{");
  });
});
