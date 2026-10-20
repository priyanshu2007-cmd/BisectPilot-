import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

describe("Cross-Platform Test Discovery", () => {
  async function getDiscoverer() {
    const scriptPath = path.resolve(process.cwd(), "scripts/run-tests.mjs");
    const mod = await import(pathToFileURL(scriptPath).href);
    return mod.discoverTestFiles as (target?: string) => string[];
  }

  it("discovers all unit test files without relying on shell wildcard expansion", async () => {
    const discoverTestFiles = await getDiscoverer();
    const unitTests = discoverTestFiles("unit");
    assert.ok(unitTests.length > 0, "Should discover at least one unit test");
    for (const file of unitTests) {
      assert.match(file, /dist[/\\]tests[/\\]unit[/\\][^/\\]+\.test\.js$/);
    }
  });

  it("discovers integration and safety test files correctly", async () => {
    const discoverTestFiles = await getDiscoverer();
    const integrationTests = discoverTestFiles("integration");
    assert.ok(integrationTests.length > 0, "Should discover integration tests");
    for (const file of integrationTests) {
      assert.match(file, /dist[/\\]tests[/\\]integration[/\\][^/\\]+\.test\.js$/);
    }

    const safetyTests = discoverTestFiles("safety");
    assert.ok(safetyTests.length > 0, "Should discover safety tests");
    for (const file of safetyTests) {
      assert.match(file, /dist[/\\]tests[/\\]safety[/\\][^/\\]+\.test\.js$/);
    }
  });

  it("discovers all suites when no target is passed", async () => {
    const discoverTestFiles = await getDiscoverer();
    const allTests = discoverTestFiles();
    const unitTests = discoverTestFiles("unit");
    const integrationTests = discoverTestFiles("integration");
    const safetyTests = discoverTestFiles("safety");

    assert.equal(allTests.length, unitTests.length + integrationTests.length + safetyTests.length);
    assert.ok(allTests.length >= 35, `Expected >= 35 test files, found ${allTests.length}`);
  });

  it("handles non-existent test directory gracefully by returning empty array", async () => {
    const discoverTestFiles = await getDiscoverer();
    const missing = discoverTestFiles("dist/tests/nonexistent-directory");
    assert.deepEqual(missing, []);
  });
});
