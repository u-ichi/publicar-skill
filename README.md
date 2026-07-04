# publicar-skill

Claude Code / Codex から publicar を操作するための plugin repo。plugin 名は既存インストールとの互換性を保つため `publicar` のまま維持する。

publicar 本体は https://github.com/u-ichi/publicar を参照する。API 互換性の基準は publicar 本体が配信する `/api/v1/openapi.json`。

## Skills

- `publicar-deploy`: HTML / ZIP を publicar にアップロードし、共有 URL を取得する。
- `publicar-comment-loop`: publicar の公開 URL に付いたコメントを読み、返信案、HTML 修正案、承認後の反映と再デプロイを支援する。

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
