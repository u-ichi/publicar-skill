import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");

describe("plugin hook manifest", () => {
  it("parses hooks/hooks.json", async () => {
    const raw = await readFile(resolve(root, "hooks/hooks.json"), "utf8");
    const hooks = JSON.parse(raw);

    expect(hooks.hooks.PreToolUse[0].matcher).toBe("Skill");
  });

  it("ships an executable skill-chain guard", async () => {
    await access(resolve(root, "hooks/pre-skill-chain-guard.sh"), constants.X_OK);
  });

  it("runs through CLAUDE_PLUGIN_ROOT", async () => {
    const raw = await readFile(resolve(root, "hooks/hooks.json"), "utf8");

    expect(raw).toContain("${CLAUDE_PLUGIN_ROOT}");
  });
});
