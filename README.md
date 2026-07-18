# publicar-skill

Claude Code / Codex から publicar を操作するための plugin repo。plugin 名は既存インストールとの互換性を保つため `publicar` のまま維持する。

publicar 本体は https://github.com/u-ichi/publicar を参照する。API 互換性の基準は publicar 本体が配信する `/api/v1/openapi.json`。

## Skills

- `publicar-deploy`: HTML / ZIP を publicar にアップロードし、共有 URL を取得する。
- `publicar-comment-loop`: publicar の公開 URL に付いたコメントを読み、返信案、HTML 修正案、承認後の反映と再デプロイを支援する。

## Endpoint の選択 (repo ごと)

デプロイ先 endpoint は **artifact が属する git repo の repo-local 設定 `publicar.endpoint`** だけを使う。
利用者ごとに endpoint URL が異なりうるため、repo の追跡ファイルには保存しない。
global の current profile・環境変数・引数による別 endpoint への fallback / 一時上書きは行わず、
endpoint 未設定の repo では通信前に停止する (誤爆防止)。

操作はすべて helper (`skills/publicar-deploy/scripts/publicar-deploy.mjs`) 経由:

```bash
HELPER=skills/publicar-deploy/scripts/publicar-deploy.mjs

# 登録 (初回): 選んだ origin を repo-local 設定へ保存する。
# 未登録 origin は CLI 認証フロー (ブラウザ) で profile を ~/.publicar/profiles.json へ登録してから保存する
node "$HELPER" select --artifact <デプロイ対象> --origin https://publicar.example.com

# 確認 / 変更 / 解除
node "$HELPER" resolve --artifact <デプロイ対象>
node "$HELPER" change  --artifact <デプロイ対象> --origin https://other.example.com
node "$HELPER" clear   --artifact <デプロイ対象>

# project 作成 + デプロイ (project はデプロイ内容ごとに新規作成される)
node "$HELPER" create-and-deploy --artifact <HTMLまたはZIP> [--title "タイトル"] [--profile NAME]
```

- repo-local 設定に保存されるのは endpoint の canonical origin だけ。project ID / alias / API key は保存されない
- API key は従来どおり `~/.publicar/profiles.json` (または CI secret) が管理元。helper は保存 endpoint と同一 origin の credential だけを使う

### CI (非対話) 設定

CI では実行前に次の 2 点を設定する。未設定の場合 helper は通信前に失敗する。

1. `git config --local publicar.endpoint <origin>` を明示設定する
2. `PUBLICAR_URL` (保存 endpoint と同一 origin) と `PUBLICAR_API_KEY` を secret で注入する

`PUBLICAR_URL` が保存 endpoint と異なる場合は `env-endpoint-mismatch` で停止する。

## Install

### Claude Code

```bash
claude plugin marketplace add . --scope user
claude plugin install publicar@publicar-local
```

### Codex

```bash
codex plugin marketplace add .
codex plugin add publicar@publicar-local
```

## Development

```bash
npm install
npm test
```

## Versioning

`skills/`、`hooks/`、plugin manifest を変更する場合は `.claude-plugin/plugin.json` と `.codex-plugin/plugin.json` の `version` を semver に従って更新する。
