---
name: publicar-deploy
description: |
  HTML/ZIPをpublicarにデプロイして共有URLを取得する。Deploy HTML/ZIP files to publicar and get shareable URLs. Triggers: publicarにデプロイ, publicar deploy, HTMLを共有, 共有URLを発行, publicarで配信, publicar にアップロード, deploy to publicar, share HTML via publicar, upload ZIP to publicar。使用しない場面: publicarのサーバー側開発、Workers設定変更。Do not use for: developing publicar itself, modifying Workers config.
argument-hint: "[HTMLファイルパスまたはZIPパス] [--project-id ID] [--profile NAME]"
---

# publicar デプロイ

publicar は HTML/ZIP ファイルを共有 URL で配信するサービス。

## Role

Deploy HTML files or ZIP archives to publicar via the bundled helper script. The helper resolves the target repo from the artifact path, reads the repo-local endpoint, verifies credentials, creates a project, and deploys — all in one fail-closed path.

## 言語方針 / Language behavior

ユーザーの最新リクエストの言語に合わせて応答する。Follow the language of the latest user request.

## 接続先の決定 (repo-local endpoint)

接続先は **artifact が属する git repo の repo-local 設定 `publicar.endpoint`** だけを使う。

- 保存場所: `git config --local publicar.endpoint` (`.git/config`)。repo の追跡ファイルには保存されない
- CWD ではなく **デプロイ対象ファイルのパス** が属する repo を基準にする
- global の current profile、環境変数、引数による別 endpoint への fallback / 一時上書きはしない
- endpoint 未設定の repo では、下記「初回の endpoint 選択」を完了するまで通信しない
- project はデプロイ内容ごとに選択済み endpoint 上で新規作成する。project ID や alias を repo 設定に保存・固定しない

すべての設定・認証・API 通信は helper (`scripts/publicar-deploy.mjs`) が行う。
**endpoint や API key を使った curl コマンドをこの skill の手順として組み立てない。**

## helper コマンド

`<skill-dir>/scripts/publicar-deploy.mjs` を node で実行する。成功時は stdout に JSON 1 行、失敗時は stderr に `{"ok":false,"error":"<code>","message":"..."}` を返し、TTY 入力を要求しない。

```bash
HELPER=<skill-dir>/scripts/publicar-deploy.mjs

# 現在の設定を確認 (repo / endpoint / 使用 profile)
node "$HELPER" resolve --artifact <デプロイ対象パス>

# 初回の endpoint 保存 (origin はユーザーが選択したもの)
node "$HELPER" select --artifact <デプロイ対象パス> --origin https://publicar.example.com

# endpoint の明示変更 / 解除
node "$HELPER" change --artifact <デプロイ対象パス> --origin https://other.example.com
node "$HELPER" clear --artifact <デプロイ対象パス>

# project 作成 + デプロイ (HTML または ZIP)
node "$HELPER" create-and-deploy --artifact <HTMLまたはZIPパス> [--title "タイトル"] [--profile NAME]

# 既存 project への再デプロイ (--project-id 指定時。comment-loop の再デプロイが使う)
node "$HELPER" deploy --artifact <HTMLまたはZIPパス> --project-id <ID> [--profile NAME]
```

`--origin` は canonical origin (scheme + host + port) のみ受け付ける。HTTPS 必須 (localhost だけ HTTP 可)、path / query / fragment / userinfo 付きは拒否される。

## デプロイ手順

### 1. 接続先の確認と明示

`resolve` を実行し、結果をユーザーに表示する:

```
接続先: publicar.company.com (work)
```

形式は `<ドメイン> (<profile 名>)`。

### 2. 初回の endpoint 選択 (resolve が endpoint-not-set のとき)

1. `~/.publicar/profiles.json` があれば登録済み origin 一覧を表示する (読み取りのみ):
   ```bash
   jq -r '.profiles | to_entries[] | "\(.key): \(.value.url)"' ~/.publicar/profiles.json
   ```
2. ユーザーに「登録済み origin から選択」または「新しい origin を入力」を提示する
3. 選択された origin で `select --origin <URL>` を実行する
   - 未登録 origin の場合、helper が CLI 認証フローを開始し stderr に `auth_url:` を表示してブラウザを開く。ユーザーに「ブラウザで Google 認証を完了してください」と伝える。認証完了後、helper が profile を `~/.publicar/profiles.json` へ保存し、endpoint を repo-local 設定へ保存する

選択・確認は skill (agent) がユーザーと行い、helper は `--origin` を機械入力として受けるだけで対話しない。

### 3. デプロイ

```bash
node "$HELPER" create-and-deploy --artifact <パス> --title "<タイトル>"
```

- `.html` / `.htm`: 単一 HTML デプロイ
- `.zip`: ZIP デプロイ (クリーンデプロイ: ZIP に含まれないファイルは自動削除。`__MACOSX/`, `.DS_Store`, `Thumbs.db` は自動除外)

成功 JSON の `url` が共有 URL。`project.id` / `project.alias` / `profile` も含まれるので完了報告に使う。

**既存 project への再デプロイ** (`--project-id ID` が指定された場合、comment-loop の revise 後など):

```bash
node "$HELPER" deploy --artifact <パス> --project-id <ID> [--profile NAME]
```

- project は新規作成されない (project 作成 API を呼ばない)
- endpoint 解決と credential の origin 一致検査は create-and-deploy と同じ fail-closed 経路
- project ID は repo-local 設定へ保存されない (引数として渡すだけ)

### 4. デプロイ後の報告

- 共有 URL
- 接続先 (`endpoint` と `profile`)
- 新規作成された project の alias

## directory バンドル (renderer-manifest.json) の自動検出

デプロイ対象ディレクトリに `renderer-manifest.json` が存在する場合、
directory バンドル (reviewable-html-workbench 等で生成) と判断し、
デプロイ前に `publish` CLI でレビュー UI を除去した公開用 HTML を生成する。

手順:
1. デプロイ対象に `renderer-manifest.json` があるか確認
2. ある場合、reviewable-html-workbench plugin の配置先を特定
3. 一時 directory 作成 (mktemp + trap)、publish、helper デプロイまでを **必ず同一 shell invocation 内で実行する**。trap は shell 終了時に発火するため、code block を分割して別々の shell で実行すると publish や deploy の前に一時 directory が削除される。

publish の出力先は、**元 directory が属する git repo の root 直下**に mktemp で新規作成した一意な一時 directory を使う (固定名や既存 directory を使わない)。

未設定の shell 変数による実行時分岐は書かず、呼び出し引数の `--project-id` 有無で **次の 2 つの独立 template から必ず一方だけを選ぶ**。`--title` / `--profile` も未設定 shell 変数に依存させず、呼び出し引数に存在する場合だけ agent が `set --` 行の末尾へ明示的に追加する (「:+」条件展開で flag と値を 1 展開にまとめる形式は zsh で 1 引数に畳まれるため使わない)。

**既存 project への再デプロイ** (`--project-id` が指定されている場合。comment-loop の再デプロイ等。project は作成しない。`<project ID>` は空でない値を必ず埋める):

```bash
REPO_ROOT=$(git -C <デプロイ対象> rev-parse --show-toplevel)
PUB_TMP=$(mktemp -d "$REPO_ROOT/.publicar-publish.XXXXXX")
cleanup() {
  if [ -f "$PUB_TMP/index.html" ]; then rm -- "$PUB_TMP/index.html"; fi
  rmdir -- "$PUB_TMP"
}
trap cleanup EXIT

(cd <rhw-repo-root> && python3 -m scripts.html_review_workbench.cli publish \
  --root <デプロイ対象> --output "$PUB_TMP")

set -- deploy --artifact "$PUB_TMP/index.html" --project-id "<project ID>" --bundle-root <デプロイ対象>
node "$HELPER" "$@"
```

**新規公開** (`--project-id` が無い場合。project を新規作成する。project-id を渡さない):

```bash
REPO_ROOT=$(git -C <デプロイ対象> rev-parse --show-toplevel)
PUB_TMP=$(mktemp -d "$REPO_ROOT/.publicar-publish.XXXXXX")
cleanup() {
  if [ -f "$PUB_TMP/index.html" ]; then rm -- "$PUB_TMP/index.html"; fi
  rmdir -- "$PUB_TMP"
}
trap cleanup EXIT

(cd <rhw-repo-root> && python3 -m scripts.html_review_workbench.cli publish \
  --root <デプロイ対象> --output "$PUB_TMP")

set -- create-and-deploy --artifact "$PUB_TMP/index.html" --bundle-root <デプロイ対象>
node "$HELPER" "$@"
```

補足:
- OS の一時ディレクトリや CWD 基準の出力先は使わない。repo 外へ出力した index.html を helper へ渡すと `not-in-repo` で停止し、派生 artifact の endpoint は元 directory と同じ repo の repo-local 設定に固定する必要があるため
- 一時 directory は trap の cleanup により、デプロイの成功・失敗にかかわらず shell 終了時に片付けられる。再帰的強制削除は使わず、publish が生成する `index.html` だけを明示 path で削除してから `rmdir -- "$PUB_TMP"` (空 directory のみ削除) を実行する。想定外のファイルがあった場合は削除されず directory が残るため、内容を確認してから手動で片付ける (quote と `--` を必ず付ける)
- `--bundle-root <元directory>` を両分岐で必ず渡す。一時 directory は削除されるため、helper は projects.json の `localDir` に元 directory、`sourceKind` に `directory` を記録する。helper は bundle-root の実在・非 symlink・`renderer-manifest.json` の存在・artifact と同一 repo を通信前に検証し、別 repo の bundle-root は `bundle-root-mismatch` で通信前に拒否する

publish は Python stdlib のみで動作し、外部依存のインストールは不要。

## credential と CI

- API key は従来どおり `~/.publicar/profiles.json` (または CI secret) で管理する。helper は保存済み endpoint と **同一 origin** の credential だけを使う
- 同一 origin に複数 profile がある場合は `profile-ambiguous` で停止する。ユーザーに選んでもらい `--profile NAME` を付けて再実行する
- CI (非対話) では実行前に次の 2 点を設定する。未設定なら helper は通信前に失敗する
  1. `git config --local publicar.endpoint <origin>` を明示設定
  2. `PUBLICAR_URL` (保存 endpoint と同一 origin) + `PUBLICAR_API_KEY` を secret で注入
- `PUBLICAR_URL` が保存 endpoint と異なる場合、helper は通信前に `env-endpoint-mismatch` で停止する (環境変数で別 endpoint へ送る手段はない)

## projects.json への同期

deploy 成功時、helper が `~/.publicar/projects.json` の `<profile>/<projectId>` へ
`localDir` / `alias` / `url` / `sourceKind` / `lastSyncedAt` を追記する (comment loop が参照する)。
`profiles.json` は認証情報の管理元として維持され、endpoint 選択の管理元には使われない。

## エラー対処 (helper の error code)

- `endpoint-not-set`: repo に endpoint 未設定。「初回の endpoint 選択」を実施
- `endpoint-invalid`: 保存値または `--origin` が canonical origin でない。URL を確認
- `endpoint-already-set`: select 済み。変更したい場合は `change` を使う
- `not-in-repo`: artifact が git repo 外。repo 内へ移すか対象を確認
- `credential-not-found` / `credential-origin-mismatch`: endpoint と一致する profile がない。`select` で認証するか profile を確認
- `credential-invalid`: profile の api_key が欠落または空。`select` で再認証して profile を保存し直す
- `profile-ambiguous`: `--profile NAME` を付けて再実行
- `env-endpoint-mismatch` / `env-credential-unverifiable`: 環境変数が保存 endpoint と不整合。env を外すか一致させる
- `http-error`: API 失敗。message 内の HTTP status を確認 (401: API key 無効、403: スコープ不足、413: サイズ超過)

## API 仕様

詳細は `GET <endpoint>/api/v1/openapi.json` または `GET <endpoint>/llms.txt` を参照。
project の一覧・詳細・更新・削除など deploy 以外の操作は本 skill の対象外。
