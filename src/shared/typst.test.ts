import { describe, expect, test } from "bun:test";
import { describeTypstDiagnostics } from "./typst";

// Entries have the shape typst.ts returns: 0-based line and column, columns in characters.
function entry(range: string, message: string, severity = "error") {
  return { package: "", path: "/@memory/main.typ", range, severity, message };
}

describe("describeTypstDiagnostics", () => {
  test("reports 1-based positions and marks the range in the quoted line", () => {
    expect(
      describeTypstDiagnostics(
        "#set page(width: 180mm, height: auto)\n#strong[unclosed\n",
        [entry("1:7-1:8", "unclosed delimiter")],
      ),
    ).toBe("error: unclosed delimiter (line 2, column 8)\n2 | #strong⟦[⟧unclosed");

    // Columns count characters, not UTF-16 units or bytes.
    expect(
      describeTypstDiagnostics("😀😀 #strong[x\n", [entry("0:10-0:11", "unclosed delimiter")]),
    ).toBe("error: unclosed delimiter (line 1, column 11)\n1 | 😀😀 #strong⟦[⟧x");
  });

  test("handles multi-line ranges, hints and entries without a position", () => {
    expect(
      describeTypstDiagnostics("= T\n```\nunclosed raw\nmore\n", [entry("1:0-4:0", "unclosed raw text")]),
    ).toBe("error: unclosed raw text (line 2, column 1)\n2 | ⟦```⟧");

    expect(
      describeTypstDiagnostics("#let f(x) = x.nonexistent\n#f(1)\n", [
        entry("0:14-0:25", "cannot access fields on type integer"),
        entry("1:1-1:5", "while calling f", "hint"),
      ]),
    ).toBe(
      [
        "error: cannot access fields on type integer (line 1, column 15)",
        "1 | #let f(x) = x.⟦nonexistent⟧",
        "hint: while calling f (line 2, column 2)",
        "2 | #⟦f(1)⟧",
      ].join("\n"),
    );

    expect(describeTypstDiagnostics("= T\n", [{ message: "boom" }, "plain"])).toBe("error: boom\nplain");
    expect(describeTypstDiagnostics("= T\n", [])).toBe("Typst compilation failed without diagnostics");
  });

  test("quotes only the part of a very long line around the range", () => {
    const line = `${"a".repeat(300)}[${"b".repeat(300)}`;
    expect(describeTypstDiagnostics(line, [entry("0:300-0:301", "unclosed delimiter")])).toBe(
      `error: unclosed delimiter (line 1, column 301)\n1 | …${"a".repeat(100)}⟦[⟧${"b".repeat(100)}…`,
    );
  });
});
