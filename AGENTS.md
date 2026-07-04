# publicar-skill 指示

- 日本語で簡潔に報告すること。
- 既存の plugin 名 `publicar` は互換性維持のため変更しない。
- publicar 本体は https://github.com/u-ichi/publicar を参照する。API 互換性の基準は publicar 本体の `/api/v1/openapi.json`。

## Skills

- `publicar-deploy`: HTML / ZIP を publicar にデプロイして共有 URL を取得する。
- `publicar-comment-loop`: 公開 URL のコメント処理、返信案、HTML 修正案、承認後の反映と再デプロイを支援する。

## プラグインバージョン管理

`skills/` 配下、`hooks/` 配下、plugin manifest を変更する commit では、`.claude-plugin/plugin.json` と `.codex-plugin/plugin.json` の `version` を semver に従って更新する。バージョン更新なしの commit は CI で検出される。

| 変更種別 | bump | 例 |
|----------|------|----|
| バグ修正・ドキュメント修正 | patch (1.1.0 -> 1.1.1) | typo 修正、説明文の改善 |
| 新機能・skill 拡張 | minor (1.1.0 -> 1.2.0) | 新しい手順の追加、プロファイル機能拡張 |
| 破壊的変更 | major (1.1.0 -> 2.0.0) | skill の引数変更、既存フローの互換性破壊 |

迷ったら patch 側に倒す。
