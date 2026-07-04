---
name: publicar-deploy
description: |
  HTML/ZIPをpublicarにデプロイして共有URLを取得する。Deploy HTML/ZIP files to publicar and get shareable URLs. Triggers: publicarにデプロイ, publicar deploy, HTMLを共有, 共有URLを発行, publicarで配信, publicar にアップロード, deploy to publicar, share HTML via publicar, upload ZIP to publicar。使用しない場面: publicarのサーバー側開発、Workers設定変更。Do not use for: developing publicar itself, modifying Workers config.
argument-hint: "[HTMLファイルパスまたはZIPパス] [--project-id ID] [--profile NAME]"
---

# publicar デプロイ

publicar は HTML/ZIP ファイルを共有 URL で配信するサービス。

## Role

Deploy HTML files or ZIP archives to publicar via its REST API. Handle project creation, file deployment, and URL retrieval. This skill uses curl commands with API key authentication — no CLI tool or local installation is required.

## 言語方針 / Language behavior

ユーザーの最新リクエストの言語に合わせて応答する。Follow the language of the latest user request.

## 前提

接続先の解決順序:

1. `--profile NAME` 引数があれば `~/.publicar/profiles.json` の該当プロファイルを使用
2. 環境変数 `PUBLICAR_URL` + `PUBLICAR_API_KEY` が両方設定されていればそちらを使用
3. `~/.publicar/profiles.json` が存在すれば `current` プロファイルを使用
4. いずれもなければユーザーに URL を確認し、CLI 認証フローで API キーを取得する

### 接続先の明示

デプロイ操作の開始時に、必ず接続先をユーザーに表示する:

```
接続先: publicar.company.com (work)
```

形式は `<ドメイン> (<エイリアス>)` とする。環境変数経由の場合はエイリアスなしでドメインのみ表示する:

```
接続先: publicar.company.com
```

## 認証 (API キーの自動取得)

`PUBLICAR_API_KEY` が未設定の場合、CLI 認証フローで自動取得する:

### 1. state トークンを生成

```bash
CLI_STATE=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
```

### 2. ブラウザで認証ページを開く

```bash
open "$PUBLICAR_URL/auth/cli?state=$CLI_STATE"
```

ユーザーに「ブラウザで Google 認証を完了してください」と伝える。

### 3. ポーリングで API キーを取得

3 秒間隔でポーリングする。最大 5 分で期限切れになる。

```bash
RESULT=$(curl -s "$PUBLICAR_URL/auth/cli/poll?state=$CLI_STATE")
```

レスポンスの `status` フィールドを確認:
- `"pending"` (HTTP 202): 認証待ち。3 秒後に再ポーリング
- `"completed"` (HTTP 200): API キー取得成功。`api_key` フィールドに `pub_...` 形式のキー
- HTTP 404: state が無効または期限切れ。フローを最初からやり直す

### 4. API キーを保存して使用

取得した API キーを `PUBLICAR_API_KEY` として以降の API 呼び出しに使用する。

取得した接続情報は **必ず** `~/.publicar/profiles.json` に保存する（ユーザーが明示的に「保存しないで」と指示した場合のみ省略可）。

エイリアス名の決定:
- `--profile NAME` が指定されている場合: その名前を使用
- 指定がない場合: ドメインから自動生成（`publicar.clinial.co.jp` → `clinial`、`publicar.example.com` → `example`）
- 生成ルール: ホスト名から `publicar.` プレフィックスを除去し、最初のドットの前を取る

profiles.json が存在しない場合は新規作成し、`current` にも設定する。既に他のプロファイルがある場合は追加のみ（`current` は変更しない）。

デプロイ完了の報告時に「保存した profile 名」を明記する:
```
保存先プロファイル: clinial (~/.publicar/profiles.json)
```

詳細は下記「接続先プロファイル」セクションを参照。

## 接続先プロファイル

複数の publicar サーバーを使い分けるためのプロファイル管理。

### profiles.json の形式

`~/.publicar/profiles.json`:

```json
{
  "current": "work",
  "profiles": {
    "work": {
      "url": "https://publicar.company.com",
      "api_key": "pub_abc..."
    },
    "personal": {
      "url": "https://publicar.personal.com",
      "api_key": "pub_xyz..."
    }
  }
}
```

- キー名 (`work`, `personal`) がエイリアス
- `current` は `--profile` 省略時に使用するデフォルトプロファイル

### プロファイル操作

**一覧表示**:
```bash
cat ~/.publicar/profiles.json | jq '{current, profiles: (.profiles | to_entries | map({key, domain: (.value.url | gsub("https?://"; ""))}) | from_entries)}'
```

**切り替え**:
```bash
# profiles.json の "current" を更新
cat ~/.publicar/profiles.json | jq '.current = "personal"' > ~/.publicar/profiles.json.tmp && mv ~/.publicar/profiles.json.tmp ~/.publicar/profiles.json
```

**新規追加** (CLI 認証フロー完了後、自動実行):
```bash
# 認証で取得した URL と API キーをプロファイルに保存
cat ~/.publicar/profiles.json | jq --arg name "<エイリアス>" --arg url "<URL>" --arg key "<API_KEY>" \
  '.profiles[$name] = {url: $url, api_key: $key} | .current = $name' \
  > ~/.publicar/profiles.json.tmp && mv ~/.publicar/profiles.json.tmp ~/.publicar/profiles.json
```

profiles.json が存在しない場合は新規作成する:
```bash
mkdir -p ~/.publicar
cat > ~/.publicar/profiles.json <<PROF
{
  "current": "<エイリアス>",
  "profiles": {
    "<エイリアス>": {
      "url": "<URL>",
      "api_key": "<API_KEY>"
    }
  }
}
PROF
```

## directory バンドル (renderer-manifest.json) の自動検出

デプロイ対象ディレクトリに `renderer-manifest.json` が存在する場合、
`renderer-manifest.json` を含む directory バンドル (reviewable-html-workbench 等で生成) と判断し、
デプロイ前に `publish` CLI でレビュー UI を除去した公開用 HTML を生成する。

手順:
1. デプロイ対象に `renderer-manifest.json` があるか確認
2. ある場合、reviewable-html-workbench plugin の配置先を特定
3. publish CLI を実行:
   ```bash
   cd <rhw-repo-root> && python3 -m scripts.html_review_workbench.cli publish \
     --root <デプロイ対象> --output <一時ディレクトリ>
   ```
4. publish 出力（standalone index.html）を単一 HTML としてデプロイ（2a の手順）

publish は CSS インライン化・画像 embed 済みの standalone HTML を生成するため、
ZIP デプロイではなく単一 HTML デプロイを使用する。
publish は Python stdlib のみで動作し、外部依存のインストールは不要。

## 手順

### 1. プロジェクト作成（初回のみ）

既存プロジェクトにデプロイする場合はスキップ。

```bash
curl -s -X POST "$PUBLICAR_URL/api/v1/projects" \
  -H "Authorization: Bearer $PUBLICAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title": "<プロジェクト名>"}' | jq .
```

レスポンスの `project.id` を記録する。

### 2a. 単一 HTML デプロイ

```bash
curl -s -X POST "$PUBLICAR_URL/api/v1/projects/<PROJECT_ID>/deploy?path=index.html" \
  -H "Authorization: Bearer $PUBLICAR_API_KEY" \
  -H "Content-Type: text/html" \
  --data-binary @<HTMLファイルパス> | jq .
```

### 2b. ZIP デプロイ（複数ファイル）

```bash
curl -s -X POST "$PUBLICAR_URL/api/v1/projects/<PROJECT_ID>/deploy?name=site.zip" \
  -H "Authorization: Bearer $PUBLICAR_API_KEY" \
  -H "Content-Type: application/zip" \
  --data-binary @<ZIPファイルパス> | jq .
```

ZIP デプロイはクリーンデプロイ: ZIP に含まれないファイルは自動削除される。
`__MACOSX/`, `.DS_Store`, `Thumbs.db` は自動除外。

### 3. 共有 URL

デプロイレスポンスの `url` フィールドが共有 URL。

### 4. projects.json への同期

デプロイ成功時は、次回以降の comment loop がローカル成果物を解決できるように `~/.publicar/projects.json` の `<profile>/<projectId>` へ次の値を追記・更新する。

- `localDir`: デプロイ元のディレクトリまたは HTML/ZIP ファイルの親パス
- `alias`: publicar project の alias
- `url`: デプロイ後の共有 URL
- `sourceKind`: `directory` / `single-html` / `zip`
- `lastSyncedAt`: 同期時刻の ISO timestamp

既存の `profiles.json` は認証情報の管理元として維持し、`projects.json` には project とローカル成果物の対応だけを保存する。

## エラー対処

- 401: API キーが無効または期限切れ。`PUBLICAR_API_KEY` を確認
- 403: スコープ不足。API キーに `deploy` スコープが必要
- 400: リクエスト形式不正。Content-Type とクエリパラメータを確認
- 413: ファイルサイズ超過（デフォルト上限: 5MB）

## API 仕様

詳細は `GET $PUBLICAR_URL/api/v1/openapi.json` または `GET $PUBLICAR_URL/llms.txt` を参照。

### エンドポイント一覧

- `POST   /api/v1/projects`             — プロジェクト作成
- `GET    /api/v1/projects`             — プロジェクト一覧
- `GET    /api/v1/projects/{id}`        — プロジェクト詳細
- `PATCH  /api/v1/projects/{id}`        — プロジェクト更新
- `DELETE /api/v1/projects/{id}`        — プロジェクト削除
- `POST   /api/v1/projects/{id}/deploy` — ファイルデプロイ
- `GET    /api/v1/api-keys`             — API キー一覧
- `POST   /api/v1/api-keys`             — API キー発行
- `DELETE /api/v1/api-keys/{id}`        — API キー削除
- `GET    /auth/cli`                   — CLI 認証フロー開始
- `GET    /auth/cli/callback`          — CLI 認証コールバック
- `GET    /auth/cli/poll`              — CLI 認証ポーリング
