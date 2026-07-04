import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const script = resolve(root, "hooks/pre-skill-chain-guard.sh");
const realSlice = resolve(root, "test/fixtures/skill-chain/real-transcript-slice.jsonl");
const promptId = "c846cb1a-71ec-4437-af81-6fecee248a39";

type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

async function runGuard(
  input: Record<string, unknown>,
  env: Record<string, string | undefined> = {}
): Promise<RunResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn("bash", [script], {
      cwd: root,
      env: { ...process.env, ...env }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: { toString(): string }) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: { toString(): string }) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      resolveRun({ code, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function writeTranscript(lines: unknown[], dir: string): Promise<string> {
  const path = join(dir, "transcript.jsonl");
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

async function readRealLines(): Promise<Record<string, unknown>[]> {
  return (await readFile(realSlice, "utf8"))
    .trim()
    .split("\n")
    .map((line: string) => JSON.parse(line));
}

function hookInput(transcriptPath: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tool_name: "Skill",
    tool_input: { skill: "publicar:publicar-deploy" },
    session_id: "test-session",
    transcript_path: transcriptPath,
    prompt_id: promptId,
    cwd: root,
    permission_mode: "default",
    ...overrides
  };
}

function setHumanText(lines: Record<string, unknown>[], content: unknown): Record<string, unknown>[] {
  const copy = structuredClone(lines);
  const user = copy[0] as { message: { content: unknown } };
  user.message.content = content;
  return copy;
}

function setPreviousSkill(lines: Record<string, unknown>[], skill: string): Record<string, unknown>[] {
  const copy = structuredClone(lines);
  const assistant = copy[1] as { message: { content: Array<{ input: { skill: string } }> } };
  assistant.message.content[0].input.skill = skill;
  return copy;
}

function removePreviousSkill(lines: Record<string, unknown>[]): Record<string, unknown>[] {
  return structuredClone([lines[0], lines[3], lines[4]]);
}

describe("pre-skill-chain-guard", () => {
  it("A: allows non-publicar skill calls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "publicar-guard-"));
    try {
      const transcriptPath = await writeTranscript(await readRealLines(), dir);
      const result = await runGuard(hookInput(transcriptPath, { tool_input: { skill: "Bash" } }));

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("B: denies publicar after RHW without publicar intent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "publicar-guard-"));
    try {
      const transcriptPath = await writeTranscript(await readRealLines(), dir);
      const result = await runGuard(hookInput(transcriptPath));
      const output = JSON.parse(result.stdout);

      expect(result.code).toBe(0);
      expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(output.hookSpecificOutput.permissionDecisionReason).toContain(
        "reviewable-html-workbench:visual-html-renderer"
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("B2: denies publicar-comment-loop after RHW without publicar intent", async () => {
    for (const skill of ["publicar:publicar-comment-loop", "publicar-comment-loop"]) {
      const dir = await mkdtemp(join(tmpdir(), "publicar-guard-"));
      try {
        const lines = (await readRealLines()).slice(0, 3);
        const transcriptPath = await writeTranscript(lines, dir);
        const result = await runGuard(hookInput(transcriptPath, { tool_input: { skill } }));
        const output = JSON.parse(result.stdout);

        expect(result.code).toBe(0);
        expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
        expect(output.hookSpecificOutput.permissionDecisionReason).toContain(
          "reviewable-html-workbench:visual-html-renderer"
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  it("C: allows publicar when the human prompt includes a publicar verb phrase", async () => {
    const dir = await mkdtemp(join(tmpdir(), "publicar-guard-"));
    try {
      const lines = setHumanText(await readRealLines(), "ER図を作って publicar に出して");
      const transcriptPath = await writeTranscript(lines, dir);
      const result = await runGuard(hookInput(transcriptPath));

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("D: allows self chaining from publicar", async () => {
    const dir = await mkdtemp(join(tmpdir(), "publicar-guard-"));
    try {
      const lines = setPreviousSkill(await readRealLines(), "publicar:publicar-deploy");
      const transcriptPath = await writeTranscript(lines, dir);
      const result = await runGuard(hookInput(transcriptPath));

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("E: allows standalone publicar calls without a previous skill", async () => {
    const dir = await mkdtemp(join(tmpdir(), "publicar-guard-"));
    try {
      const lines = removePreviousSkill(await readRealLines());
      const transcriptPath = await writeTranscript(lines, dir);
      const result = await runGuard(hookInput(transcriptPath));

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("F: fail-opens and logs drift when transcript_path is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "publicar-guard-"));
    try {
      const result = await runGuard(
        hookInput("", { transcript_path: "" }),
        { TMPDIR: dir }
      );
      const drift = await readFile(join(dir, "claude-publicar-chain-guard/drift.log"), "utf8");

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
      expect(drift).toContain("missing prompt_id or transcript_path");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("G: denies chaining from an unknown namespace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "publicar-guard-"));
    try {
      const lines = setPreviousSkill(await readRealLines(), "future-plugin:foo");
      const transcriptPath = await writeTranscript(lines, dir);
      const result = await runGuard(hookInput(transcriptPath));
      const output = JSON.parse(result.stdout);

      expect(result.code).toBe(0);
      expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
      expect(output.hookSpecificOutput.permissionDecisionReason).toContain("future-plugin:foo");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("H: extracts human prompt text from array content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "publicar-guard-"));
    try {
      const lines = setHumanText(await readRealLines(), [
        { type: "text", text: "ER図を作って" },
        { type: "text", text: "publicar に出して" }
      ]);
      const transcriptPath = await writeTranscript(lines, dir);
      const result = await runGuard(hookInput(transcriptPath));

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("I: denies bare URL wording without a publicar verb phrase", async () => {
    const dir = await mkdtemp(join(tmpdir(), "publicar-guard-"));
    try {
      const lines = setHumanText(await readRealLines(), "この URL を要約して");
      const transcriptPath = await writeTranscript(lines, dir);
      const result = await runGuard(hookInput(transcriptPath));
      const output = JSON.parse(result.stdout);

      expect(result.code).toBe(0);
      expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("J: allows SDK prompts with a publicar verb phrase", async () => {
    const lines = setHumanText(await readRealLines(), "ER図を作って publicar に出して");
    const user = lines[0] as { origin?: unknown; promptSource?: string };
    user.origin = {};
    user.promptSource = "sdk";
    const dir = await mkdtemp(join(tmpdir(), "publicar-guard-"));
    try {
      const transcriptPath = await writeTranscript(lines, dir);
      const result = await runGuard(hookInput(transcriptPath));

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("J-neg: denies SDK prompts without a publicar verb phrase", async () => {
    const lines = await readRealLines();
    const user = lines[0] as { origin?: unknown; promptSource?: string };
    user.origin = {};
    user.promptSource = "sdk";
    const dir = await mkdtemp(join(tmpdir(), "publicar-guard-"));
    try {
      const transcriptPath = await writeTranscript(lines, dir);
      const result = await runGuard(hookInput(transcriptPath));
      const output = JSON.parse(result.stdout);

      expect(result.code).toBe(0);
      expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("K: denies a bare dashite phrase without publicar intent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "publicar-guard-"));
    try {
      const lines = setHumanText(await readRealLines(), "一覧を出して");
      const transcriptPath = await writeTranscript(lines, dir);
      const result = await runGuard(hookInput(transcriptPath));
      const output = JSON.parse(result.stdout);

      expect(result.code).toBe(0);
      expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
