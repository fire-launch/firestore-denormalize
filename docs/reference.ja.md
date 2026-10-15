# リファレンス

[README](../README.ja.md) · [設定](#設定) · [ハンドラ](#ハンドラ) · [CLI](#cli) · [変更はこう処理される](#変更はこう処理される) · [ログ](#ログ) · [コストの見積もり](#コストの見積もり) · [既知の制約](#既知の制約) · [初回デプロイ](#新しいプロジェクトへの初回デプロイ) · [後片付け](#後片付け) · [セキュリティ](#セキュリティ) · [推奨する関数の設定](#推奨する関数の設定)

## 設定

設定ファイル（例: `functions/src/doc-sync.config.ts`。名前は自由で、`--config` で渡します）は `defineConfig({ ... })` をエクスポートします。TypeScript でも JavaScript でも、ESM でも CJS でも構いません。完全な例: [examples/functions/src/doc-sync.config.ts](../examples/functions/src/doc-sync.config.ts)。

| キー | 意味 |
|---|---|
| `name` | インスタンス名（`[a-z][a-z0-9-]*`）。プロジェクトとリージョンの中で一意にする |
| `region` | Eventarc のロケーション = Firestore データベースのロケーション（`asia-northeast1`、`nam5` など） |
| `database` | Firestore のデータベース ID。既定 `(default)` |
| `service` | 関数の Cloud Run サービス名（`onRequest` の場合は関数名を小文字化したもの） |
| `serviceRegion` | Cloud Run のリージョン。既定は `region`。`region` がマルチリージョン（`nam5`、`eur3` など）のときは必須 |
| `serviceAccount` | トリガー用サービスアカウント。ID だけ書くと `<id>@<project>.iam.gserviceaccount.com` に補完される |
| `rules[]` | ルール。順序は自由: `defineConnection(...)`、`defineAggregate(...)`、`defineView(...)`、`defineProjection(...)`（または `kind` を持つオブジェクト） |

### リソース名

| リソース | 名前 |
|---|---|
| Eventarc トリガー | `<instance>-<collection>-<hash>` |
| Cloud Scheduler ジョブ | `<instance>-<rule>-<hash>` |
| Cloud Tasks キュー | `<instance>-schedule` |

`<hash>` はインスタンスとコレクション（またはルール）から作る 8 文字です。インスタンス間で名前が衝突せず、63 文字の制限にも収まります。長い名前はハッシュの前で切り詰めます。`deploy` は名前ではなく所有者の印で自分のリソースを見つけるので、この名前を手で扱うことはありません。

```ts
export default defineConfig({
  name: 'doc-sync', region: 'asia-northeast1', service: 'docsync', serviceAccount: 'doc-sync-trigger',
  rules: [defineConnection({ ... }), defineAggregate({ ... }), defineView({ ... })],
})
```

ルールは別のファイルに置いて `rules` にスプレッドできます（`rules: [...postRules, ...userRules]`）。

コレクションはパスで書き、親 ID はプレースホルダにします: `users/{uid}/posts`。フィールドはドット区切りでも書けます: `address.city`。

### defineConnection: `source/{id}` の `fields` を、`target.idField == id` となる `target.targetField` にコピーする

| キー | 意味 |
|---|---|
| `source`、`target` | コレクション。`source` のプレースホルダはすべて `target` にも現れる必要があります。`target` 側に余分なプレースホルダがあるとコレクショングループクエリになります |
| `idField` | ターゲット上の、ソース ID を保持する string フィールド |
| `fields` | コピーするソースのフィールド（存在しないものは省かれます） |
| `targetField` | `{ ...fields }` を受け取るターゲットのフィールド |
| `onSourceDelete` | ソースが存在しないときの動作: `'setNull'`、`'deleteField'`、`'nothing'` |

### defineAggregate: ターゲットに属するソースの `count()` または `sum(field)` を `target.targetField` に保つ

| キー | 意味 |
|---|---|
| `source`、`target` | コレクション |
| `idField` または `idParam` | ソースが自分のターゲットをどう示すか: ソース上の string フィールド、または `source` のプレースホルダ（`post/{postId}/like` + `idParam: 'postId'`） |
| `aggregate` | `'count'` または `{ sum: '<numeric field>' }` |
| `targetField` | 数値のターゲットフィールド |

### ルールが動く 3 つの方式

| 方式 | きっかけ | 遅延 | 向いている場面 |
|---|---|---|---|
| 即時（既定） | マッチする Firestore イベントのたびに | なし | 大半のルール |
| `defer` | Cloud Tasks のタスクが 1 区切りに 1 回 | 最大 1 区切り | ホットなドキュメント、書き込みのバースト |
| `schedule` | Cloud Scheduler の cron | 最大 1 cron 間隔 | 大きなファンアウト、夜間の集計、遅れてよい読み取りモデル |

### `schedule`: イベントではなく定期的に同期する

どのルールにも `schedule: '<unix-cron>'`（5 フィールド）と任意の `timeZone`（IANA 名、既定 `Etc/UTC`）を付けられます。付けたルールは Firestore のイベントでは処理されません。代わりに `deploy` が Cloud Scheduler のジョブ `<instance>-<rule>-<hash>` を作り、トリガー用サービスアカウントの OIDC トークンで `POST <サービス URL>/schedule/<rule>` を呼び、ハンドラがそのルールだけ `rebuild` を実行します。スケジュールルールだけが使うコレクションには Eventarc トリガーを作りません。

| キー | 意味 |
|---|---|
| `schedule` | Cloud Scheduler の unix-cron。例 `'0 3 * * *'`。ルールの `name` は `[A-Za-z0-9_-]` に限る（ジョブ名と URL になるため） |
| `timeZone` | cron のタイムゾーン（IANA 名）。既定 `Etc/UTC` |

- 整合性は「cron 間隔 + 1 回の実行時間」を上限とする最終的整合になります。書き込みは引き続き `update(..., { lastUpdateTime })` なので、定期実行がイベント駆動の並行書き込みを古い値で上書きすることはありません。
- 1 回の実行には時間予算があります（`createDocSyncHandler` の `schedule.budgetMs`、既定 20 分。Cloud Scheduler の応答待ちは最長 30 分）。予算を超えるとページ境界で止まり、**継続**を積みます。キュー `<instance>-schedule`（`serviceRegion`）の Cloud Tasks タスクが同じ `/schedule/<rule>` を本文 `{ startAfter, runId, chunk, startedAt }` 付きで呼び、止まった場所から続けます。タスク ID は `<rule>-<runId>-<chunk>` で、重複（再試行されたチャンク）は無視されます。タスクを積めなかった場合は `continued: false` を返し、次の定期実行は先頭からやり直します。
- 継続に必要なもの: キュー（`setup` が作成）と、関数の実行サービスアカウントに対する `roles/cloudtasks.enqueuer`（キュー）および トリガー用サービスアカウントに対する `roles/iam.serviceAccountUser`（`setup --runtime-service-account <email>` が両方を付与）。プロジェクトは `GOOGLE_CLOUD_PROJECT` / `GCLOUD_PROJECT` / Firestore クライアントから、サービス URL はリクエストの `host` ヘッダーから求めます。`schedule.project` / `schedule.serviceUrl` で上書きできます。`schedule.continue: false` で継続を無効化、`schedule.enqueue` で Cloud Tasks 呼び出しを置き換えられます（テスト、エミュレータ、他基盤）。
- キューは失敗した継続を最大 5 回、60 秒以上の間隔で再試行します。スケジュールを外したルールへの継続は 404 になり、その回数で止まります。
- 一周が cron 間隔より長いと次の一周と重なります。定常状態では（一周の所要時間 ÷ cron 間隔）本の連鎖が同時に走り、読み取りが倍増して `maxInstances` を奪い合います。cron 間隔は一周より長くしてください（実行ログの `durationMs` と `chunk` で測れます）。関数が 429/503 を返すと Cloud Tasks はチャンクを最大 5 回（60 秒以上の間隔）再試行してから捨て、連鎖は静かに終わります。Cloud Tasks のログにしか残らず、次の cron で先頭からやり直します。
- エミュレータ: `FIRESTORE_EMULATOR_HOST` を設定すると、タスクは Cloud Tasks を使わずタイマーで関数プロセス内で実行されます（`schedule.local`）。
- 実際のデプロイに対して手動で実行するには `doc-sync run <rule>` を使います。トリガー用サービスアカウントになりすまして得た ID トークンで `POST /schedule/<rule>` を 1 回呼びます。呼び出す側にそのサービスアカウントへの `roles/iam.serviceAccountTokenCreator` が必要です。エミュレータに対しては `doc-sync rebuild --rule <name>`、または関数への `POST /schedule/<name>`（CloudEvent ヘッダーは不要）を直接使ってください。
- スケジュールかイベントかの二択です。スケジュールルールはターゲットの作成イベントも無視するので、フィールドはターゲットができた後の最初の実行で付きます。
- 関数の `timeoutSeconds` は予算より長くしてください。イベントのみなら 300、スケジュールルールがあれば `schedule.budgetMs`（既定 20 分 → 1800）以上にします（[推奨する関数の設定](#推奨する関数の設定) を参照）。短いと長い実行が途中で切られ、`completed: false` を返す前に終わります。
- ジョブは失敗（HTTP 500）した実行を最大 3 回、60 秒以上の間隔で再試行します。実行は冪等なので再試行は安全です。

### `defer`: イベントでは印をつけるだけにし、1 区切りに 1 回だけ再計算する

どのルールにも、`schedule` の代わりに `defer: '<duration>'`（`'90s'`、`'10m'`、`'1h'`、`'1h30m'`。10 秒以上 24 時間以下）を付けられます。イベントは再計算せず、何が変わったかに印をつけるだけにし、Cloud Tasks のタスクが 1 区切りに 1 回まとめて再計算します。

| キー | 意味 |
|---|---|
| `defer` | 印をつけた単位を再計算する間隔。例 `'10m'`。`schedule` とは併用不可 |

| 汚れた単位 | 印がつく条件 | 再計算される対象 |
|---|---|---|
| `source` | connection のソース、または view の `refField` ソースが変わったとき（ファンアウト全体を 1 タスクでまとめる） | そのソースを参照する全ターゲット、読み直して |
| `target` | aggregate のソース、view の `idField` / `idParam` ソース、または既存のターゲット・base が変わったとき | そのターゲット 1 件、読み直して |
| （即時。defer されない） | base の作成・削除、ターゲットの最初の値、base 付き view のターゲットの手動削除 | `defer` の無いルールと同じく、すぐに |

- バケットの境界をまたぐ変更は、バケットごとに 1 回、計 2 回フラッシュされます。
- skip 判定（フィールド未変更、`watch` 未変更など）が先に効くので、関係ない書き込みには何も印をつけません。
- タスクを積めなかった場合、イベントは 500 を返し Eventarc が再送します。
- 失敗が続くフラッシュはキューが最大 5 回まで再試行し、それでも失敗すれば捨てられます。そのようなターゲットは `verify --fix` で直せます。
- 上の schedule の継続と同じ Cloud Tasks キューと権限が必要です。`setup` は、いずれかのルールが `schedule` または `defer` を持つときにキューを作成します。
- 独自の `schedule.enqueue` は、タスクの `scheduleTime` を守り、`id` の重複を成功として扱う必要があります。
- フラッシュ: `POST /schedule/<rule>` に本文 `{ "flush": { "unit": "source" | "target", "path": "..." } }` を送ると、その単位だけを再計算し、処理済みイベントと同じ JSON に `flush` と `durationMs` を加えて返します。`defer` の無いルールへの `flush` は 404、`flush` の無い本文で `defer` ルールを呼んだ場合は 400 です。
- エミュレータ: `FIRESTORE_EMULATOR_HOST` を設定すると、タスクは Cloud Tasks を使わずタイマーで関数プロセス内で実行されます（`schedule.local`）。

### `defineView`: `target` の宣言した `targetFields` = `build(...)` の該当パス、を保つ

一般形です。`defineConnection`・`defineAggregate`・`defineProjection` は、形の決まった view の簡易設定です。

| キー | 意味 |
|---|---|
| `target` | 派生フィールドを持つコレクション |
| `targetFields` | この view が書くフィールドパス。例 `['title', 'stats.commentCount', 'profile']`。`build` の戻り値からはこのパスだけを取り出し、値が `undefined` のパスは削除します。`'rest'`（`base` が必要）は、どのルールも宣言していないルート直下のキー全部を加えます |
| `base?` | 同じ ID のドキュメントがターゲットの存在を決めるコレクション（後述）。`target` と同じプレースホルダを持つこと |
| `sources` | `build` が見る名前をキーにしたオブジェクト。各要素は下表のソース。`base` があれば省略可 |
| `build({ target, base, sources, firestore })` | 宣言したパスを持つオブジェクトをネストした形で返す（`{ stats: { commentCount: 3 } }`）。`undefined` を返すと全宣言パスを削除。決定的であること。`sources.<key>` は `QueryDocumentSnapshot[]`、`base` は base ドキュメント（`build` が呼ばれる時点で必ず存在） |
| `patch?(current, change, { target, base, firestore })` | 現在の値（`build` の戻り値と同じ形、`rest` のキーも含む）と変更された 1 件のソースドキュメント（1 回だけの読み直し）から、全ソースを読み直す代わりに求める任意の高速路。`undefined` を返すと `build` に戻る。イベントは複数回・順序が入れ替わって届くことがあるため、`patch` は冪等でなければならず、要素がどう見えるかの判断には `change.after` だけを使い、ドキュメント ID で管理すること |

| ソースのキー | ターゲットとの関係 | 追加指定 |
|---|---|---|
| `idField: 'postId'` | 多対一: ソースのフィールドがターゲット ID を持つ | `orderBy`、`limit`、`watch` |
| `idParam: 'postId'` | 多対一: ターゲットのパス配下のソース | `orderBy`、`limit`、`watch` |
| `refField: 'authorId'` | 一対一: ターゲットのフィールドがソース ID を持つ（0 または 1 件） | `watch` |

- `orderBy`: `['createdAt', ['score', 'desc']]`。`limit`: 読む最大件数。`watch`: 再計算のきっかけになるソースのフィールド（既定は何でも）。`idField` と `orderBy` のフィールドは常に監視されます。`base` ドキュメントの変更は常に再計算のきっかけになります。
- 書き込み: 値が違う宣言パスだけを 1 回の `update()` にまとめ、ターゲットの `updateTime` を条件にします。`targetFields` 外のフィールドには触れません。戻り値にある宣言外のパスは 1 回だけ `warn` ログを出して無視します。宣言パスと同じドット区切りの literal キー（`{ 'stats.count': 3 }`）もそのパスの値として受け付けます。
- `base`: `target/{id}` は `base/{id}` が存在するときだけ存在します。base・ソースのイベント、およびターゲットの作成・削除イベントで読み直して判定します（ターゲットの単なる更新では base を見直しません）。ターゲットが無ければ `create()` で作り、base が消えていれば `delete({ lastUpdateTime })` で消します。消したターゲット配下のサブコレクションは残ります（Firestore の仕様）。同じターゲットに対して複数の view が同じ `base` を宣言でき、`validate` は一致を確認します。そのターゲットの他のルールは、ターゲットが無い間は skip し、作成イベントで追いつきます。
- `base` 付きターゲットでは、他ルールが id に使うフィールド（`idField` / `refField`）はどのルールも書けず `'rest'` の対象にもなりません。ターゲットが削除・再作成されると失われるので、そのような id は base 側に置き、`targetFields` で写してください。
- `'rest'`: どのルールも書かず id にも使っていないルート直下のキー全部をこの view が所有します。戻り値にあるそのようなキーは書き、ターゲットにあって戻り値に無いものは削除します。`base` 付きの view でのみ使えます。
- `build` / `patch` の戻り値: `undefined` のマップ要素は落とし、配列の `undefined` 要素は `null` になります。
- `change.after` は変更ドキュメントの読み直しです（削除済み、またはこのターゲットに属さなくなった場合は `undefined`）。`patch` は冪等で、要素をドキュメント ID で管理すること。
- ターゲット側: 作成時、`refField` の変更時、宣言パスが消えた時、そして `base` 付きなら削除時（base があれば作り直す）に再計算します。`build` が読む他のターゲットフィールドは監視しません。
- `rebuild` / `verify` は常に `build` を使います。`base` 付き view では先に base コレクションを歩いて（ターゲットの作成・検査）、次にターゲットコレクションを歩きます（base を失ったターゲットの削除・報告）。`verify` は各件を `issue: 'value' | 'missing' | 'orphan'` で報告します。
- ルールは設定の順序どおり connection → aggregate → view の順に実行されるため、トリガーのない新しいデータベースでは、base 付き view のターゲットはその view の順番が来るまで作成されません。それより前にある aggregate や connection のルールは、まだ存在しないターゲットに対しては何もしません。`rebuild` をもう一度実行するか、`--rule` で base 付き view を先に rebuild してください。
- 型付き設定では「`'rest'` には `base` が必要」「view には `base` か最低 1 つのソースが必要」を表現できません。どちらも `validate` が実行時に検出します。

### `defineProjection`: `build` の無い `base` 付き view

| キー | 意味 |
|---|---|
| `base` | 写す元のコレクション |
| `target` | `base/{id}` ごとに `target/{id}` を持つコレクション。`base` と同じプレースホルダ |
| `targetFields` | base からそのまま写すパス。`'rest'` は使えません |

寿命は `base` 付き view と同じです。base があればターゲットを作り、無くなれば消し、base に無いパスはターゲットからも削除します。派生フィールドは `target` に対する aggregate や view で足します。ログでは `kind: 'projection'` になります。

### バリデーション

`validateConfig`（全 CLI コマンドが実行します）は、ルール名の重複、同じコレクションへの重なる書き込み、解決できないプレースホルダ、同じドキュメントにマッチするパターン、ルールのループを拒否します。

### 型付きの設定

```ts
type Collections = { post: Post; category: Category; 'post/{postId}/comment': Comment }  // インターフェースではなく型エイリアス
const { defineConfig, defineConnection, defineAggregate, defineView } = typed<Collections>()
```

コレクション名、フィールドパス、`idParam`、`build` の戻り値の型が、ドキュメントの型に対してコンパイル時に検査されます。どちらの関数も実行時には何もしません。

## ハンドラ

```ts
createDocSyncHandler(config, { firestore, logger, maxRetries, pageSize, schedule })
```

| オプション | 既定 | 意味 |
|---|---|---|
| `firestore` | `getFirestore()` | Firestore インスタンス |
| `logger` | 標準出力への JSON | `info` / `warn` / `error` を持つ任意のオブジェクト。`console` も使えます |
| `maxRetries` | 5 | 条件付き書き込みが失敗したターゲットのやり直し回数 |
| `pageSize` | 500 | ターゲット検索のページサイズ |
| `schedule: { budgetMs, concurrency, project, serviceUrl, enqueue, continue, local }` | `budgetMs` は 20 分、`concurrency` は 20、`continue` は `true`、`local` は `FIRESTORE_EMULATOR_HOST` が設定され `enqueue` が無いとき既定で有効 | `/schedule/<rule>` 実行のオプション。`budgetMs` は時間予算、`concurrency` は 1 ページ内で並列に処理するターゲット数。予算で止まった実行は `continue: false` でない限り Cloud Tasks の継続を積みます。`project` / `serviceUrl` はキューの GCP プロジェクトとこのサービスの公開 URL を上書きします（既定: `GOOGLE_CLOUD_PROJECT` / `GCLOUD_PROJECT` / Firestore クライアントのプロジェクト、リクエストの `host` ヘッダー）。`enqueue` は Cloud Tasks の呼び出しを置き換えます（テスト、エミュレータ、他基盤）。defer のルールでは、タスクの `scheduleTime` を守る必要があります。`local: boolean | { maxWaitMs }` は継続とフラッシュのタスクを Cloud Tasks の代わりにタイマーでプロセス内で実行します |

同じイベントの中では、ソースドキュメントは 1 回だけ読みます。組み合わせるターゲットより古い読み取りは使い回しません。

ハンドラは `(req, res) => Promise<void>` で、Express や Node の `http` でも使えます。

`POST /schedule/<rule>` はそのスケジュールルールを実行し、JSON `{ rule, runId, chunk, scanned, written, completed, continued, lastPath, reads, queries, aggregations, durationMs }` を返します（200）。未知またはイベント駆動のルールは 404、POST 以外は 405、失敗は 500（`{ error, runId, chunk }`。先頭チャンクは Cloud Scheduler が、継続チャンクは Cloud Tasks が再試行）。本文には予算で止まったパスを再開するための継続 `{ startAfter, runId, chunk, startedAt }` を渡せます。`runId` は 1 回のパスを識別し、`chunk` は Scheduler 自身の呼び出しが `0`、以降 `1`、`2`、... と増え、`continued` はこの実行が次のチャンクを積んだかどうかを示します。`req.url` を渡してください（Express は渡します）。

## CLI

| コマンド | 内容 |
|---|---|
| `validate [--strict]` | 設定を検査します。トリガー、コストの見積もり、書き込みの連鎖、警告、（スケジュールまたは defer のルールがあれば）`continuation queue: <instance>-schedule (<serviceRegion>)` を表示します。`--strict` を付けると警告があれば失敗します |
| `setup [--runtime-service-account <email>]` | トリガー用サービスアカウントを作成し、`roles/eventarc.eventReceiver`（プロジェクト）と `roles/run.invoker`（サービス）を付与し、API を有効化します。スケジュールルールがあれば Cloud Scheduler API を、スケジュールまたは defer のルールがあれば Cloud Tasks API も有効化し、継続用キューを作成し、再試行設定がずれていれば更新します（`--max-attempts=5 --min-backoff=60s`）。`--runtime-service-account <email>` を付けると、そのサービスアカウントにキューへの `roles/cloudtasks.enqueuer` とトリガー用サービスアカウントへの `roles/iam.serviceAccountUser`（継続とフラッシュを積むのに必要）も付与します。付けない場合は、手動で実行する 2 つの `gcloud` コマンドを表示します。冪等です。サービスがまだ存在しない間は invoker の付与をスキップするので、最初のデプロイ後に再実行してください |
| `deploy [--deploy-function <name>]` | 不足している Eventarc トリガー（イベント駆動ルールのコレクション分）を作成し、ずれたもの（サービス、サービスのリージョン、パスパターン、SA）を更新し、不要なものを削除します。対象は `region` 内でラベル `doc-sync-instance=<name>` を持つトリガーだけです。スケジュールルールの Cloud Scheduler ジョブ（`serviceRegion` 内で description `doc-sync-instance=<name>` を持つもの）も同様に作成・更新・削除します。ジョブには Cloud Run のサービス URL が要るので、関数の初回デプロイ後に実行してください。`firebase deploy` を先に実行することもできます |
| `rebuild [--dry-run] [--rule]... [--start-after]` | 全ターゲットを巡り、実際のイベントが書き込むはずの値を書き込みます。ソースが存在しない場合は `onSourceDelete` に従います |
| `verify [--fix] [--rule]... [--start-after]` | 全ターゲットを巡り、不整合（実際の値と期待値の差）を報告します。`--fix` を付けると修復します。不整合が残っていると終了コード 1 になります |
| `run <rule>` | Cloud Scheduler と同じ方法でスケジュールルールを 1 回実行します: トリガー用サービスアカウントになりすまして得た ID トークンで `POST /schedule/<rule>` を呼びます（`gcloud auth print-identity-token --impersonate-service-account ... --audiences <サービス URL>`）。呼び出す側にそのサービスアカウントへの `roles/iam.serviceAccountTokenCreator` が必要です。スケジュールルール専用です |
| `dev --url <handler>` | Firestore エミュレータとハンドラを CloudEvents で橋渡しします。エミュレータ専用です |

- `--config` の既定は `./doc-sync.config.ts` です。`--project` は次の順で解決します: `--project`、`GOOGLE_CLOUD_PROJECT` / `GCLOUD_PROJECT` / `CLOUDSDK_CORE_PROJECT`、`.firebaserc`（プロジェクトが 1 つだけのとき）、gcloud のアクティブな設定。どのコマンドも `Project:         <id> (from --project | from environment variable | from .firebaserc | from gcloud active config | emulator default)` を表示します。
- `setup`・`deploy`・`rebuild`（`--dry-run` なし）・`verify --fix`・`run` は、プロジェクトが gcloud のアクティブな設定からしか来ていない場合は実行を拒否します。`--project`、`GOOGLE_CLOUD_PROJECT`、`.firebaserc` のいずれかで明示してください。
- `rebuild` / `verify` / `dev` は Application Default Credentials を使うか、`FIRESTORE_EMULATOR_HOST` または `--emulator-host` が設定されていればエミュレータを使います。
- `--start-after` は最初に処理するルールにしか効きません。`--rule` と組み合わせて使ってください。
- `region` を変更すると古いトリガーがそのまま残ります。手動で削除するか、新しい設定に切り替える前に古い設定で `deploy` を実行してください。

## 変更はこう処理される

イベントのコレクションを `source` または `target` に持つ全ルールが動きます。ソース側の処理はルールをまたいで並列に行われ、イベント自身のドキュメントに対するターゲット側の処理はルールごとに順番に行われます。

| イベント | スキップされる条件 | それ以外 |
|---|---|---|
| connection のソースが変わった | `fields` のどれも変わっていない | ターゲット（`idField == id`）をページ単位で検索し、ページごとにソースを読み直して、値が異なるターゲットを `BulkWriter` で書き込みます |
| connection のターゲットが変わった | 削除された場合、または `idField` が変わらずかつ `targetField` が残っている場合 | ターゲットを読み直し、続けてそのソースを読み直します。`idField` が空なら `targetField` を削除し、ソースが存在しなければ `onSourceDelete` に従います |
| aggregate のソースが変わった | `idField` も合計対象のフィールドも変わっていない | 変更前・変更後のターゲットそれぞれについて、読み直して集計を実行し、値が異なれば書き込みます |
| aggregate のターゲットが変わった | 作成イベントではなく、かつ `targetField` が残っている | 集計を実行し、値が異なれば書き込みます |
| view の base が変わった | ドキュメントに変化なし | ターゲットを読み直し、続けて base を読む。base が無ければターゲットを削除。ターゲットが無ければ `build` して `create()`。それ以外は `build` して差分のパスを書く |
| view のソースが変わった | `watch` のフィールド（または全体）に変化なし | ターゲットごとに読み直し（`base` も。base が無ければターゲット削除、ターゲットが無ければ作成）、変更ドキュメントの読み直しで `patch`、または全ソースの読み直しで `build` |
| view のターゲットが変わった | 作成でなく、`refField` に変化がなく、宣言パスが全部残っている。`base` 付きでは削除以外も同様に skip | `build`。`base` 付きでは base があれば削除されたターゲットを作り直す |

- フィールドの書き込みはすべて、ソースより前に読んだ `updateTime` を条件にした `update(..., { lastUpdateTime })` です。`base` 付き view のターゲットは `create()` で作り、`delete({ lastUpdateTime })` で消します。事前条件の失敗（および `ALREADY_EXISTS`）はそのターゲットを読み直しからやり直し、`maxRetries` 回を超えるとリクエストは 500 で失敗します。

| レスポンス | 条件 |
|---|---|
| `204` | 完了、または何もする必要がない場合。デコードできないペイロード、未知のコレクション、別データベース宛て、Firestore 以外の `ce-type`、16 MiB を超えるボディ、20 階層を超えるネストも同様です（ログに出力されますが再送されません） |
| `500` | 一時的な失敗、リトライを使い切った場合、またはユーザーコードが例外を投げた場合。Eventarc が最大 24 時間バックオフ再送します |

## ログ

1 イベント・1 ルールにつき 1 行の JSON ログを出力します: `eventId`、`rule`、`kind`、`source`（ビューのソースキー）、`document`、`role`、`action`（`skip` / `write` / `delete` / `defer`。`defer` には印をつけた件数を表す `deferred` が付きます）、`reason`、`targets`、`writes`、`retries`、`reads`、`queries`、`aggregations`、`durationMs`（イベント全体の時間）。失敗したルールは `error` 付きで `doc-sync: failed, will be retried by Eventarc` をログに出します。defer のルールは `doc-sync: deferred`（印をつけた）、`doc-sync: flushed`（フラッシュが走った）、`doc-sync schedule: flush failed` もログに出します。

## コストの見積もり

`validate` はルールごとに、1 イベントが引き起こす読み取り・書き込みを `N`（マッチするターゲット数）と `M`（ターゲット 1 件あたりのソース文書数）の式で表示し、`refField` のビューのソース（ファンアウト）、`limit` も `patch` も無い多対一のビューのソース、そして必要な複合インデックスの無い `idField` 絞り込みの `sum` aggregate を警告します。`--strict` で警告を終了コード 1 にできます。

スケジュールルールは `schedule <cron> (<tz>): every <target>` の 1 行で、reads は `T × (ターゲット 1 件あたりの読み取り) per run, R runs/day`、writes は `≤ T per run`（T はターゲット数）です。cron が 1 日に 24 回を超えて実行される場合は警告が出ます。

defer ルールの印をつけるだけのイベントは reads `0 (+ 1 task)`（または `≤ 2 tasks`）、writes `0` になり、それぞれに再計算の reads/writes を持つ `flush <collection>/{id} (≤ 1 per <interval>)` 行が加わります。ライフサイクル行（ターゲットの最初の値、base の作成・削除）はそのままの即時コストを保ちます。

## 既知の制約

- ソースが削除されたときにターゲットは削除されません。`setNull` または `deleteField` を使ってください。
- アプリが上書きした `targetField` は、ソースが次に変わるか `rebuild` / `verify --fix` を実行するまで誤った値のままです。フィールドが削除された場合は、次のイベントで直ります。
- ターゲット検索には `idField` の単一フィールドインデックスが必要です。コレクショングループクエリ（`validate` が一覧します）にはコレクショングループインデックスが必要です。ビューで `idField` と `orderBy` を併用する場合、および `idField` で絞り込む `sum` aggregate にも複合インデックスが必要です。初回実行時に Firestore が作成用のリンクを表示します。
- `build` / `patch` での恒久的な失敗やインデックス不足は 500 を返し、最大 24 時間再送されます。`doc-sync: failed` のログ行を監視してください。

## 新しいプロジェクトへの初回デプロイ

- Cloud Build には、Firebase のデプロイが前提とする権限を持つデフォルトのコンピュート用サービスアカウントが必要です。最近の組織ポリシーでは既定で Editor ロールが外れているため、`roles/cloudbuild.builds.builder`、`roles/artifactregistry.writer`、`roles/logging.logWriter` を付与するか、専用のビルド用サービスアカウントを使ってください。
- Eventarc のサービスエージェントは `setup` が作成し、使えるようになるまで数分かかることがあります。トリガー作成が拒否されたら `deploy` をやり直してください。
- `setup` は Cloud Run サービスが存在してからでないと `roles/run.invoker` を付与しません。そのため順序は setup → 関数のデプロイ → deploy（トリガーとジョブ） → setup の再実行 になります。

## 後片付け

- Cloud Tasks のキューを削除すると、同じ名前のキューは 7 日間作り直せません。
- 削除したトリガー用サービスアカウントは 30 日間復元できます。`setup` を再実行すると同じメールアドレスの新しいアカウントが作られますが、これは別の ID です。元のアカウントに戻したい場合は先に復元してください。

## セキュリティ

- ハンドラはリクエストを認証しません。トリガー用サービスアカウントだけが呼べるように制限してください: `onRequest` の `invoker:`、または Cloud Run での `--no-allow-unauthenticated` + `roles/run.invoker` です。これがないと関数は公開状態になります。
- 偽造・再送されたリクエストができるのは再計算の強制です。読み取り、正しい値の書き込み、スケジュール実行・defer のフラッシュが起きます。値は常に本物のソースから読み直されます。`patch` の `change.after` はメンバーシップを確認した読み直しですが、`change.before` はリクエストのペイロードそのままで偽造されうるので、値の導出には使わないでください。
- 継続・フラッシュのタスクは `https://<Host ヘッダー>` に呼び返します。run.app 以外のホストでもサービスに到達できる構成では `schedule.serviceUrl` を設定してください。
- Scheduler ジョブはトリガー用サービスアカウントの OIDC トークンで関数を呼ぶので、同じ `invoker` の制限がかかります。`/schedule/<rule>` 経路自体は認証しません。
- 継続タスクも同じトリガー用サービスアカウントの OIDC トークンで呼び返すので、同じ `invoker` の制限がかかります。
- `setup` はトリガー用サービスアカウントに、プロジェクトへの `roles/eventarc.eventReceiver` とサービスへの `roles/run.invoker` を付与します。`--runtime-service-account` を付けると、ランタイム用サービスアカウントにキューへの `roles/cloudtasks.enqueuer` とトリガー用サービスアカウントへの `roles/iam.serviceAccountUser` も付与します。ランタイム用サービスアカウントで動くすべてのワークロードがトリガー用サービスアカウントとして振る舞えるようになります。
- 関数のランタイム用サービスアカウントには Firestore の読み書き権限（`roles/datastore.user`）が必要で、あなたの `build` / `patch` を実行します。既定のコンピュート用サービスアカウントではなく専用のものを使ってください。
- ファンアウトにはイベント単位の上限がありません。`validate` の警告、`maxInstances`、`timeoutSeconds` で制御してください。
- `verify` の出力と `Mismatch` オブジェクトにはドキュメントの値が含まれます。ログにはドキュメントのパスと ID、および `build` / `patch` が投げたエラーのメッセージが含まれます。

## 推奨する関数の設定

| 設定 | 値 | 理由 |
|---|---|---|
| `cpu` | 1 | `concurrency > 1` に必要。I/O 待ち中心の処理です |
| `memory` | 512MiB | ターゲット検索はページングされます |
| `concurrency` | 80 | Firestore の応答待ちが中心です |
| `minInstances` | 1 | コールドスタートを避けます（任意） |
| `maxInstances` | 10 | 書き込みの急増を抑えます |
| `timeoutSeconds` | 300（スケジュールルールがあれば `schedule.budgetMs` 以上） | イベントのみなら 300（Eventarc の ack 期限 600 秒未満）。スケジュールルールがあれば `schedule.budgetMs`（既定 20 分 → 1800）以上 |
| `invoker` | トリガー SA のメールアドレス | 必須。これがないと公開状態になります |
