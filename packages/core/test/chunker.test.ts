import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chunkFile,
  chunkHash,
  normalizeWhitespace,
  detectLanguageFromPath,
} from "../src/chunker.js";

function detectLanguageFromPathSuite(): void {
  void it("detects TypeScript from .ts", () => {
    assert.equal(detectLanguageFromPath("src/index.ts"), "typescript");
  });

  void it("detects Python from .py", () => {
    assert.equal(detectLanguageFromPath("module.py"), "python");
  });

  void it("detects Rust from .rs", () => {
    assert.equal(detectLanguageFromPath("lib.rs"), "rust");
  });

  void it("falls back to text for unknown extensions", () => {
    assert.equal(detectLanguageFromPath("Makefile"), "text");
  });
}
void describe("detectLanguageFromPath", detectLanguageFromPathSuite);

function normalizeWhitespaceSuite(): void {
  void it("normalizes CRLF to LF", () => {
    assert.equal(normalizeWhitespace("a\r\nb\r\nc"), "a\nb\nc\n");
  });

  void it("replaces tabs with 2 spaces", () => {
    assert.equal(normalizeWhitespace("\tfoo"), "  foo\n");
  });

  void it("trims trailing whitespace per line", () => {
    assert.equal(normalizeWhitespace("foo  \nbar  "), "foo\nbar\n");
  });
}
void describe("normalizeWhitespace", normalizeWhitespaceSuite);

function chunkHashSuite(): void {
  void it("is deterministic", () => {
    assert.equal(chunkHash("hello world"), chunkHash("hello world"));
  });

  void it("ignores whitespace differences", () => {
    assert.equal(
      chunkHash("function foo() {\n  return 1;\n}"),
      chunkHash("function foo() {\n\treturn 1;\n}"),
    );
  });
}
void describe("chunkHash", chunkHashSuite);

function chunkFileSuite(): void {
  void it("produces scope context for a TypeScript file", () => {
    const content =
      'import { foo } from "./bar";\n' +
      "\n" +
      "export class Hello {\n" +
      '  greet() { return "hi"; }\n' +
      "}\n" +
      "\n" +
      "export function add(a, b) {\n" +
      "  return a + b;\n" +
      "}\n" +
      "\n" +
      "export function sub(a, b) {\n" +
      "  return a - b;\n" +
      "}\n";

    const result = chunkFile("test.ts", content, { maxChunkBytes: 100 });
    assert.ok(result.chunks.length >= 2);
    const withScope = result.chunks.filter((c) => c.scopeContext);
    assert.ok(withScope.length > 0, "should have scope context");
  });

  void it("chunks a Python file with multiple functions", () => {
    const content =
      "import sys\n" +
      "\n" +
      "class Greeter:\n" +
      '    def say_hello(self):\n        print("hi")\n' +
      "\n" +
      '    def say_goodbye(self):\n        print("bye")\n' +
      "\n" +
      "def add(a, b):\n" +
      "    return a + b\n" +
      "\n" +
      "def sub(a, b):\n" +
      "    return a - b\n";

    const result = chunkFile("test.py", content, { maxChunkBytes: 100 });
    assert.ok(result.chunks.length >= 2);
    assert.equal(result.language, "python");
  });

  void it("falls back for plain text files", () => {
    const content =
      "# Hello\n\n" +
      "This is a paragraph about something interesting.\n\n" +
      "And here is another paragraph that is longer.\n";

    const result = chunkFile("README.md", content);
    assert.ok(result.chunks.length >= 1);
    assert.equal(result.language, "markdown");
  });

  void it("produces deterministic chunk hashes", () => {
    const a = chunkFile("test.ts", "const x = 1;\nconst y = 2;\n");
    const b = chunkFile("test.ts", "const x = 1;\nconst y = 2;\n");
    assert.equal(a.chunks.length, b.chunks.length);
    for (let i = 0; i < a.chunks.length; i++) {
      assert.equal(a.chunks[i].chunkHash, b.chunks[i].chunkHash);
    }
  });

  void it("handles empty content", () => {
    const result = chunkFile("empty.ts", "");
    assert.equal(result.chunks.length, 0);
  });
}
void describe("chunkFile", chunkFileSuite);
