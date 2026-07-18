#!/usr/bin/env node
// publicar-deploy helper
//
// artifact が属する git repo の repo-local 設定 `publicar.endpoint` だけを接続先とし、
// repo 解決・credential 照合・project 作成・deploy を一つの fail-closed 経路で行う。
// global current profile・環境変数・引数による別 endpoint への fallback / 一時 override はしない。
// TTY 入力を要求しない (選択肢の提示と選択は呼び出し側 skill の責務)。
//
// commands:
//   select            --artifact <path> --origin <url> [--profile NAME] [--no-open]
//   resolve           --artifact <path> [--profile NAME]
//   change            --artifact <path> --origin <url> [--profile NAME] [--no-open]
//   clear             --artifact <path>
//   create-and-deploy --artifact <file> [--title T] [--profile NAME]
//   deploy            --artifact <file> --project-id <id> [--profile NAME]  (既存 project への再デプロイ)

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import { parseArgs } from "node:util";

const execFileAsync = promisify(execFile);

// ---- 出力: stdout は成功 JSON 1 行、stderr は失敗 JSON 1 行。API key は出力しない ----

function succeed(payload) {
  process.stdout.write(`${JSON.stringify({ ok: true, ...payload })}\n`);
  process.exit(0);
}

function fail(error, message) {
  process.stderr.write(`${JSON.stringify({ ok: false, error, message })}\n`);
  process.exit(1);
}

// ---- endpoint origin の正規化 ----

const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// canonical origin (scheme + host + port のみ) を返す。それ以外の成分を持つ URL は拒否する
function canonicalOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;
  // raw に "?" や "#" が含まれると URL parse で空になる場合があるため原文でも拒否する
  if (raw.includes("?") || raw.includes("#")) return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && LOCALHOST_HOSTS.has(url.hostname)) return url.origin;
  return null;
}

// ---- 対象 repo の解決: CWD ではなく artifact path 基準 ----

async function resolveRepo(artifactPath) {
  const absolute = resolvePath(artifactPath);
  if (!existsSync(absolute)) fail("artifact-not-found", `artifact が存在しません: ${absolute}`);
  // artifact 自体が symlink の場合、配置側 repo の endpoint へリンク先 repo の内容を送れてしまうため
  // 通信前に拒否する (lstat は symlink を辿らない)。祖先 directory の symlink は git -C が
  // 実体側 repo を解決し config と内容の repo が一致するため許容する (Phase 0 追補で実測)
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) {
    fail("artifact-symlink", `artifact が symlink です。実体 path を指定してください: ${absolute}`);
  }
  const baseDir = info.isDirectory() ? absolute : dirname(absolute);
  try {
    const { stdout } = await execFileAsync("git", ["-C", baseDir, "rev-parse", "--show-toplevel"]);
    return { artifact: absolute, baseDir, toplevel: stdout.trim() };
  } catch {
    fail("not-in-repo", `artifact が git repo に属していません: ${absolute}`);
  }
}

async function gitConfigLocal(baseDir, args) {
  return await execFileAsync("git", ["-C", baseDir, "config", "--local", ...args]);
}

// 保存済み endpoint を読む。未設定は null、不正値は endpoint-invalid で停止する
async function readEndpoint(repo) {
  let raw;
  try {
    const { stdout } = await gitConfigLocal(repo.baseDir, ["--get", "publicar.endpoint"]);
    raw = stdout.trim();
  } catch {
    return null;
  }
  const origin = canonicalOrigin(raw);
  if (!origin) fail("endpoint-invalid", `保存済み endpoint が不正です: ${raw}`);
  return origin;
}

// ---- 設定ファイル (~/.publicar) ----

function publicarDir() {
  return join(homedir(), ".publicar");
}

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function writeJsonFile(path, value) {
  await mkdir(dirname(path), { recursive: true });
  // API key を含み得る secret file のため owner 限定 (0600) で保存し、既存 file の mode も矯正する
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

// ---- credential 照合: 保存 endpoint と同一 origin のものだけを許可する ----

// 環境変数は override 手段ではない。設定不一致は通信前に停止する。
// profileExplicit (--profile 明示) 時は URL 不一致検査だけを行い、env を credential として
// 採用せず、不完全な env 設定 (URL のみ / KEY のみ) でも失敗させない (明示 profile を使う)
function guardEnv(endpoint, profileExplicit = false) {
  const envUrl = process.env.PUBLICAR_URL;
  const envKey = process.env.PUBLICAR_API_KEY;
  if (envUrl !== undefined && envUrl !== "") {
    const envOrigin = canonicalOrigin(envUrl);
    if (envOrigin !== endpoint) {
      fail(
        "env-endpoint-mismatch",
        `PUBLICAR_URL (${envUrl}) が repo の保存 endpoint (${endpoint}) と一致しません。環境変数による endpoint override は行いません`
      );
    }
    if (profileExplicit) return null;
    if (envKey !== undefined && envKey !== "") {
      // CI 経路 (--profile 未指定時のみ): origin 一致を検査済みの env credential
      return { alias: aliasFromOrigin(endpoint), apiKey: envKey, source: "env" };
    }
    fail("env-credential-unverifiable", "PUBLICAR_URL に対応する PUBLICAR_API_KEY がありません");
  }
  if (envKey !== undefined && envKey !== "") {
    if (profileExplicit) return null;
    fail("env-credential-unverifiable", "PUBLICAR_API_KEY 単独では endpoint との origin 照合ができません");
  }
  return null;
}

// origin 一致でも api_key が欠落/空なら通信前に停止する (Bearer 空文字での送信を防ぐ)
function requireApiKey(alias, apiKey) {
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    fail("credential-invalid", `profile ${alias} の api_key が欠落または空です`);
  }
}

async function resolveCredential(endpoint, profileName) {
  // env の URL 不一致検査は常に先に行う (override 手段にしないため)
  const envCredential = guardEnv(endpoint, profileName !== undefined);

  const profilesFile = await readJsonFile(join(publicarDir(), "profiles.json"));
  const profiles = profilesFile?.profiles ?? {};
  if (profileName !== undefined) {
    // 明示 profile は env credential より優先し、silent ignore しない
    const profile = profiles[profileName];
    if (!profile) fail("credential-not-found", `profile がありません: ${profileName}`);
    if (canonicalOrigin(profile.url ?? "") !== endpoint) {
      fail(
        "credential-origin-mismatch",
        `profile ${profileName} の origin が repo の保存 endpoint (${endpoint}) と一致しません。endpoint は変更しません`
      );
    }
    requireApiKey(profileName, profile.api_key);
    return { alias: profileName, apiKey: profile.api_key, source: "profile" };
  }
  // env credential は --profile 未指定時だけ採用する
  if (envCredential) return envCredential;
  // global `current` は読まない。origin 一致だけで選ぶ
  const matches = Object.entries(profiles).filter(([, p]) => canonicalOrigin(p?.url ?? "") === endpoint);
  if (matches.length === 0) {
    fail("credential-not-found", `保存 endpoint (${endpoint}) と一致する credential profile がありません`);
  }
  if (matches.length > 1) {
    fail(
      "profile-ambiguous",
      `保存 endpoint (${endpoint}) に複数の profile (${matches.map(([k]) => k).join(", ")}) が一致します。--profile で指定してください`
    );
  }
  const [alias, profile] = matches[0];
  requireApiKey(alias, profile.api_key);
  return { alias, apiKey: profile.api_key, source: "profile" };
}

// ---- CLI 認証フロー (select/change で未登録 origin を登録する) ----

function aliasFromOrigin(origin) {
  const host = new URL(origin).hostname.replace(/^\[|\]$/g, "");
  const stripped = host.replace(/^publicar\./, "");
  const alias = stripped.split(".")[0];
  return alias === "" ? host : alias;
}

async function cliAuthFlow(origin, { noOpen, pollIntervalMs, pollTimeoutMs }) {
  const state = randomBytes(32).toString("base64url");
  const authUrl = `${origin}/auth/cli?state=${state}`;
  process.stderr.write(`auth_url: ${authUrl}\n`);
  if (!noOpen) {
    // ブラウザ起動は best-effort。失敗しても polling は続ける
    try {
      const opener = process.platform === "darwin" ? "open" : "xdg-open";
      execFile(opener, [authUrl], () => {});
    } catch {
      // 開けない環境では auth_url の手動アクセスに任せる
    }
  }
  const deadline = Date.now() + pollTimeoutMs;
  while (Date.now() < deadline) {
    let response;
    try {
      response = await fetch(`${origin}/auth/cli/poll?state=${state}`, {
        signal: AbortSignal.timeout(30_000),
        // 認証 poll も選択 origin を越えない
        redirect: "manual"
      });
    } catch {
      fail("auth-unreachable", `認証エンドポイントへ接続できません: ${origin}`);
    }
    if (response.status >= 300 && response.status < 400) {
      fail("http-redirect-blocked", "認証エンドポイントが redirect を返しました。origin を越える転送は行いません");
    }
    if (response.status === 200) {
      const body = await response.json();
      // 空の api_key を profile として保存しない
      if (body.status === "completed" && typeof body.api_key === "string" && body.api_key.trim() !== "") {
        return body.api_key;
      }
      fail("auth-failed", "認証レスポンスが不正です (api_key 欠落または空)");
    }
    if (response.status === 404) fail("auth-expired", "認証 state が無効または期限切れです");
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  fail("auth-timeout", "認証がタイムアウトしました");
}

// 未登録 origin の profile を profiles.json へ追記する。既存 profile と current は変更しない
async function saveProfile(origin, apiKey, preferredAlias) {
  const path = join(publicarDir(), "profiles.json");
  const existing = (await readJsonFile(path)) ?? null;
  const profiles = existing?.profiles ?? {};
  let alias = preferredAlias ?? aliasFromOrigin(origin);
  let suffix = 2;
  while (profiles[alias] && canonicalOrigin(profiles[alias].url ?? "") !== origin) {
    alias = `${preferredAlias ?? aliasFromOrigin(origin)}-${suffix}`;
    suffix += 1;
  }
  profiles[alias] = { url: origin, api_key: apiKey };
  const next = { current: existing?.current ?? alias, profiles };
  await writeJsonFile(path, next);
  return alias;
}

// 外部 HTTP mutation の前に、派生記録 (~/.publicar/projects.json) の保存先へ実際に
// 書き込めることを検査する。書込不能のまま project を作成すると、記録失敗 → 再実行で
// project を重複作成し得るため、通信 0 件のまま停止する。検査は内容を変更せず、
// 残骸ファイルも残さない (既存 file は書込 open のみ、未存在時は probe を作成後に削除)
async function assertProjectRecordWritable() {
  const dir = publicarDir();
  const file = join(dir, "projects.json");
  try {
    if (existsSync(file)) {
      const handle = await open(file, "r+");
      await handle.close();
    } else {
      await mkdir(dir, { recursive: true });
      const probe = join(dir, `.projects.json.precheck-${process.pid}`);
      const handle = await open(probe, "wx");
      await handle.close();
      await unlink(probe);
    }
  } catch {
    fail(
      "project-record-unwritable",
      `~/.publicar/projects.json へ書き込めません。sandbox 実行では ~/.publicar への書込権限を確保してから helper を起動してください (HTTP 要求は送信していません)`
    );
  }
}

// 通信前検査後に派生記録だけが失敗した場合の部分成功 error。外部作成済みの project 情報を
// 保持して返し、呼び出し側が同じ create を再実行しない判断をできるようにする
function failRecordAfterMutation(created) {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      error: "project-record-failed",
      message:
        "project は endpoint 上で作成/デプロイ済みだが、~/.publicar/projects.json への派生記録に失敗した。同じ create を再実行せず、created の project を使って記録を手動同期すること",
      created
    })}\n`
  );
  process.exit(1);
}

// ---- deploy 派生記録: comment-loop が読む <profile>/<projectId> 形式を維持する ----

async function recordProject(alias, projectId, record) {
  const path = join(publicarDir(), "projects.json");
  const projects = (await readJsonFile(path)) ?? {};
  projects[alias] = projects[alias] ?? {};
  // 既存 record の項目 (alias 等) を保持したまま更新分だけ merge する
  projects[alias][projectId] = { ...projects[alias][projectId], ...record };
  await writeJsonFile(path, projects);
}

// ---- HTTP (project 作成 + deploy)。ここまでの全検査を通過した endpoint だけに送る ----

async function apiRequest(endpoint, apiKey, path, init) {
  let response;
  try {
    response = await fetch(`${endpoint}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(60_000),
      // redirect を追うと artifact 本文や Authorization が非選択 origin へ転送され得るため遮断する
      redirect: "manual"
    });
  } catch {
    fail("http-unreachable", `endpoint へ接続できません: ${endpoint}`);
  }
  if (response.status >= 300 && response.status < 400) {
    fail("http-redirect-blocked", `endpoint が redirect (${response.status}) を返しました。origin を越える転送は行いません (${path.split("?")[0]})`);
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    // 非 JSON レスポンスは status だけで判定する
  }
  if (!response.ok) {
    fail("http-error", `API が失敗しました: ${response.status} ${body?.error ?? ""} (${path.split("?")[0]})`);
  }
  return body;
}

// directory バンドル派生元の検証 (TASK-017 lead確定項目)。publish 済み一時 index を deploy する時、
// 一時 directory は終了時に削除されるため派生記録には元 directory を残す (comment-loop が localDir を参照)。
// 通信前に 実在 / 非 symlink / directory / renderer-manifest.json / artifact と同一 repo を検証する
async function validateBundleRoot(bundleRootArg, repo) {
  const absolute = resolvePath(bundleRootArg);
  if (!existsSync(absolute)) fail("bundle-root-invalid", `--bundle-root が存在しません: ${absolute}`);
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) fail("bundle-root-invalid", `--bundle-root が symlink です: ${absolute}`);
  if (!info.isDirectory()) fail("bundle-root-invalid", `--bundle-root が directory ではありません: ${absolute}`);
  if (!existsSync(join(absolute, "renderer-manifest.json"))) {
    fail("bundle-root-invalid", `--bundle-root に renderer-manifest.json がありません: ${absolute}`);
  }
  let toplevel;
  try {
    const { stdout } = await execFileAsync("git", ["-C", absolute, "rev-parse", "--show-toplevel"]);
    toplevel = stdout.trim();
  } catch {
    fail("bundle-root-invalid", `--bundle-root が git repo に属していません: ${absolute}`);
  }
  if (toplevel !== repo.toplevel) {
    fail("bundle-root-mismatch", `--bundle-root の repo (${toplevel}) が artifact の repo (${repo.toplevel}) と一致しません`);
  }
  return absolute;
}

const CONTENT_TYPES = new Map([
  [".html", "text/html"],
  [".htm", "text/html"],
  [".zip", "application/zip"]
]);

function classifyArtifact(artifact) {
  const ext = extname(artifact).toLowerCase();
  const contentType = CONTENT_TYPES.get(ext);
  if (!contentType) {
    fail("artifact-unsupported", `対応していない artifact 種別です (.html/.htm/.zip のみ): ${artifact}`);
  }
  return contentType === "application/zip"
    ? { contentType, sourceKind: "zip", query: `name=${encodeURIComponent(basename(artifact))}` }
    : { contentType, sourceKind: "single-html", query: `path=${encodeURIComponent(basename(artifact))}` };
}

// ---- commands ----

async function commandSelect({ artifact, origin, profile, noOpen, pollIntervalMs, pollTimeoutMs }, { allowOverwrite }) {
  const repo = await resolveRepo(artifact);
  if (origin === undefined) fail("usage", "--origin <url> が必要です");
  const canonical = canonicalOrigin(origin);
  if (!canonical) {
    fail("endpoint-invalid", `endpoint は canonical origin (https、localhost のみ http 可、path/query/fragment/userinfo なし) で指定してください: ${origin}`);
  }
  const current = await readEndpoint(repo);
  if (!allowOverwrite && current !== null && current !== canonical) {
    fail("endpoint-already-set", `endpoint は設定済みです (${current})。変更は change を使ってください`);
  }

  // 環境変数の不一致は保存前にも検査する (保存後の deploy が必ず失敗する状態を作らない)
  // env の URL 不一致検査は常に先に行う
  const envCredential = guardEnv(canonical, profile !== undefined);
  let alias;
  {
    const profilesFile = await readJsonFile(join(publicarDir(), "profiles.json"));
    const profiles = profilesFile?.profiles ?? {};
    if (profile !== undefined) {
      // 明示 profile は存在必須。別 profile や CLI 認証への silent fallback をしない
      if (!profiles[profile]) {
        fail("credential-not-found", `profile がありません: ${profile}`);
      }
      // origin 一致と api_key を保存前・通信前に検証する
      if (canonicalOrigin(profiles[profile].url ?? "") !== canonical) {
        fail("credential-origin-mismatch", `profile ${profile} の origin が指定 origin (${canonical}) と一致しません`);
      }
      requireApiKey(profile, profiles[profile].api_key);
      alias = profile;
    } else if (envCredential) {
      // env credential は --profile 未指定時だけ採用する (CI 経路)
      alias = envCredential.alias;
    } else {
      const matches = Object.entries(profiles).filter(([, p]) => canonicalOrigin(p?.url ?? "") === canonical);
      if (matches.length === 1) {
        requireApiKey(matches[0][0], matches[0][1].api_key);
        alias = matches[0][0];
      } else if (matches.length > 1) {
        fail("profile-ambiguous", `origin (${canonical}) に複数の profile (${matches.map(([k]) => k).join(", ")}) が一致します。--profile で指定してください`);
      } else {
        // 未登録 origin (--profile 未指定時のみ): CLI 認証フローで profile を登録してから保存する
        const apiKey = await cliAuthFlow(canonical, { noOpen, pollIntervalMs, pollTimeoutMs });
        alias = await saveProfile(canonical, apiKey, undefined);
      }
    }
  }

  await gitConfigLocal(repo.baseDir, ["publicar.endpoint", canonical]);
  succeed({ command: allowOverwrite ? "change" : "select", repo: repo.toplevel, endpoint: canonical, profile: alias });
}

async function commandResolve({ artifact, profile }) {
  const repo = await resolveRepo(artifact);
  const endpoint = await readEndpoint(repo);
  if (endpoint === null) {
    fail("endpoint-not-set", `repo (${repo.toplevel}) に publicar.endpoint が未設定です。select で保存してください`);
  }
  const credential = await resolveCredential(endpoint, profile);
  succeed({ command: "resolve", repo: repo.toplevel, endpoint, profile: credential.alias });
}

async function commandClear({ artifact }) {
  const repo = await resolveRepo(artifact);
  try {
    await gitConfigLocal(repo.baseDir, ["--unset", "publicar.endpoint"]);
  } catch {
    // 未設定の clear は冪等に成功させる
  }
  succeed({ command: "clear", repo: repo.toplevel });
}

async function commandCreateAndDeploy({ artifact, title, profile, bundleRoot }) {
  const repo = await resolveRepo(artifact);
  const info = await stat(repo.artifact);
  if (info.isDirectory()) {
    fail("artifact-unsupported", "create-and-deploy はファイル (.html/.htm/.zip) を指定してください。directory バンドルは publish 済み HTML を渡してください");
  }
  const endpoint = await readEndpoint(repo);
  if (endpoint === null) {
    fail("endpoint-not-set", `repo (${repo.toplevel}) に publicar.endpoint が未設定です。select で保存してください (CI では実行前に git config --local publicar.endpoint を設定)`);
  }
  const { contentType, sourceKind, query } = classifyArtifact(repo.artifact);
  const bundleDir = bundleRoot === undefined ? null : await validateBundleRoot(bundleRoot, repo);
  const credential = await resolveCredential(endpoint, profile);
  await assertProjectRecordWritable();

  // ここから先だけが HTTP。宛先は検査済みの endpoint のみ
  const projectTitle = title ?? basename(repo.artifact, extname(repo.artifact));
  const created = await apiRequest(endpoint, credential.apiKey, "/api/v1/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: projectTitle })
  });
  const project = created?.project;
  if (!project?.id || !project?.alias) fail("http-error", "project 作成レスポンスが不正です");

  const content = await readFile(repo.artifact);
  const deployed = await apiRequest(
    endpoint,
    credential.apiKey,
    `/api/v1/projects/${encodeURIComponent(project.id)}/deploy?${query}`,
    { method: "POST", headers: { "Content-Type": contentType }, body: content }
  );
  const url = deployed?.url ?? created?.url ?? null;

  // directory バンドル由来は一時 publish 出力でなく元 directory を記録する
  const recordDir = bundleDir ?? repo.baseDir;
  const recordKind = bundleDir === null ? sourceKind : "directory";
  try {
    await recordProject(credential.alias, project.id, {
      localDir: recordDir,
      alias: project.alias,
      url,
      sourceKind: recordKind,
      lastSyncedAt: new Date().toISOString()
    });
  } catch {
    failRecordAfterMutation({ id: project.id, alias: project.alias, url, endpoint });
  }

  succeed({
    command: "create-and-deploy",
    repo: repo.toplevel,
    endpoint,
    profile: credential.alias,
    project: { id: project.id, alias: project.alias },
    url,
    localDir: recordDir,
    sourceKind: recordKind
  });
}

// 既存 project への再デプロイ (comment-loop 互換)。project は作成せず、明示された ID だけへ deploy する
async function commandDeploy({ artifact, projectId, profile, bundleRoot }) {
  if (projectId === undefined || projectId.trim() === "") {
    fail("usage", "--project-id <id> に空でない project ID が必要です");
  }
  const repo = await resolveRepo(artifact);
  const info = await stat(repo.artifact);
  if (info.isDirectory()) {
    fail("artifact-unsupported", "deploy はファイル (.html/.htm/.zip) を指定してください");
  }
  const endpoint = await readEndpoint(repo);
  if (endpoint === null) {
    fail("endpoint-not-set", `repo (${repo.toplevel}) に publicar.endpoint が未設定です。select で保存してください`);
  }
  const { contentType, sourceKind, query } = classifyArtifact(repo.artifact);
  const bundleDir = bundleRoot === undefined ? null : await validateBundleRoot(bundleRoot, repo);
  const credential = await resolveCredential(endpoint, profile);
  await assertProjectRecordWritable();

  // ここから先だけが HTTP。project 作成 API は呼ばない
  const content = await readFile(repo.artifact);
  const deployed = await apiRequest(
    endpoint,
    credential.apiKey,
    `/api/v1/projects/${encodeURIComponent(projectId)}/deploy?${query}`,
    { method: "POST", headers: { "Content-Type": contentType }, body: content }
  );
  const url = deployed?.url ?? null;

  // project ID は repo-local 設定へ保存せず、派生記録の更新だけを行う (alias は既存値を保持)
  const recordDir = bundleDir ?? repo.baseDir;
  const recordKind = bundleDir === null ? sourceKind : "directory";
  try {
    await recordProject(credential.alias, projectId, {
      localDir: recordDir,
      url,
      sourceKind: recordKind,
      lastSyncedAt: new Date().toISOString()
    });
  } catch {
    failRecordAfterMutation({ id: projectId, alias: null, url, endpoint });
  }

  succeed({
    command: "deploy",
    repo: repo.toplevel,
    endpoint,
    profile: credential.alias,
    project: { id: projectId },
    url,
    localDir: recordDir,
    sourceKind: recordKind
  });
}

// ---- entrypoint ----

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        artifact: { type: "string" },
        origin: { type: "string" },
        profile: { type: "string" },
        title: { type: "string" },
        "project-id": { type: "string" },
        "bundle-root": { type: "string" },
        "no-open": { type: "boolean" },
        "poll-interval-ms": { type: "string" },
        "poll-timeout-ms": { type: "string" }
      },
      allowPositionals: false
    });
  } catch (error) {
    fail("usage", error instanceof Error ? error.message : "引数が不正です");
  }
  const values = parsed.values;
  if (values.artifact === undefined) fail("usage", "--artifact <path> が必要です");
  const options = {
    artifact: values.artifact,
    origin: values.origin,
    profile: values.profile,
    title: values.title,
    projectId: values["project-id"],
    bundleRoot: values["bundle-root"],
    noOpen: values["no-open"] ?? false,
    pollIntervalMs: Number(values["poll-interval-ms"] ?? 3000),
    pollTimeoutMs: Number(values["poll-timeout-ms"] ?? 300_000)
  };

  switch (command) {
    case "select":
      return await commandSelect(options, { allowOverwrite: false });
    case "change":
      return await commandSelect(options, { allowOverwrite: true });
    case "resolve":
      return await commandResolve(options);
    case "clear":
      return await commandClear(options);
    case "create-and-deploy":
      if (options.projectId !== undefined) {
        fail("usage", "create-and-deploy は project を新規作成します。既存 project へは deploy --project-id を使ってください");
      }
      return await commandCreateAndDeploy(options);
    case "deploy":
      return await commandDeploy(options);
    default:
      fail("usage", `不明な command です: ${command ?? "(なし)"}`);
  }
}

main().catch((error) => {
  fail("internal", error instanceof Error ? error.message : String(error));
});
