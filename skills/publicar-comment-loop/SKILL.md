---
name: publicar-comment-loop
description: |
  publicar の公開 URL からコメント thread を取得し、AI 返信案、HTML 修正案、承認後の返信投稿、ローカル HTML 編集、再デプロイを支援する。Use for dialog mode triggers: このURLのコメント処理して, publicar コメント返信, コメントループ, publicar review comments, publicar comment loop. Use for revise mode triggers: publicar の記事を直して, resolved を反映して, publicar 記事修正, apply resolved comments, publicar revise. Do not use for publicar server-side development, simple deploy-only requests handled by publicar-deploy, or RHW ローカル preview のコメント取り込み.
argument-hint: "[URL] [--mode dialog|revise] [--dir <path>] [--profile NAME] [--path <html-path>] [--dry-run]"
---

# publicar コメントループ

publicar に公開済みの HTML へ付いたコメントを取得し、ユーザー承認を挟んで返信、ローカル HTML 編集、再デプロイまで進める。publicar 単独で成立させ、外部 plugin や preview CLI は呼び出さない。

## モード判定

1. `--mode dialog|revise` が明示されていればそれを使う。
2. 発話に `publicar の記事を直して`、`resolved を反映して`、`publicar 記事修正`、`apply resolved comments`、`publicar revise` が含まれれば `revise`。
3. それ以外は `dialog`。

- `dialog`: `status=open` の thread を 1 件ずつ扱い、返信投稿と HTML 部分編集を行う。resolved 化はしない。
- `revise`: `status=resolved` の thread を path ごとにまとめ、合意内容を HTML に統合する。返信投稿も status 更新もしない。

## 実行手順

### (a) URL を解析する

URL から `origin`、`alias`、`path` を抽出する。URL がなければ 1 度だけ質問する。

- query と hash は除去する。
- `{origin}/{alias}[/{subpath}]` と `{origin}/p/{alias}[/{subpath}]` の 2 系統を扱う。
- path 先頭が `/p/` なら先に剥がし、`/p/foo/index.html` を `alias=p, path=foo/index.html` と誤解釈しない。
- trailing slash は publicar 側の entry path 扱いにする。
- 残り path は publicar の `normalizeFilePath` 相当に、先頭 slash 除去、空 path の entry path 化、`.` / `..` 無効化を行う。

### (b) profile と origin を照合する

profile 解決は `publicar-deploy` と同じ順序で行う。

1. `--profile NAME`
2. `PUBLICAR_URL` + `PUBLICAR_API_KEY`
3. `~/.publicar/profiles.json` の `current`
4. 未設定なら CLI 認証フロー

profile 決定後、貼り付け URL の origin と profile の `url` origin を必ず照合する。不一致なら profile 切替を確認するか停止し、別 origin の alias と混同しない。

HTTP client は User-Agent を必ず browser 相当にする。Python-urllib の default User-Agent は Cloudflare WAF error 1010 で 403 になることがある。

```bash
curl -sS -A "Mozilla/5.0 publicar-comment-loop" "$PUBLICAR_URL/api/v1/projects" \
  -H "Authorization: Bearer $PUBLICAR_API_KEY"
```

```python
request.add_header("User-Agent", "Mozilla/5.0 publicar-comment-loop")
```

### (c) project id を解決する

`GET {origin}/api/v1/projects` を Bearer API key 付きで呼び、alias で project id を解決する。

ヒット 0 件は次の 3 分岐で説明する。

- alias 不存在: typo、削除済み、または別 origin の URL。
- alias は存在しうるが profile user が member ではない: public link は開けても comment API は 404 になりうるため、project member 追加を依頼する。
- origin 不一致: (b) の照合結果を示し、profile 切替を促す。

### (d) localDir と sourceKind を解決する

`~/.publicar/projects.json` の `<profile>/<projectId>` から `localDir` と `sourceKind` を読む。なければ次の順で決める。

1. `--dir <path>`
2. CWD から `renderer-manifest.json` を探索
3. ユーザーに HTML の置き場所を 1 度だけ質問

同時に `sourceKind` を分類して保存する。

- `directory`: `renderer-manifest.json` があるディレクトリ
- `single-html`: 単一 `.html` ファイル
- `zip`: `.zip` ファイル

保存形式:

```json
{
  "profiles": {
    "<profile>": {
      "projects": {
        "<projectId>": {
          "localDir": "<path>",
          "alias": "<alias>",
          "url": "<public URL>",
          "sourceKind": "directory",
          "lastSyncedAt": "<ISO timestamp>"
        }
      }
    }
  }
}
```

### (e) thread を取得する

`GET {origin}/api/v1/projects/{projectId}/comment-threads?status=<status>&limit=50` を呼び、`nextCursor` が尽きるまで取得する。`thread.path` でグルーピングする。

- `dialog`: `status=open`
- `revise`: `status=resolved`

### (f) mode 別に提示して承認を取る

`dialog` は thread 単位で提示する。

```text
[Thread <id>] status=open  path=<path>
selectedText: "..."
コメント本文: <body>
返信履歴:
- <author>: <body>
== AI 要旨 ==
== 提案返信 ==
== 提案編集 diff (block 単位) ==
```

承認プロンプト: `[y] 全承認 / [e] 編集 / [r] 返信のみ / [s] skip / [x] 中断`

`revise` は path 単位で一括提示する。

```text
[Path <path>] resolved threads: N 件
--- Thread <id-1> (resolved) ---
  selectedText: "..."
  合意要約: <元コメント + 返信履歴からの合意点>
--- Thread <id-2> (resolved) ---
  ...
== 統合修正 diff ==
<path 全体を対象にした 1 本の diff>
```

承認プロンプト: `[y] path ごと承認 / [e] 編集 / [s] skip / [x] 中断`

### (g) anchor を正規化して解決する

ローカル HTML は tag 除去、entity decode、whitespace collapse で DOM `textContent` 相当に正規化してから検索する。生 HTML 文字列検索だけに頼らない。

検索順序:

1. `blockText`
2. `prefix + selectedText + suffix`
3. `selectedText` 単独

複数候補は `blockTagName`、prefix、suffix、見出し/本文系 tag、nav/header/footer などの位置で scoring する。曖昧なら `[m] 手動指定 / [r] 再提案 / [s] skip` を出す。0 件でも同じ分岐にする。

擬似コード:

```text
normalized = stripTags(html)
normalized = decodeEntities(normalized)
normalized = collapseWhitespace(normalized)
for pattern in [blockText, prefix + selectedText + suffix, selectedText]:
  collect matches
  score by prefix/suffix exactness, blockTagName, and location penalty
  return best unambiguous match
```

### (h) 承認後アクションを実行する

`dialog`:

1. 承認された thread のローカル HTML を編集する。
2. `POST {origin}/api/v1/projects/{projectId}/comments/{threadId}/replies` で返信する。
3. POST body には `actorKind: "ai"` を含める。AI 経由の識別は UI バッジで行う。

```json
{
  "body": "<提案返信>",
  "actorKind": "ai"
}
```

status は変更しない。thread は open のまま残し、ユーザーが publicar UI で最終クローズする。最後の deploy が失敗した場合は「返信は済んだが HTML は旧世代」と明示して復旧手順へ誘導する。

`revise`:

1. 承認された path のローカル HTML を編集する。
2. 対応した resolved thread にフォローアップ返信を投稿する。本文は「HTML への反映内容」の要旨にし、POST body は `body` と `actorKind: "ai"` を含める。
3. thread status は変更しない。
4. 全 path 処理後に再デプロイへ進む。

### (i) sourceKind 別に再デプロイする

- `directory`: Skill ツールで `publicar-deploy` を呼び、`<localDir> --project-id <id> --profile <profile>` を渡す。`renderer-manifest.json` 付き directory 判定は `publicar-deploy` に任せる。
- `single-html`: Skill ツールに `<localDir>/<path> --project-id <id> --profile <profile>` を渡す。Skill 呼び出しが使えない場合だけ、次の直接 API 呼び出しを fallback とする。直接 deploy は必ず `Content-Type: text/html`、`--data-binary @file`、`?path=index.html` で送る。multipart (`-F`) で送ると server に `multipart/form-data` として保存され、ブラウザがダウンロードダイアログを開く。
- `zip`: unsupported として停止し、単一 HTML か directory バンドルで再デプロイするよう案内する。

single HTML fallback:

```bash
curl -s -X POST "$PUBLICAR_URL/api/v1/projects/$PROJECT_ID/deploy?path=$PUBLICAR_PATH" \
  -H "Authorization: Bearer $PUBLICAR_API_KEY" \
  -H "Content-Type: text/html" \
  --data-binary @"$HTML_FILE"
```

### (j) 失敗系を明示する

- API key 未設定: CLI 認証フローへ誘導する。
- 403 / 404 on comment-threads: 別 profile、member 追加、origin 不一致を切り分ける。
- 403 on replies: profile user の権限不足または API key 不備として停止する。
- anchor 不一致: thread 単位で警告し、`[m] 手動指定 / [r] 再提案 / [s] skip` を出す。
- deploy 失敗: 「返信は済んだが HTML は旧世代のまま」と明示し、手動復旧手順を案内する。

## DO NOT

- publicar 本体の `src/`、`migrations/`、schema を変更しない。
- resolved 化を自動で行わない。
- `sourceKind` の値は `directory`、`single-html`、`zip` のみにする。
- 外部 plugin や preview CLI を呼ばない。
- RHW ローカル preview のコメント取り込みには使わない。
