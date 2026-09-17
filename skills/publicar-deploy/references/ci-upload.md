# GitHub Actionsから既存プロジェクトを更新する

`scripts/upload_publicar.py` は、公開用ZIPを既存のpublicarプロジェクトへ分割送信するPython CLIです。GitHub Actionsからの自動更新に使います。Node helperを使う対話的な公開とコメント修正後の再公開は、従来の手順を使います。

## 前提と承認

- Python 3.12を用意します。Pythonの追加パッケージ、Node、pluginのインストールは不要です。
- 対象プロジェクトはpublicarで作成し、サービスアカウントによる保存の準備と、そのプロジェクト限定のアップロードキー発行を済ませます。CLIは準備やキー発行を行いません。
- 自動送信の送信先、既存URL、対象ファイルの範囲を確認してからworkflowを有効にします。PRの検査や開発への着手を、mainへのマージや実際の記事送信の承認とは扱いません。
- 送信するZIPが公開ファイル一式になります。ZIPに含まれない既存ファイルは公開対象から外れます。原資料、秘密値、ローカルのレビュー記録を含めないよう、ZIPを生成するrepoで検査します。

## 入力と実行結果

| 入力 | 内容 |
|---|---|
| `--archive` | ZIPのパス。省略時は `tmp/publicar/docs.zip` |
| `--result` | 公開結果JSONの保存先。省略時は `tmp/publicar/result.json` |
| `PUBLICAR_ENDPOINT` | HTTPSの接続先。GitHub Variablesから明示する |
| `PUBLICAR_PROJECT_ID` | 更新する既存プロジェクトのID。GitHub Variablesから明示する |
| `PUBLICAR_DEPLOY_KEY` | そのプロジェクトの `upl_` キー。GitHub Secretから注入する |
| `GITHUB_RUN_ID` / `GITHUB_RUN_ATTEMPT` | 要求ID `gh-<run>-<attempt>` を作る。Actionsの既存環境変数を使う |

接続先と認証情報はこの入力だけを使います。git configや `~/.publicar` のprofileを読みません。プロジェクト作成、権限変更、Node helperへの切り替えも行いません。

公開確定の応答を照合した後、結果JSONへ `ok`、`revision_id`、`files`、`entry_path`、`url` を保存し、標準出力へ `published_revision=<revision_id>` を出します。`GITHUB_STEP_SUMMARY` がある場合は、`source_commit` と `revision` も記録します。秘密値と外部エラー本文は出力しません。

一時的な通信失敗は同じ要求IDで最大4回試行し、全体の送信期限は14分です。認証エラー、競合、期限切れなどは再送せず非ゼロで終了します。処理が失敗しても、公開確定後の応答や結果ファイル保存に失敗した可能性があります。新しい要求IDでやり直す前に、所有者画面で現在の公開版を確認してください。

## Actionsからの呼び出し

送信処理のコードや単体試験を記事repoへコピーしません。このrepoのレビュー済みコミットを固定して取得します。次の `ref` は記入例です。CLIを含む、公開済みの40桁SHAに置き換えてから使ってください。

```yaml
- uses: actions/setup-python@v6
  with:
    python-version: '3.12'

- name: Checkout publicar upload client
  uses: actions/checkout@v5
  with:
    repository: u-ichi/publicar-skill
    ref: "<CLIを含む承認済みの40桁SHA>"
    path: .publicar-client
    sparse-checkout: skills/publicar-deploy/scripts/upload_publicar.py
    sparse-checkout-cone-mode: false
    persist-credentials: false

# 公開用ZIPの生成と検査、送信元mainの一致確認を先に行う。
- name: Upload documentation
  if: github.event_name == 'push' && github.ref == 'refs/heads/main'
  env:
    PUBLICAR_ENDPOINT: ${{ vars.PUBLICAR_ENDPOINT }}
    PUBLICAR_PROJECT_ID: ${{ vars.PUBLICAR_PROJECT_ID }}
    PUBLICAR_DEPLOY_KEY: ${{ secrets.PUBLICAR_DEPLOY_KEY }}
  run: |
    python3 -B .publicar-client/skills/publicar-deploy/scripts/upload_publicar.py \
      --archive tmp/publicar/docs.zip \
      --result tmp/publicar/result.json
```

`GITHUB_*` をworkflowで上書きしません。生成器が `.publicar-client` をZIPへ取り込まないことを確認し、その取得先を利用側repoの `.gitignore` に追加します。既存の同時実行制御と、送信直前のmain一致確認は維持します。GitHub Secretの値はコマンドの引数やログへ出しません。

## 試験の分担

- このrepoの単体試験は、HTTPを模擬して送信順序、再送、入力検査、秘密値の非表示を確認します。実行コマンドは README の Development を参照してください。
- サーバーAPIとデータベースの結合試験は u-ichi/publicar にあります。利用側repoへ同じ試験を作りません。
- 利用側の実行環境まで確認する場合は、候補ブランチのGitHub Actionsから、そのrepoの実際の公開用ZIPを確認用プロジェクトへ送ります。手元から小さなZIPを送った結果だけで、Actionsでの自動更新まで確認したとは扱いません。

## マージ前のActions実行から本番更新まで

1. このrepoのCLIを含む候補コミットをレビューし、利用側workflowがその40桁SHAを固定して取得できるようにします。両repoのmainはまだ変更しません。
2. 利用側の同じworkflowに、手動実行は確認用、mainへのpushは本番へ送る別々のstepを設けます。確認用プロジェクトのIDとキーは、本番用と別のVariable・Secretから渡します。確認用の値が空の場合に、本番用の値へ切り替える式を書かないでください。確認用IDが本番IDと同じ場合も送信前に停止します。
3. PRでは検査とZIP生成だけを行います。生成したファイルの一覧と合計サイズを提示し、候補の公開と確認用への実送信を承認された後に進みます。確認用は本番と同じ閲覧制限を保ち、変更前の内容を保存しておきます。
4. 既存のworkflowを、候補ブランチを明示した workflow_dispatch で実行します。実行したコミットと固定CLIがレビュー済みの候補に一致することを確認します。手動実行はmainを選んだ場合も確認用へ送る仕様とし、運用手順に明記します。
5. 同じActions実行が生成したZIPの全ファイルについて、パス、サイズ、SHA-256を送信前に記録します。送信後は公開側のファイル一覧と全件を照合し、公開revision、入口ページの表示、未ログイン時の拒否を確認します。ローカルで生成した別のZIPだけを比較元にしないでください。
6. 確認用step内で同じZIP・要求IDを再送し、同じ公開結果が返ることも確認します。ファイル送信が完了済みならCLIは再送を省きます。確認が失敗した場合は、本番へ進まず現在の公開版を確認して原因を判断します。確認結果を保存した後、確認用projectを元の内容へ戻し、確認用キーとSecret、一時保存した秘密値を片付けます。
7. 合格した候補のコードを変更せず、本番反映の承認を得ます。このrepoをmerge commitで統合すれば、利用側が固定した候補SHAがmainの履歴に残ります。試験後に固定SHAを書き換えて、未確認の別候補にしないでください。候補やmainが途中で変わった場合は差分を確認し、必要な確認をやり直します。
8. 利用側のmainへの統合で起動する本番Actionsを確認します。同じ実行の生成ファイル一覧と公開結果、既存URLでの表示、閲覧制限が一致したところまでを完了条件にします。本番の再実行は、現在の公開版を確認してからmainのpush実行を再実行します。
9. 試験と本番それぞれのActions実行、候補コミット、CLIのSHA、公開revision、照合結果と、確認用の片付け完了を記録します。途中の失敗時もキーの期限切れだけに任せず、処理状況を確認して片付けます。

公開確定後に応答や結果ファイルの保存に失敗する場合もあります。Actionsが失敗しただけで「公開版は変わっていない」と決めず、所有者のログイン済みブラウザで現在の公開版を確認してください。旧内容への再送やrevertも、その操作と影響を承認された範囲で行います。

APIとの互換性は、u-ichi/publicarが公開する /api/v1/openapi.json の仕様を基準に確認します。
