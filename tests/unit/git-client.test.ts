import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isGitVersionSupported,
  parseGitVersion,
} from "../../src/adapters/git/git-client.js";

describe("A1 — Git Version Parsing & Policy", () => {
  it("parses standard and platform-specific git --version strings", () => {
    const mac = parseGitVersion("git version 2.45.2 (Apple Git-154)");
    assert.deepEqual(mac, { raw: "2.45.2", major: 2, minor: 45, patch: 2 });
    assert.equal(isGitVersionSupported(mac!), true);

    const minOk = parseGitVersion("git version 2.36.0");
    assert.equal(isGitVersionSupported(minOk!), true);

    const tooOld = parseGitVersion("git version 2.35.9");
    assert.equal(isGitVersionSupported(tooOld!), false);

    const futureMajor = parseGitVersion("git version 3.0.1");
    assert.equal(isGitVersionSupported(futureMajor!), true);
  });
});
