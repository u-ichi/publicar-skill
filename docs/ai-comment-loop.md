# AI コメントループ

publicar-comment-loop は、公開 URL に付いたコメントをエージェントが読み取り、ユーザー承認を挟んで返信、HTML 修正、再デプロイを支援する skill です。publicar の既存 API だけを使い、外部 plugin には依存しません。

## 2 つのモード

### dialog mode

open thread を対象に、1 件ずつ返信案と HTML 修正案を出します。承認後は `actorKind: "ai"` 付きで publicar API へ返信投稿し、ローカル HTML を編集します。AI 経由の返信は review UI のバッジで識別します。thread は open のまま残します。

起動例:

```text
このURLのコメント処理して https://publicar.example.com/p/report/index.html
```

提示例:

```text
[Thread th_123] status=open  path=index.html
selectedText: "売上は前年比10%増"
コメント本文: 期間が通期なのか四半期なのか明記してください
返信履歴:
- reviewer@example.com: 表の注記も見直してください
== AI 要旨 ==
期間の定義が曖昧。本文と表注記に対象期間を追記する。
== 提案返信 ==
対象期間を本文と表注記に追記しました。確認をお願いします。
== 提案編集 diff (block 単位) ==
- 売上は前年比10%増
+ 2025年度通期の売上は前年比10%増
```

承認プロンプト:

```text
[y] 全承認 / [e] 編集 / [r] 返信のみ / [s] skip / [x] 中断
```

### revise mode

resolved thread を path ごとにまとめ、合意内容を HTML に一括反映します。反映後は対応 thread に `actorKind: "ai"` 付きのフォローアップ返信を投稿し、HTML への反映内容を要約します。thread の status は変えません。

起動例:

```text
publicar の記事を直して https://publicar.example.com/report/
```

提示例:

```text
[Path index.html] resolved threads: 2 件
--- Thread th_201 (resolved) ---
  selectedText: "導入効果"
  合意要約: 見出しを「初期導入効果」に変更する。
--- Thread th_202 (resolved) ---
  selectedText: "月次"
  合意要約: 集計単位が月次であることを脚注に追加する。
== 統合修正 diff ==
- <h2>導入効果</h2>
+ <h2>初期導入効果</h2>
...
```

承認プロンプト:

```text
[y] path ごと承認 / [e] 編集 / [s] skip / [x] 中断
```

## 認証セットアップ

publicar-deploy と同じ profile を使います。解決順序は次の通りです。

1. `--profile NAME`
2. `PUBLICAR_URL` と `PUBLICAR_API_KEY`
3. `~/.publicar/profiles.json` の `current`
4. 未設定なら CLI 認証フロー

貼り付け URL の origin と profile の `url` origin が一致しない場合は停止します。別環境の alias と混ざると、project id 解決や comment API の権限判定が誤ります。

HTTP client は User-Agent を browser 相当にしてください。Python-urllib の default User-Agent は Cloudflare WAF error 1010 で 403 になることがあります。

## ローカル HTML の保存先

初回は `--dir`、CWD の `renderer-manifest.json` 探索、ユーザーへの質問の順で HTML の置き場所を決めます。決定した情報は `~/.publicar/projects.json` の `<profile>/<projectId>` に保存します。

保存する値:

- `localDir`
- `alias`
- `url`
- `sourceKind`: `directory` / `single-html` / `zip`
- `lastSyncedAt`

2 回目以降はこの情報を使い、同じ project では質問なしでローカル HTML を解決します。

## diff と anchor

コメント anchor は publicar UI が DOM `textContent` から保存した `selectedText`、`prefix`、`suffix`、`blockText` を使います。skill はローカル HTML を tag 除去、entity decode、whitespace collapse で正規化し、次の順に検索します。

1. `blockText`
2. `prefix + selectedText + suffix`
3. `selectedText`

候補が複数ある場合は tag 種別、prefix/suffix の一致、nav/header/footer などの位置を scoring し、曖昧なら手動指定、再提案、skip を選べるようにします。

## 再デプロイ

- `directory`: `renderer-manifest.json` 付き directory として publicar-deploy に渡します。
- `single-html`: HTML ファイルパスを publicar-deploy に渡します。Skill 呼び出しが使えない場合だけ direct deploy API を fallback にします。直接 API を叩く場合は `Content-Type: text/html`、`--data-binary @file`、`?path=index.html` を使ってください。multipart (`-F`) で送ると server に `multipart/form-data` として保存され、ブラウザがダウンロードダイアログを開きます。
- `zip`: comment-loop では unsupported です。元 ZIP の安全な再構築元を持たないため、単一 HTML か directory バンドルで再デプロイしてください。

## 失敗系トラブルシュート

### API key がない

publicar-deploy と同じ CLI 認証フローで API key を取得し、`~/.publicar/profiles.json` に保存します。

### comment-threads が 403 / 404

profile が別 origin を指している、project member ではない、または alias が違う可能性があります。URL の origin、`--profile`、project への invite 状態を確認してください。

### replies が 403

profile user に view 権限がないか、API key が無効です。別 profile で再実行するか、project member 追加を依頼してください。

### anchor が見つからない

公開後にローカル HTML が変わっている可能性があります。手動指定で該当箇所を選ぶか、thread を skip し、最新 HTML を取得してから再実行してください。

### deploy が失敗した

dialog mode では、返信投稿とローカル HTML 編集が済んだ後に deploy が失敗すると「返信は済んだが HTML は旧世代」の部分状態になります。手動で publicar-deploy を実行し直すか、HTML を元に戻して同じ thread を再処理してください。

## FAQ

### dialog mode で resolved にならない理由

AI は返信と HTML 修正案を支援しますが、最終判断はレビュアー側の確認に残します。thread は open のままにし、publicar UI でユーザーが resolve します。

### revise mode の呼び時

レビュアーとやり取りが終わり、publicar UI 上で thread を resolved にした後に使います。resolved thread の合意内容を HTML にまとめて反映したい時のモードです。

### AI 返信の識別

AI 経由のコメントと返信は API の `actorKind: "ai"` で保存され、review UI では投稿者名の直後に `🤖 AI` バッジとして表示されます。author は実行した Google OAuth user のままです。

### revise mode のフォローアップ返信

revise mode は resolved thread に対しても、HTML へ反映した内容の要旨をフォローアップ返信として投稿します。この返信も `actorKind: "ai"` 付きなので、後から UI 上で AI 経由の反映履歴として確認できます。

### RHW 非依存で成立する仕組み

publicar-comment-loop は publicar の公開 URL、comment API、reply API、deploy API、ローカル HTML だけを使います。レビュー用のローカル preview server や別 plugin のコメント保存形式には依存しません。

### dialog → resolve → revise の重複反映防止

dialog mode で反映済みの返信は `actorKind: "ai"` と UI バッジで識別できます。revise mode では diff を path 単位で提示し、既に HTML に入っている変更は差分に含めないよう確認します。重複が見えた場合は `[e]` で diff を編集してから承認してください。
