import {describe, expect, it} from "vitest";
import {wrapWithMarker} from "@/client/annotationMarkers";

describe("wrapWithMarker", () => {
  it("wraps a selection in $f{...} and selects the whole wrap", () => {
    const result = wrapWithMarker("桂枝汤主之", 0, 3, "f");
    expect(result.value).toBe("$f{桂枝汤}主之");
    expect(result.selectionStart).toBe(0);
    expect(result.selectionEnd).toBe("$f{桂枝汤}".length);
  });

  it("inserts $f{} with the caret inside the braces when nothing is selected", () => {
    const result = wrapWithMarker("正文", 1, 1, "u");
    expect(result.value).toBe("正$u{}文");
    expect(result.selectionStart).toBe("正$u{".length);
    expect(result.selectionEnd).toBe("正$u{".length);
  });

  it("leaves the rest of the body intact", () => {
    const result = wrapWithMarker("甲乙丙丁", 1, 3, "x");
    expect(result.value).toBe("甲$x{乙丙}丁");
  });
});
