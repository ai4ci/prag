import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateUriGrants, type GrantRow } from "../src/schema.js";

function allow(pattern: string, reason: GrantRow["reason"] = "explicit_grant"): GrantRow {
  return { pattern, action: "allow", reason, createdAt: new Date() };
}
function deny(pattern: string, reason: GrantRow["reason"] = "user_deny"): GrantRow {
  return { pattern, action: "deny", reason, createdAt: new Date() };
}

function evaluateUriGrantsSuite(): void {
  void it("denies by default when no grants exist", () => {
    const result = evaluateUriGrants("file:///home/user/secret.txt", []);
    assert.equal(result.matched, false);
    assert.equal(result.action, null);
  });

  void it("allows a URI matching an allow glob", () => {
    const grants = [allow("file:///home/user/Git/**")];
    const result = evaluateUriGrants("file:///home/user/Git/prag/src/main.ts", grants);
    assert.equal(result.matched, true);
    assert.equal(result.action, "allow");
  });

  void it("denies a URI matching a deny glob even when allow also matches", () => {
    const grants = [
      allow("file:///home/user/Git/**"),
      deny("file:///home/user/Git/secret/**"),
    ];
    const result = evaluateUriGrants("file:///home/user/Git/secret/keys.txt", grants);
    assert.equal(result.matched, true);
    assert.equal(result.action, "deny");
  });

  void it("uses longest prefix match (more specific wins)", () => {
    const grants = [
      deny("file:///home/user/Git/secret/**"),
      allow("file:///home/user/Git/secret/sub/allowed/**"),
    ];
    const result = evaluateUriGrants("file:///home/user/Git/secret/sub/allowed/lib.ts", grants);
    assert.equal(result.matched, true);
    assert.equal(result.action, "allow");
  });

  void it("deny breaks ties when allow and deny have same prefix length", () => {
    const grants = [
      allow("file:///home/user/Git/project/**"),
      deny("file:///home/user/Git/project/**"),
    ];
    const result = evaluateUriGrants("file:///home/user/Git/project/file.ts", grants);
    assert.equal(result.matched, true);
    assert.equal(result.action, "deny");
  });

  void it("does not match a URI outside an allow glob", () => {
    const grants = [allow("file:///home/user/Git/**")];
    const result = evaluateUriGrants("file:///etc/passwd", grants);
    assert.equal(result.matched, false);
  });

  void it("matches exact URI without glob", () => {
    const grants = [allow("file:///home/user/readme.md")];
    const result = evaluateUriGrants("file:///home/user/readme.md", grants);
    assert.equal(result.matched, true);
    assert.equal(result.action, "allow");
  });

  void it("supports web URIs in the same table", () => {
    const grants = [
      allow("https://docs.example.com/**"),
      deny("https://docs.example.com/private/**"),
    ];
    const result = evaluateUriGrants("https://docs.example.com/private/admin-keys.html", grants);
    assert.equal(result.matched, true);
    assert.equal(result.action, "deny");
  });
}
void describe("evaluateUriGrants", evaluateUriGrantsSuite);
