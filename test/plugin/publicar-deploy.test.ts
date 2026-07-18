import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, stat, symlink, writeFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const root = resolve(__dirname, "../..");
const helperPath = resolve(root, "skills/publicar-deploy/scripts/publicar-deploy.mjs");

// ---- HTTP stub: publicar API の最小実装 + 全リクエスト記録 ----

type RecordedRequest = {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: Buffer;
};

type StubState = {
  // 設定時、POST 要求へ 307 + Location: <redirectTo><path> を返す (redirect 遮断の検証用)
  redirectTo: string | null;
  // 設定時、認証 poll が空の api_key を返す
  emptyAuthKey: boolean;
};

type Stub = {
  server: Server;
  origin: string;
  requests: RecordedRequest[];
  apiKey: string;
  state: StubState;
  mutations: () => RecordedRequest[];
  reset: () => void;
};

async function startStub(name: string): Promise<Stub> {
  const requests: RecordedRequest[] = [];
  const apiKey = `pub_${name}_secret_key_0123456789abcdef`;
  const state: StubState = { redirectTo: null, emptyAuthKey: false };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body
      });
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      res.setHeader("Content-Type", "application/json");
      if (state.redirectTo !== null && req.method === "POST") {
        res.statusCode = 307;
        res.setHeader("Location", `${state.redirectTo}${url.pathname}${url.search}`);
        res.end();
        return;
      }
      if (req.method === "GET" && url.pathname === "/auth/cli/poll") {
        // テストでは即 completed を返す
        res.statusCode = 200;
        res.end(JSON.stringify({ status: "completed", api_key: state.emptyAuthKey ? "" : apiKey }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/v1/projects") {
        if (req.headers.authorization !== `Bearer ${apiKey}`) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        res.statusCode = 201;
        res.end(
          JSON.stringify({
            ok: true,
            project: { id: `prj-${name}-1`, alias: `alias-${name}-1` },
            url: `${origin(server)}/p/alias-${name}-1/`
          })
        );
        return;
      }
      if (req.method === "POST" && /^\/api\/v1\/projects\/[^/]+\/deploy$/.test(url.pathname)) {
        if (req.headers.authorization !== `Bearer ${apiKey}`) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, url: `${origin(server)}/p/alias-${name}-1/` }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return {
    server,
    origin: origin(server),
    requests,
    apiKey,
    state,
    mutations: () => requests.filter((r) => r.method !== "GET" && r.method !== "HEAD"),
    reset: () => {
      requests.length = 0;
      state.redirectTo = null;
      state.emptyAuthKey = false;
    }
  };
}

function origin(server: Server): string {
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no address");
  return `http://127.0.0.1:${addr.port}`;
}

// ---- テスト環境: HOME 隔離 + temp git repo ----

let stubA: Stub;
let stubB: Stub;
let home: string;
let repoA: string;
let repoB: string;
let outside: string;

function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    // 利用者の global/system git config を遮断する
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    ...extra
  };
  return env;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { env: cleanEnv() });
  return stdout.trim();
}

type HelperResult = {
  code: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
};

async function helper(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {}
): Promise<HelperResult> {
  return await new Promise<HelperResult>((resolveRun) => {
    execFile(
      "node",
      [helperPath, ...args],
      { cwd: opts.cwd ?? home, env: cleanEnv(opts.env ?? {}) },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === "number"
          ? ((error as { code?: number }).code ?? 1)
          : error
            ? 1
            : 0;
        let json: Record<string, unknown> | null = null;
        for (const line of `${stdout}\n${stderr}`.split("\n")) {
          const trimmed = line.trim();
          if (trimmed.startsWith("{")) {
            try {
              json = JSON.parse(trimmed) as Record<string, unknown>;
            } catch {
              // JSON 以外の行は無視する
            }
          }
        }
        resolveRun({ code, stdout, stderr, json });
      }
    );
  });
}

async function initRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await execFileAsync("git", ["init", "-q", path], { env: cleanEnv() });
}

// fixture を commit し、helper 実行前の working tree を clean にする
async function commitAll(repo: string): Promise<void> {
  await git(repo, "add", "-A");
  await git(repo, "-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "-m", "fixture");
}

async function writeProfiles(profiles: Record<string, { url: string; api_key: string }>, current?: string): Promise<void> {
  await mkdir(join(home, ".publicar"), { recursive: true });
  await writeFile(
    join(home, ".publicar", "profiles.json"),
    JSON.stringify({ current: current ?? Object.keys(profiles)[0], profiles }, null, 2)
  );
}

async function setEndpoint(repo: string, originUrl: string): Promise<void> {
  await git(repo, "config", "--local", "publicar.endpoint", originUrl);
}

beforeAll(async () => {
  stubA = await startStub("a");
  stubB = await startStub("b");
});

afterAll(async () => {
  await new Promise<void>((r) => stubA.server.close(() => r()));
  await new Promise<void>((r) => stubB.server.close(() => r()));
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pubskill-home-"));
  repoA = join(home, "work", "repo-a");
  repoB = join(home, "work", "repo-b");
  outside = join(home, "work", "outside");
  await initRepo(repoA);
  await initRepo(repoB);
  await mkdir(outside, { recursive: true });
  await writeFile(join(repoA, "page.html"), "<html><body>A</body></html>");
  await writeFile(join(repoB, "page.html"), "<html><body>B</body></html>");
  await writeFile(join(outside, "page.html"), "<html><body>out</body></html>");
  await commitAll(repoA);
  await commitAll(repoB);
  stubA.reset();
  stubB.reset();
});

afterAll(async () => {
  // beforeEach で作った最後の home を掃除する (中間分は OS tmp cleanup に任せる)
  if (home) await rm(home, { recursive: true, force: true });
});

describe("select / resolve / change / clear", () => {
  it("select は canonical origin を repo-local git config だけへ保存する", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });
    const result = await helper(["select", "--artifact", join(repoA, "page.html"), "--origin", stubA.origin]);

    expect(result.code).toBe(0);
    expect(await git(repoA, "config", "--local", "--get", "publicar.endpoint")).toBe(stubA.origin);
    // tracked ファイルへの書き込みが無い
    expect(await git(repoA, "status", "--porcelain")).toBe("");
    // publicar.* には endpoint 以外のキーが無い (project ID / alias / API key を保存しない)
    const publicarKeys = (await git(repoA, "config", "--local", "--list"))
      .split("\n")
      .filter((l) => l.startsWith("publicar."));
    expect(publicarKeys).toEqual([`publicar.endpoint=${stubA.origin}`]);
  });

  it("select は path/query/fragment/userinfo 付きや非HTTPS(非localhost) origin を拒否する", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });
    const invalid = [
      `${stubA.origin}/projects/123`,
      `${stubA.origin}/?q=1`,
      `${stubA.origin}/#frag`,
      "http://user:pass@127.0.0.1:9999",
      "http://example.com", // localhost 以外の http
      "ftp://example.com"
    ];
    for (const url of invalid) {
      const result = await helper(["select", "--artifact", join(repoA, "page.html"), "--origin", url]);
      expect(result.code, `origin=${url}`).not.toBe(0);
      expect(result.json?.error, `origin=${url}`).toBe("endpoint-invalid");
    }
    await expect(git(repoA, "config", "--local", "--get", "publicar.endpoint")).rejects.toThrow();
    expect(stubA.mutations()).toHaveLength(0);
    expect(stubB.mutations()).toHaveLength(0);
  });

  it("select は未登録 origin を CLI 認証フローで profile 登録してから保存する (非TTY)", async () => {
    // profiles.json なしの状態から開始する
    const result = await helper([
      "select",
      "--artifact",
      join(repoA, "page.html"),
      "--origin",
      stubA.origin,
      "--no-open",
      "--poll-interval-ms",
      "10"
    ]);

    expect(result.code).toBe(0);
    expect(await git(repoA, "config", "--local", "--get", "publicar.endpoint")).toBe(stubA.origin);
    const profiles = JSON.parse(await readFile(join(home, ".publicar", "profiles.json"), "utf8"));
    const aliases = Object.keys(profiles.profiles);
    expect(aliases).toHaveLength(1);
    expect(profiles.profiles[aliases[0]].url).toBe(stubA.origin);
    expect(profiles.profiles[aliases[0]].api_key).toBe(stubA.apiKey);
    // 認証ポーリングは GET のみで、mutation request を送らない
    expect(stubA.mutations()).toHaveLength(0);
  });

  it("resolve は repo と endpoint と profile alias を返し、API key を出力しない", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });
    await setEndpoint(repoA, stubA.origin);
    const result = await helper(["resolve", "--artifact", join(repoA, "page.html")]);

    expect(result.code).toBe(0);
    expect(result.json?.endpoint).toBe(stubA.origin);
    expect(result.json?.profile).toBe("a");
    expect(`${result.stdout}${result.stderr}`).not.toContain(stubA.apiKey);
  });

  it("resolve は endpoint 未設定なら endpoint-not-set で失敗する", async () => {
    const result = await helper(["resolve", "--artifact", join(repoA, "page.html")]);
    expect(result.code).not.toBe(0);
    expect(result.json?.error).toBe("endpoint-not-set");
  });

  it("change は別 origin へ明示変更し、clear は解除する", async () => {
    await writeProfiles({
      a: { url: stubA.origin, api_key: stubA.apiKey },
      b: { url: stubB.origin, api_key: stubB.apiKey }
    });
    await setEndpoint(repoA, stubA.origin);

    const changed = await helper(["change", "--artifact", join(repoA, "page.html"), "--origin", stubB.origin]);
    expect(changed.code).toBe(0);
    expect(await git(repoA, "config", "--local", "--get", "publicar.endpoint")).toBe(stubB.origin);

    const cleared = await helper(["clear", "--artifact", join(repoA, "page.html")]);
    expect(cleared.code).toBe(0);
    await expect(git(repoA, "config", "--local", "--get", "publicar.endpoint")).rejects.toThrow();
  });
});

describe("create-and-deploy: 選択 endpoint だけを使う", () => {
  it("HTML を選択 endpoint 上の新規 project へ deploy し、非選択側へ要求 0 件", async () => {
    await writeProfiles({
      a: { url: stubA.origin, api_key: stubA.apiKey },
      b: { url: stubB.origin, api_key: stubB.apiKey }
    });
    await setEndpoint(repoA, stubA.origin);

    const result = await helper(["create-and-deploy", "--artifact", join(repoA, "page.html"), "--title", "Repo A Page"]);

    expect(result.code).toBe(0);
    const project = result.json?.project as Record<string, unknown>;
    expect(project?.id).toBe("prj-a-1");
    expect(project?.alias).toBe("alias-a-1");
    expect(result.json?.url).toContain("/p/alias-a-1/");
    expect(result.json?.sourceKind).toBe("single-html");

    // 選択側: project 作成 + deploy の 2 mutation
    const mutations = stubA.mutations();
    expect(mutations.map((m) => m.url.split("?")[0])).toEqual([
      "/api/v1/projects",
      "/api/v1/projects/prj-a-1/deploy"
    ]);
    expect(mutations[1].contentType).toBe("text/html");
    expect(mutations[1].url).toContain("path=");
    // 非選択側: HTTP 要求そのものが 0 件
    expect(stubB.requests).toHaveLength(0);
    // API key を出力しない
    expect(`${result.stdout}${result.stderr}`).not.toContain(stubA.apiKey);
    // repo-local 設定に project 関連値を保存しない
    const publicarKeys = (await git(repoA, "config", "--local", "--list"))
      .split("\n")
      .filter((l) => l.startsWith("publicar."));
    expect(publicarKeys).toEqual([`publicar.endpoint=${stubA.origin}`]);
    expect(await git(repoA, "status", "--porcelain")).toBe("");
  });

  it("ZIP は application/zip + name= で deploy し sourceKind=zip を返す", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });
    await setEndpoint(repoA, stubA.origin);
    await writeFile(join(repoA, "site.zip"), Buffer.from("PKzipbody"));

    const result = await helper(["create-and-deploy", "--artifact", join(repoA, "site.zip")]);

    expect(result.code).toBe(0);
    expect(result.json?.sourceKind).toBe("zip");
    const deploy = stubA.mutations().find((m) => m.url.includes("/deploy"));
    expect(deploy?.contentType).toBe("application/zip");
    expect(deploy?.url).toContain("name=site.zip");
  });

  it("CWD が repo A でも artifact が repo B なら repo B の endpoint だけへ送る", async () => {
    await writeProfiles({
      a: { url: stubA.origin, api_key: stubA.apiKey },
      b: { url: stubB.origin, api_key: stubB.apiKey }
    });
    await setEndpoint(repoA, stubA.origin);
    await setEndpoint(repoB, stubB.origin);

    const result = await helper(["create-and-deploy", "--artifact", join(repoB, "page.html")], { cwd: repoA });

    expect(result.code).toBe(0);
    expect(stubB.mutations().length).toBeGreaterThan(0);
    expect(stubA.requests).toHaveLength(0);
  });

  it("deploy 成功時に ~/.publicar/projects.json へ派生記録を追記する", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });
    await setEndpoint(repoA, stubA.origin);

    const result = await helper(["create-and-deploy", "--artifact", join(repoA, "page.html")]);
    expect(result.code).toBe(0);

    const projects = JSON.parse(await readFile(join(home, ".publicar", "projects.json"), "utf8"));
    const record = projects.a["prj-a-1"];
    expect(record.localDir).toBe(repoA);
    expect(record.alias).toBe("alias-a-1");
    expect(record.url).toContain("/p/alias-a-1/");
    expect(record.sourceKind).toBe("single-html");
    expect(typeof record.lastSyncedAt).toBe("string");
  });

  it("projects.json の既存の他 profile / 他 project record を破壊せず merge する", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });
    await setEndpoint(repoA, stubA.origin);
    // comment-loop が保存した既存 record (<profile>/<projectId> 形式)
    const existing = {
      clinial: {
        proj_existing1: { localDir: "/tmp/x", alias: "old-alias", url: "https://old/p/old-alias/", sourceKind: "directory", lastSyncedAt: "2026-01-01T00:00:00Z" }
      },
      a: {
        proj_prior: { localDir: "/tmp/y", alias: "prior", url: `${stubA.origin}/p/prior/`, sourceKind: "zip", lastSyncedAt: "2026-01-02T00:00:00Z" }
      }
    };
    await mkdir(join(home, ".publicar"), { recursive: true });
    await writeFile(join(home, ".publicar", "projects.json"), JSON.stringify(existing, null, 2));

    const result = await helper(["create-and-deploy", "--artifact", join(repoA, "page.html")]);
    expect(result.code).toBe(0);

    const projects = JSON.parse(await readFile(join(home, ".publicar", "projects.json"), "utf8"));
    expect(projects.clinial.proj_existing1).toEqual(existing.clinial.proj_existing1);
    expect(projects.a.proj_prior).toEqual(existing.a.proj_prior);
    expect(projects.a["prj-a-1"].alias).toBe("alias-a-1");
  });
});

describe("deploy: 既存 project への再デプロイ (comment-loop 互換)", () => {
  it("明示 project ID へ deploy のみ行い、project 作成 POST 0 件・非選択側 0 件", async () => {
    await writeProfiles({
      a: { url: stubA.origin, api_key: stubA.apiKey },
      b: { url: stubB.origin, api_key: stubB.apiKey }
    });
    await setEndpoint(repoA, stubA.origin);

    const result = await helper(["deploy", "--artifact", join(repoA, "page.html"), "--project-id", "prj-existing-9"]);

    expect(result.code).toBe(0);
    expect((result.json?.project as Record<string, unknown>)?.id).toBe("prj-existing-9");
    // project 作成 POST が 0 件で、deploy 1 件のみ
    expect(stubA.mutations().map((m) => m.url.split("?")[0])).toEqual([
      "/api/v1/projects/prj-existing-9/deploy"
    ]);
    expect(stubB.requests).toHaveLength(0);
    // project ID を repo-local 設定へ保存しない
    const publicarKeys = (await git(repoA, "config", "--local", "--list"))
      .split("\n")
      .filter((l) => l.startsWith("publicar."));
    expect(publicarKeys).toEqual([`publicar.endpoint=${stubA.origin}`]);
  });

  it("deploy: 別 origin の --profile は通信 0 件で失敗する", async () => {
    await writeProfiles({
      a: { url: stubA.origin, api_key: stubA.apiKey },
      b: { url: stubB.origin, api_key: stubB.apiKey }
    });
    await setEndpoint(repoA, stubA.origin);

    const result = await helper([
      "deploy",
      "--artifact",
      join(repoA, "page.html"),
      "--project-id",
      "prj-existing-9",
      "--profile",
      "b"
    ]);

    expect(result.code).not.toBe(0);
    expect(result.json?.error).toBe("credential-origin-mismatch");
    expect(stubA.requests).toHaveLength(0);
    expect(stubB.requests).toHaveLength(0);
  });

  it("deploy: endpoint 未設定では通信 0 件で失敗する", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });

    const result = await helper(["deploy", "--artifact", join(repoA, "page.html"), "--project-id", "prj-existing-9"]);

    expect(result.code).not.toBe(0);
    expect(result.json?.error).toBe("endpoint-not-set");
    expect(stubA.requests).toHaveLength(0);
    expect(stubB.requests).toHaveLength(0);
  });

  it("deploy 成功時は projects.json の既存 record の alias を保持したまま更新する", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });
    await setEndpoint(repoA, stubA.origin);
    await mkdir(join(home, ".publicar"), { recursive: true });
    await writeFile(
      join(home, ".publicar", "projects.json"),
      JSON.stringify({
        a: {
          "prj-existing-9": { localDir: "/tmp/old", alias: "kept-alias", url: "old-url", sourceKind: "zip", lastSyncedAt: "2026-01-01T00:00:00Z" }
        }
      })
    );

    const result = await helper(["deploy", "--artifact", join(repoA, "page.html"), "--project-id", "prj-existing-9"]);
    expect(result.code).toBe(0);

    const projects = JSON.parse(await readFile(join(home, ".publicar", "projects.json"), "utf8"));
    const record = projects.a["prj-existing-9"];
    expect(record.alias).toBe("kept-alias");
    expect(record.localDir).toBe(repoA);
    expect(record.sourceKind).toBe("single-html");
  });
});

describe("select: 保存前の fail-closed 検証", () => {
  it("select --origin A --profile <別origin> は保存せず通信 0 件で失敗する", async () => {
    await writeProfiles({
      a: { url: stubA.origin, api_key: stubA.apiKey },
      b: { url: stubB.origin, api_key: stubB.apiKey }
    });

    const result = await helper([
      "select",
      "--artifact",
      join(repoA, "page.html"),
      "--origin",
      stubA.origin,
      "--profile",
      "b"
    ]);

    expect(result.code).not.toBe(0);
    expect(result.json?.error).toBe("credential-origin-mismatch");
    await expect(git(repoA, "config", "--local", "--get", "publicar.endpoint")).rejects.toThrow();
    expect(stubA.requests).toHaveLength(0);
    expect(stubB.requests).toHaveLength(0);
  });

  it("select の明示 profile が存在しない場合、別 profile や CLI 認証へ fallback せず失敗する", async () => {
    // origin 一致する profile 'a' が存在しても、明示された 'nosuch' が無ければ停止する
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });

    const result = await helper([
      "select",
      "--artifact",
      join(repoA, "page.html"),
      "--origin",
      stubA.origin,
      "--profile",
      "nosuch",
      "--no-open",
      "--poll-interval-ms",
      "10"
    ]);

    expect(result.code).not.toBe(0);
    expect(result.json?.error).toBe("credential-not-found");
    await expect(git(repoA, "config", "--local", "--get", "publicar.endpoint")).rejects.toThrow();
    // 認証 poll (GET) を含む一切の HTTP 要求が発生しない
    expect(stubA.requests).toHaveLength(0);
    expect(stubB.requests).toHaveLength(0);
    // profiles.json が書き換えられていない (fallback 登録なし)
    const profiles = JSON.parse(await readFile(join(home, ".publicar", "profiles.json"), "utf8"));
    expect(Object.keys(profiles.profiles)).toEqual(["a"]);
  });

  it("select --origin A で一致 profile の api_key 欠落/空は保存せず通信 0 件で失敗する", async () => {
    for (const apiKeyValue of [undefined, ""]) {
      const profileEntry: Record<string, unknown> = { url: stubA.origin };
      if (apiKeyValue !== undefined) profileEntry.api_key = apiKeyValue;
      await mkdir(join(home, ".publicar"), { recursive: true });
      await writeFile(
        join(home, ".publicar", "profiles.json"),
        JSON.stringify({ current: "a", profiles: { a: profileEntry } })
      );

      const result = await helper(["select", "--artifact", join(repoA, "page.html"), "--origin", stubA.origin]);
      expect(result.code, `api_key=${JSON.stringify(apiKeyValue)}`).not.toBe(0);
      expect(result.json?.error, `api_key=${JSON.stringify(apiKeyValue)}`).toBe("credential-invalid");
      await expect(git(repoA, "config", "--local", "--get", "publicar.endpoint")).rejects.toThrow();
    }
    expect(stubA.requests).toHaveLength(0);
    expect(stubB.requests).toHaveLength(0);
  });

  it("CLI 認証が空の api_key を返したら profile も endpoint も保存しない", async () => {
    stubA.state.emptyAuthKey = true;

    const result = await helper([
      "select",
      "--artifact",
      join(repoA, "page.html"),
      "--origin",
      stubA.origin,
      "--no-open",
      "--poll-interval-ms",
      "10"
    ]);

    expect(result.code).not.toBe(0);
    expect(result.json?.error).toBe("auth-failed");
    await expect(git(repoA, "config", "--local", "--get", "publicar.endpoint")).rejects.toThrow();
    await expect(readFile(join(home, ".publicar", "profiles.json"), "utf8")).rejects.toThrow();
    expect(stubA.mutations()).toHaveLength(0);
    expect(stubB.requests).toHaveLength(0);
  });

  it("CLI 認証で作成される profiles.json の mode は 0600 になる", async () => {
    const result = await helper([
      "select",
      "--artifact",
      join(repoA, "page.html"),
      "--origin",
      stubA.origin,
      "--no-open",
      "--poll-interval-ms",
      "10"
    ]);

    expect(result.code).toBe(0);
    const info = await stat(join(home, ".publicar", "profiles.json"));
    expect((info.mode & 0o777).toString(8)).toBe("600");
  });
});

describe("redirect 遮断: 選択 origin を越える転送をしない", () => {
  it("deploy (artifact body 付き) が 307 で別 origin へ誘導されても追わない", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });
    await setEndpoint(repoA, stubA.origin);
    stubA.state.redirectTo = stubB.origin;

    const result = await helper(["deploy", "--artifact", join(repoA, "page.html"), "--project-id", "prj-x"]);

    expect(result.code).not.toBe(0);
    expect(result.json?.error).toBe("http-redirect-blocked");
    // 選択側は deploy 1 件のみ受信し、非選択側へは HTTP 要求 0 件
    expect(stubA.mutations().map((m) => m.url.split("?")[0])).toEqual(["/api/v1/projects/prj-x/deploy"]);
    expect(stubB.requests).toHaveLength(0);
  });

  it("create-and-deploy の project 作成が 307 を返しても追わない", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });
    await setEndpoint(repoA, stubA.origin);
    stubA.state.redirectTo = stubB.origin;

    const result = await helper(["create-and-deploy", "--artifact", join(repoA, "page.html")]);

    expect(result.code).not.toBe(0);
    expect(result.json?.error).toBe("http-redirect-blocked");
    expect(stubB.requests).toHaveLength(0);
  });
});

describe("projects.json 書込不能時の fail-closed (TASK-017 permission-fix)", () => {
  it("派生記録の保存先が書込不能なら create-and-deploy は HTTP 0 件で project-record-unwritable", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });
    await setEndpoint(repoA, stubA.origin);
    // ~/.publicar を読取専用にして sandbox の書込拒否を再現する
    await chmod(join(home, ".publicar"), 0o555);

    try {
      const result = await helper(["create-and-deploy", "--artifact", join(repoA, "page.html")]);

      expect(result.code).not.toBe(0);
      expect(result.json?.error).toBe("project-record-unwritable");
      // 外部 HTTP mutation が 1 件も発生しない (重複 project 作成の余地を残さない)
      expect(stubA.requests).toHaveLength(0);
      expect(stubB.requests).toHaveLength(0);
    } finally {
      await chmod(join(home, ".publicar"), 0o755);
    }
  });

  it("deploy --project-id も書込不能なら HTTP 0 件で project-record-unwritable", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });
    await setEndpoint(repoA, stubA.origin);
    await chmod(join(home, ".publicar"), 0o555);

    try {
      const result = await helper(["deploy", "--artifact", join(repoA, "page.html"), "--project-id", "prj-x"]);

      expect(result.code).not.toBe(0);
      expect(result.json?.error).toBe("project-record-unwritable");
      expect(stubA.requests).toHaveLength(0);
      expect(stubB.requests).toHaveLength(0);
    } finally {
      await chmod(join(home, ".publicar"), 0o755);
    }
  });

  it("通信前検査後に派生記録だけ失敗した場合、作成済み project 情報を保持した構造化 error を返す", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });
    await setEndpoint(repoA, stubA.origin);
    // 通信前検査 (存在しない projects.json → probe 書込) は通るが、実書込は dangling symlink 先で失敗する
    await symlink(join(home, "no-such-dir", "projects.json"), join(home, ".publicar", "projects.json"));

    const result = await helper(["create-and-deploy", "--artifact", join(repoA, "page.html")]);

    expect(result.code).not.toBe(0);
    expect(result.json?.error).toBe("project-record-failed");
    // 外部 mutation は完了している (create + deploy)
    expect(stubA.mutations().map((m) => m.url.split("?")[0])).toEqual([
      "/api/v1/projects",
      "/api/v1/projects/prj-a-1/deploy"
    ]);
    // agent が同じ create を再実行しない判断に必要な情報を保持する
    const created = result.json?.created as Record<string, unknown>;
    expect(created?.id).toBe("prj-a-1");
    expect(created?.alias).toBe("alias-a-1");
    expect(created?.url).toContain("/p/alias-a-1/");
    expect(created?.endpoint).toBe(stubA.origin);
    expect(String(result.json?.message)).toContain("再実行");
  });
});

describe("bundle-root: directory バンドルの派生記録 (TASK-017 lead確定項目)", () => {
  async function makeBundle(repo: string): Promise<{ bundleDir: string; artifact: string }> {
    const bundleDir = join(repo, "bundle");
    await mkdir(bundleDir, { recursive: true });
    await writeFile(join(bundleDir, "renderer-manifest.json"), "{}");
    const pubTmp = join(repo, ".publicar-publish.test");
    await mkdir(pubTmp, { recursive: true });
    const artifact = join(pubTmp, "index.html");
    await writeFile(artifact, "<html><body>published</body></html>");
    return { bundleDir, artifact };
  }

  it("新規 directory publish は localDir=元directory / sourceKind=directory を記録する", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });
    await setEndpoint(repoA, stubA.origin);
    const { bundleDir, artifact } = await makeBundle(repoA);

    const result = await helper(["create-and-deploy", "--artifact", artifact, "--bundle-root", bundleDir]);

    expect(result.code).toBe(0);
    expect(result.json?.localDir).toBe(bundleDir);
    expect(result.json?.sourceKind).toBe("directory");
    expect(stubA.mutations().map((m) => m.url.split("?")[0])).toEqual([
      "/api/v1/projects",
      "/api/v1/projects/prj-a-1/deploy"
    ]);
    const projects = JSON.parse(await readFile(join(home, ".publicar", "projects.json"), "utf8"));
    expect(projects.a["prj-a-1"].localDir).toBe(bundleDir);
    expect(projects.a["prj-a-1"].sourceKind).toBe("directory");
  });

  it("既存 project 再デプロイでも元directory/directory を記録し、project 作成 POST 0 件", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });
    await setEndpoint(repoA, stubA.origin);
    const { bundleDir, artifact } = await makeBundle(repoA);
    await mkdir(join(home, ".publicar"), { recursive: true });
    await writeFile(
      join(home, ".publicar", "projects.json"),
      JSON.stringify({ a: { "prj-dir-1": { localDir: "/tmp/old", alias: "kept", url: "u", sourceKind: "directory", lastSyncedAt: "2026-01-01T00:00:00Z" } } })
    );

    const result = await helper(["deploy", "--artifact", artifact, "--project-id", "prj-dir-1", "--bundle-root", bundleDir]);

    expect(result.code).toBe(0);
    expect(stubA.mutations().map((m) => m.url.split("?")[0])).toEqual(["/api/v1/projects/prj-dir-1/deploy"]);
    const projects = JSON.parse(await readFile(join(home, ".publicar", "projects.json"), "utf8"));
    expect(projects.a["prj-dir-1"].localDir).toBe(bundleDir);
    expect(projects.a["prj-dir-1"].sourceKind).toBe("directory");
    expect(projects.a["prj-dir-1"].alias).toBe("kept");
    // project ID / bundle 情報を repo-local 設定へ保存しない
    const publicarKeys = (await git(repoA, "config", "--local", "--list"))
      .split("\n")
      .filter((l) => l.startsWith("publicar."));
    expect(publicarKeys).toEqual([`publicar.endpoint=${stubA.origin}`]);
  });

  it("別 repo の bundle-root は通信 0 件で拒否する", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });
    await setEndpoint(repoA, stubA.origin);
    const { artifact } = await makeBundle(repoA);
    const other = await makeBundle(repoB);

    const result = await helper(["create-and-deploy", "--artifact", artifact, "--bundle-root", other.bundleDir]);

    expect(result.code).not.toBe(0);
    expect(result.json?.error).toBe("bundle-root-mismatch");
    expect(stubA.requests).toHaveLength(0);
    expect(stubB.requests).toHaveLength(0);
  });

  it("不正な bundle-root (manifest なし / symlink / 不存在) は通信 0 件で拒否する", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });
    await setEndpoint(repoA, stubA.origin);
    const { bundleDir, artifact } = await makeBundle(repoA);
    const noManifest = join(repoA, "plain-dir");
    await mkdir(noManifest, { recursive: true });
    const linkDir = join(repoA, "bundle-link");
    await symlink(bundleDir, linkDir);

    for (const bad of [noManifest, linkDir, join(repoA, "no-such-dir")]) {
      const result = await helper(["create-and-deploy", "--artifact", artifact, "--bundle-root", bad]);
      expect(result.code, bad).not.toBe(0);
      expect(result.json?.error, bad).toBe("bundle-root-invalid");
    }
    expect(stubA.requests).toHaveLength(0);
    expect(stubB.requests).toHaveLength(0);
  });
});

describe("SKILL.md 文書回帰: directory バンドルの再デプロイ分岐", () => {
  it("directory 節が --project-id 有無で deploy / create-and-deploy を明示分岐する", async () => {
    const skillMd = await readFile(resolve(root, "skills/publicar-deploy/SKILL.md"), "utf8");
    const sections = skillMd.split(/^## /m);
    const dirSection = sections.find((s) => s.startsWith("directory バンドル"));
    expect(dirSection, "directory バンドル節が存在する").toBeDefined();
    // --project-id あり → 既存 project への deploy (project 作成なし)
    expect(dirSection).toMatch(/--project-id[^\n]*(指定|あり)[^\n]*場合[\s\S]*?set -- deploy --artifact[^\n]*--project-id/);
    // --project-id なし → create-and-deploy (新規作成)
    expect(dirSection).toMatch(/--project-id[^\n]*(無い|なし)[^\n]*場合[\s\S]*?set -- create-and-deploy --artifact/);
    // 両分岐で --bundle-root 元directory を渡す (一時 dir でなく元 directory を派生記録に残す)
    expect(dirSection).toMatch(/set -- deploy --artifact[^\n]*--bundle-root/);
    expect(dirSection).toMatch(/set -- create-and-deploy --artifact[^\n]*--bundle-root/);
    // publish 出力先は元 repo root 直下の mktemp 一時 directory (OS tmp / CWD 基準の禁止を明示)
    expect(dirSection).toMatch(/git repo の root 直下/);
    expect(dirSection).toMatch(/mktemp -d "\$REPO_ROOT\//);
    expect(dirSection).toMatch(/OS の一時ディレクトリや CWD 基準の出力先は使わない/);
    // repo 外出力を helper へ渡さない根拠 (not-in-repo) の明示
    expect(dirSection).toMatch(/not-in-repo/);
    // mktemp 直後に cleanup 関数 + trap 登録があり、成功・失敗にかかわらない片付けを明示する
    expect(dirSection).toMatch(/mktemp -d "\$REPO_ROOT\/[\s\S]*?cleanup\(\) \{[\s\S]*?trap cleanup EXIT/);
    expect(dirSection).toMatch(/成功・失敗にかかわらず/);
    // 再帰的強制削除を使わない。unlink は $PUB_TMP/index.html の明示 path 限定 + 空 directory の rmdir
    expect(dirSection).not.toMatch(/rm -rf/);
    expect(dirSection).not.toMatch(/rm -fr|rm -r /);
    const rmUses = [...(dirSection ?? "").matchAll(/\brm\b[^\n]*/g)].map((m) => m[0]);
    expect(rmUses.length).toBeGreaterThan(0);
    for (const use of rmUses) {
      expect(use.startsWith('rm -- "$PUB_TMP/index.html"'), `rm 使用箇所が明示 path 限定: ${use}`).toBe(true);
    }
    expect(dirSection).toContain('rmdir -- "$PUB_TMP"');
    // trap の shell 境界: 同一 shell invocation の明記
    expect(dirSection).toMatch(/同一 shell invocation 内で実行/);
    // 未設定 shell 変数による実行時分岐が無い (PROJECT_ID/TITLE/PROFILE の if 分岐禁止)
    expect(dirSection).not.toMatch(/\[ -n "\$(PROJECT_ID|TITLE|PROFILE)" \]/);
    expect(dirSection).not.toContain("$PROJECT_ID");
    // 既存 project 用と新規用が、各々 mktemp/trap/publish/helper を含む complete block として分離されている
    const codeBlocks = [...(dirSection ?? "").matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
    const isComplete = (block: string) =>
      block.includes("mktemp -d") &&
      block.includes("cleanup() {") &&
      block.includes('rm -- "$PUB_TMP/index.html"') &&
      block.includes('rmdir -- "$PUB_TMP"') &&
      block.includes("trap cleanup EXIT") &&
      block.includes("cli publish") &&
      block.includes('node "$HELPER" "$@"');
    const existingBlock = codeBlocks.find(
      (block) => isComplete(block) && block.includes("set -- deploy --artifact") && block.includes('--project-id "<project ID>"')
    );
    const newBlock = codeBlocks.find(
      (block) => isComplete(block) && block.includes("set -- create-and-deploy --artifact")
    );
    expect(existingBlock, "既存 project 用の complete block がある").toBeDefined();
    expect(newBlock, "新規用の complete block がある").toBeDefined();
    expect(existingBlock).not.toContain("create-and-deploy");
    expect(newBlock).not.toContain("--project-id");
    // zsh で 1 引数に畳まれる ${VAR:+--flag "$VAR"} 形式を使わない
    expect(dirSection).not.toMatch(/\$\{[A-Z_]+:\+/);
  });

  it("set -- による引数組み立てが bash/zsh 両方で空白入り値の引数数を保つ", async () => {
    // SKILL.md が指示する「set -- で optional flag を末尾追加する」組み立てパターンの shell 実測
    const snippet = [
      'PROJECT_ID=""; TITLE="Two Words"; PROFILE="my profile"',
      'if [ -n "$PROJECT_ID" ]; then',
      '  set -- deploy --artifact "/tmp/x.html" --project-id "$PROJECT_ID"',
      "else",
      '  set -- create-and-deploy --artifact "/tmp/x.html"',
      '  if [ -n "$TITLE" ]; then set -- "$@" --title "$TITLE"; fi',
      "fi",
      'if [ -n "$PROFILE" ]; then set -- "$@" --profile "$PROFILE"; fi',
      'printf "%s\\n" "$#"',
      'printf "[%s]\\n" "$@"'
    ].join("\n");
    const shells: string[] = [];
    for (const shell of ["bash", "zsh"]) {
      try {
        await execFileAsync(shell, ["-c", "true"]);
        shells.push(shell);
      } catch {
        // 未インストールの shell は skip (CI 環境差)
      }
    }
    expect(shells.length, "検証可能な shell が 1 つ以上ある").toBeGreaterThan(0);
    for (const shell of shells) {
      const { stdout } = await execFileAsync(shell, ["-c", snippet]);
      const lines = stdout.trim().split("\n");
      // create-and-deploy / --artifact / path / --title / "Two Words" / --profile / "my profile" = 7 引数
      expect(lines[0], shell).toBe("7");
      expect(lines, shell).toContain("[Two Words]");
      expect(lines, shell).toContain("[my profile]");
    }
  });

  it("comment-loop SKILL.md に再デプロイの直接 curl fallback が残っていない", async () => {
    const commentLoopMd = await readFile(resolve(root, "skills/publicar-comment-loop/SKILL.md"), "utf8");
    // deploy への直接 POST curl (旧 single HTML fallback) が存在しない
    expect(commentLoopMd).not.toMatch(/curl[^\n]*-X POST[^\n]*\/deploy/);
    expect(commentLoopMd).not.toContain("single HTML fallback");
    // helper/skill が使えない場合は停止する方針の明記
    expect(commentLoopMd).toMatch(/fallback せず[\s\S]*?アップロードを行わずに停止/);
  });

  it("エラー対処一覧に credential-invalid が記載されている", async () => {
    const skillMd = await readFile(resolve(root, "skills/publicar-deploy/SKILL.md"), "utf8");
    const errorSection = skillMd.split(/^## /m).find((s) => s.startsWith("エラー対処"));
    expect(errorSection).toBeDefined();
    expect(errorSection).toContain("`credential-invalid`");
  });
});

describe("create-and-deploy: fail-closed (通信前拒否)", () => {
  it("endpoint 未設定では global current profile へ fallback せず通信 0 件で失敗する", async () => {
    await writeProfiles({ b: { url: stubB.origin, api_key: stubB.apiKey } }, "b");

    const result = await helper(["create-and-deploy", "--artifact", join(repoA, "page.html")]);

    expect(result.code).not.toBe(0);
    expect(result.json?.error).toBe("endpoint-not-set");
    expect(stubA.requests).toHaveLength(0);
    expect(stubB.requests).toHaveLength(0);
  });

  it("環境変数 PUBLICAR_URL が保存 endpoint と異なる origin なら通信前に失敗する", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });
    await setEndpoint(repoA, stubA.origin);

    const result = await helper(["create-and-deploy", "--artifact", join(repoA, "page.html")], {
      env: { PUBLICAR_URL: stubB.origin, PUBLICAR_API_KEY: stubB.apiKey }
    });

    expect(result.code).not.toBe(0);
    expect(result.json?.error).toBe("env-endpoint-mismatch");
    expect(stubA.requests).toHaveLength(0);
    expect(stubB.requests).toHaveLength(0);
  });

  it("endpoint 未設定の CI (環境変数のみ) でも env を採用せず失敗する", async () => {
    const result = await helper(["create-and-deploy", "--artifact", join(repoA, "page.html")], {
      env: { PUBLICAR_URL: stubA.origin, PUBLICAR_API_KEY: stubA.apiKey }
    });

    expect(result.code).not.toBe(0);
    expect(result.json?.error).toBe("endpoint-not-set");
    expect(stubA.requests).toHaveLength(0);
    expect(stubB.requests).toHaveLength(0);
  });

  it("CI 経路: PUBLICAR_URL が保存 endpoint と一致すれば PUBLICAR_API_KEY を使って deploy できる", async () => {
    // profiles.json なし + repo-local endpoint 設定済み + 一致する env credential
    await setEndpoint(repoA, stubA.origin);

    const result = await helper(["create-and-deploy", "--artifact", join(repoA, "page.html")], {
      env: { PUBLICAR_URL: stubA.origin, PUBLICAR_API_KEY: stubA.apiKey }
    });

    expect(result.code).toBe(0);
    expect(stubA.mutations().length).toBe(2);
    expect(stubB.requests).toHaveLength(0);
  });

  it("PUBLICAR_API_KEY 単独 (URL なし) は origin 照合できないため失敗する", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });
    await setEndpoint(repoA, stubA.origin);

    const result = await helper(["create-and-deploy", "--artifact", join(repoA, "page.html")], {
      env: { PUBLICAR_API_KEY: stubB.apiKey }
    });

    expect(result.code).not.toBe(0);
    expect(result.json?.error).toBe("env-credential-unverifiable");
    expect(stubA.requests).toHaveLength(0);
    expect(stubB.requests).toHaveLength(0);
  });

  it("保存 endpoint と一致する credential profile が無ければ通信 0 件で失敗する", async () => {
    await writeProfiles({ b: { url: stubB.origin, api_key: stubB.apiKey } });
    await setEndpoint(repoA, stubA.origin);

    const result = await helper(["create-and-deploy", "--artifact", join(repoA, "page.html")]);

    expect(result.code).not.toBe(0);
    expect(result.json?.error).toBe("credential-not-found");
    expect(stubA.requests).toHaveLength(0);
    expect(stubB.requests).toHaveLength(0);
  });

  it("--profile が別 origin の profile を指す場合は endpoint を変えずに失敗する", async () => {
    await writeProfiles({
      a: { url: stubA.origin, api_key: stubA.apiKey },
      b: { url: stubB.origin, api_key: stubB.apiKey }
    });
    await setEndpoint(repoA, stubA.origin);

    const result = await helper([
      "create-and-deploy",
      "--artifact",
      join(repoA, "page.html"),
      "--profile",
      "b"
    ]);

    expect(result.code).not.toBe(0);
    expect(result.json?.error).toBe("credential-origin-mismatch");
    expect(stubA.requests).toHaveLength(0);
    expect(stubB.requests).toHaveLength(0);
    expect(await git(repoA, "config", "--local", "--get", "publicar.endpoint")).toBe(stubA.origin);
  });

  it("同一 origin に複数 profile がある場合は --profile 必須で失敗し、指定時は成功する", async () => {
    await writeProfiles({
      a1: { url: stubA.origin, api_key: stubA.apiKey },
      a2: { url: stubA.origin, api_key: stubA.apiKey }
    });
    await setEndpoint(repoA, stubA.origin);

    const ambiguous = await helper(["create-and-deploy", "--artifact", join(repoA, "page.html")]);
    expect(ambiguous.code).not.toBe(0);
    expect(ambiguous.json?.error).toBe("profile-ambiguous");
    expect(stubA.requests).toHaveLength(0);

    const explicit = await helper([
      "create-and-deploy",
      "--artifact",
      join(repoA, "page.html"),
      "--profile",
      "a2"
    ]);
    expect(explicit.code).toBe(0);
    expect(stubA.mutations().length).toBe(2);
  });

  it("origin 一致 profile でも api_key 欠落なら通信 0 件で失敗する", async () => {
    await mkdir(join(home, ".publicar"), { recursive: true });
    await writeFile(
      join(home, ".publicar", "profiles.json"),
      JSON.stringify({ current: "a", profiles: { a: { url: stubA.origin } } })
    );
    await setEndpoint(repoA, stubA.origin);

    for (const args of [
      ["create-and-deploy", "--artifact", join(repoA, "page.html")],
      ["create-and-deploy", "--artifact", join(repoA, "page.html"), "--profile", "a"]
    ]) {
      const result = await helper(args);
      expect(result.code, args.join(" ")).not.toBe(0);
      expect(result.json?.error, args.join(" ")).toBe("credential-invalid");
    }
    expect(stubA.requests).toHaveLength(0);
    expect(stubB.requests).toHaveLength(0);
  });

  it("origin 一致 profile でも api_key 空文字なら通信 0 件で失敗する", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: "" } });
    await setEndpoint(repoA, stubA.origin);

    for (const args of [
      ["create-and-deploy", "--artifact", join(repoA, "page.html")],
      ["create-and-deploy", "--artifact", join(repoA, "page.html"), "--profile", "a"]
    ]) {
      const result = await helper(args);
      expect(result.code, args.join(" ")).not.toBe(0);
      expect(result.json?.error, args.join(" ")).toBe("credential-invalid");
    }
    expect(stubA.requests).toHaveLength(0);
    expect(stubB.requests).toHaveLength(0);
  });

  it("deploy --project-id が空文字または空白のみなら通信 0 件で失敗する", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });
    await setEndpoint(repoA, stubA.origin);

    for (const projectId of ["", "   "]) {
      const result = await helper(["deploy", "--artifact", join(repoA, "page.html"), "--project-id", projectId]);
      expect(result.code, `project-id=${JSON.stringify(projectId)}`).not.toBe(0);
      expect(result.json?.error, `project-id=${JSON.stringify(projectId)}`).toBe("usage");
    }
    expect(stubA.requests).toHaveLength(0);
    expect(stubB.requests).toHaveLength(0);
  });

  it("repo A 内の file symlink が repo B の file を指す場合は通信 0 件で失敗する", async () => {
    await writeProfiles({
      a: { url: stubA.origin, api_key: stubA.apiKey },
      b: { url: stubB.origin, api_key: stubB.apiKey }
    });
    await setEndpoint(repoA, stubA.origin);
    await setEndpoint(repoB, stubB.origin);
    // repo A 配置の file symlink → repo B の実体。辿ると A の endpoint へ B の内容を送れてしまう
    await symlink(join(repoB, "page.html"), join(repoA, "link.html"));

    const result = await helper(["create-and-deploy", "--artifact", join(repoA, "link.html")]);

    expect(result.code).not.toBe(0);
    expect(result.json?.error).toBe("artifact-symlink");
    expect(stubA.requests).toHaveLength(0);
    expect(stubB.requests).toHaveLength(0);
  });

  it("directory symlink の artifact も同じ最終 path 判定で拒否する", async () => {
    await writeProfiles({
      a: { url: stubA.origin, api_key: stubA.apiKey },
      b: { url: stubB.origin, api_key: stubB.apiKey }
    });
    await setEndpoint(repoA, stubA.origin);
    await setEndpoint(repoB, stubB.origin);
    await mkdir(join(repoB, "bundle"), { recursive: true });
    await symlink(join(repoB, "bundle"), join(repoA, "bundle-link"));

    const result = await helper(["resolve", "--artifact", join(repoA, "bundle-link")]);

    expect(result.code).not.toBe(0);
    expect(result.json?.error).toBe("artifact-symlink");
    expect(stubA.requests).toHaveLength(0);
    expect(stubB.requests).toHaveLength(0);
  });

  it("origin 一致の env credential があっても --profile nosuch は credential-not-found で通信 0 件", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });
    await setEndpoint(repoA, stubA.origin);

    const result = await helper(
      ["create-and-deploy", "--artifact", join(repoA, "page.html"), "--profile", "nosuch"],
      { env: { PUBLICAR_URL: stubA.origin, PUBLICAR_API_KEY: stubA.apiKey } }
    );

    expect(result.code).not.toBe(0);
    expect(result.json?.error).toBe("credential-not-found");
    expect(stubA.requests).toHaveLength(0);
    expect(stubB.requests).toHaveLength(0);
  });

  it("明示 profile + matching PUBLICAR_URL のみ (KEY なし) でも profile key で成功する", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });
    await setEndpoint(repoA, stubA.origin);

    const result = await helper(
      ["create-and-deploy", "--artifact", join(repoA, "page.html"), "--profile", "a"],
      { env: { PUBLICAR_URL: stubA.origin } }
    );

    expect(result.code).toBe(0);
    expect(stubA.mutations()[0].authorization).toBe(`Bearer ${stubA.apiKey}`);
    expect(stubB.requests).toHaveLength(0);
  });

  it("明示 profile + PUBLICAR_API_KEY のみでも profile key で成功する", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });
    await setEndpoint(repoA, stubA.origin);

    const result = await helper(
      ["create-and-deploy", "--artifact", join(repoA, "page.html"), "--profile", "a"],
      { env: { PUBLICAR_API_KEY: "pub_env_only_key" } }
    );

    expect(result.code).toBe(0);
    expect(stubA.mutations()[0].authorization).toBe(`Bearer ${stubA.apiKey}`);
    expect(stubB.requests).toHaveLength(0);
  });

  it("select: 明示 profile + matching URL + 不正 env key でも profile alias を保存して返す", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });

    const result = await helper(
      ["select", "--artifact", join(repoA, "page.html"), "--origin", stubA.origin, "--profile", "a"],
      { env: { PUBLICAR_URL: stubA.origin, PUBLICAR_API_KEY: "pub_wrong_env_key" } }
    );

    expect(result.code).toBe(0);
    expect(result.json?.profile).toBe("a");
    expect(await git(repoA, "config", "--local", "--get", "publicar.endpoint")).toBe(stubA.origin);
  });

  it("select: 不存在の明示 profile は matching URL+KEY があっても credential-not-found で保存/通信 0", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });

    const result = await helper(
      ["select", "--artifact", join(repoA, "page.html"), "--origin", stubA.origin, "--profile", "nosuch"],
      { env: { PUBLICAR_URL: stubA.origin, PUBLICAR_API_KEY: stubA.apiKey } }
    );

    expect(result.code).not.toBe(0);
    expect(result.json?.error).toBe("credential-not-found");
    await expect(git(repoA, "config", "--local", "--get", "publicar.endpoint")).rejects.toThrow();
    expect(stubA.requests).toHaveLength(0);
    expect(stubB.requests).toHaveLength(0);
  });

  it("明示 profile があっても env URL 不一致は env-endpoint-mismatch で通信 0 件", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });
    await setEndpoint(repoA, stubA.origin);

    const result = await helper(
      ["create-and-deploy", "--artifact", join(repoA, "page.html"), "--profile", "a"],
      { env: { PUBLICAR_URL: stubB.origin, PUBLICAR_API_KEY: stubB.apiKey } }
    );

    expect(result.code).not.toBe(0);
    expect(result.json?.error).toBe("env-endpoint-mismatch");
    expect(stubA.requests).toHaveLength(0);
    expect(stubB.requests).toHaveLength(0);
  });

  it("origin 一致の env credential があっても明示 --profile の api_key を優先して使う", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });
    await setEndpoint(repoA, stubA.origin);

    // env key は stub が拒否する値。profile key が使われた時だけ成功する
    const result = await helper(
      ["create-and-deploy", "--artifact", join(repoA, "page.html"), "--profile", "a"],
      { env: { PUBLICAR_URL: stubA.origin, PUBLICAR_API_KEY: "pub_wrong_env_key" } }
    );

    expect(result.code).toBe(0);
    const create = stubA.mutations()[0];
    expect(create.authorization).toBe(`Bearer ${stubA.apiKey}`);
    expect(stubB.requests).toHaveLength(0);
  });

  it("git repo 外の artifact は not-in-repo で失敗する", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });

    const result = await helper(["create-and-deploy", "--artifact", join(outside, "page.html")]);

    expect(result.code).not.toBe(0);
    expect(result.json?.error).toBe("not-in-repo");
    expect(stubA.requests).toHaveLength(0);
    expect(stubB.requests).toHaveLength(0);
  });

  it("保存 endpoint が不正値 (path 付き等) なら通信前に失敗する", async () => {
    await writeProfiles({ a: { url: stubA.origin, api_key: stubA.apiKey } });
    await git(repoA, "config", "--local", "publicar.endpoint", `${stubA.origin}/projects/9`);

    const result = await helper(["create-and-deploy", "--artifact", join(repoA, "page.html")]);

    expect(result.code).not.toBe(0);
    expect(result.json?.error).toBe("endpoint-invalid");
    expect(stubA.requests).toHaveLength(0);
    expect(stubB.requests).toHaveLength(0);
  });
});
