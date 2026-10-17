import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe, expect, it} from "vitest";

import AnnotationMarkersApp, {
  colorInputValue,
  StyleFields,
} from "@/components/admin/annotation-markers/AnnotationMarkersApp";
import type {AnnotationMarker} from "@/shared/AnnotationMarker";

const draft = {
  color: "rgba(0, 128, 255, 0.90)",
  smallFont: false,
  smallFontScale: "0.7",
  linkType: 0,
};

const passthrough = (key: string) => key;

const renderStyleFields = (color: string) =>
  renderToStaticMarkup(
    React.createElement(StyleFields, {
      draft: {...draft, color},
      onChange: () => {},
      t: passthrough,
    }),
  );

describe("Annotation markers colour picker", () => {
  it("normalises every stored colour shape to the value a colour input displays", () => {
    expect(colorInputValue("#abc")).toBe("#aabbcc");
    expect(colorInputValue("#ABC")).toBe("#aabbcc");
    expect(colorInputValue("#a1b2c3")).toBe("#a1b2c3");
    expect(colorInputValue("#A1B2C3")).toBe("#a1b2c3");
    expect(colorInputValue("rgb(0, 128, 255)")).toBe("#0080ff");
    expect(colorInputValue("rgba(0, 128, 255, 0.90)")).toBe("#0080ff");
    expect(colorInputValue("#808080")).toBe("#808080");
    expect(colorInputValue("")).toBe("#808080");
    expect(colorInputValue("garbage")).toBe("#808080");
    expect(colorInputValue("rgb(300, 0, 0)")).toBe("#ff0000");
  });

  it("replaces the manual colour entry with a colour input in the shared style fields", () => {
    const output = renderStyleFields("rgba(0, 128, 255, 0.90)");
    expect(output).toContain("type=\"color\"");
    expect(output).toContain("value=\"#0080ff\"");
    expect(output).toContain("aria-label=\"annotationMarkers.color\"");
    expect(output).toContain(">rgba(0, 128, 255, 0.90)<");
    expect(output).not.toContain("value=\"rgba(0, 128, 255, 0.90)\"");
  });

  it("expands the short hex form for the colour input", () => {
    const output = renderStyleFields("#abc");
    expect(output).toContain("value=\"#aabbcc\"");
    expect(output).toContain(">#abc<");
  });

  it("keeps the read-only row showing the stored colour text", () => {
    const markers: AnnotationMarker[] = [
      {
        id: "am_f",
        code: "f",
        title: "方剂",
        sortOrder: 1,
        color: "#a1b2c3",
        smallFont: false,
        smallFontScale: 0.7,
        linkType: 2,
      },
    ];
    const output = renderToStaticMarkup(
      React.createElement(AnnotationMarkersApp, {initialMarkers: markers}),
    );
    expect(output).toContain("#a1b2c3");
    expect(output).not.toContain("type=\"color\"");
  });
});
