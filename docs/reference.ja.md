# リファレンス

[README](../README.ja.md) · [設定](#設定) · [ハンドラ](#ハンドラ) · [CLI](#cli) · [変更はこう処理される](#変更はこう処理される) · [ログ](#ログ) · [コストの見積もり](#コストの見積もり) · [既知の制約](#既知の制約) · [セキュリティ](#セキュリティ) · [推奨する関数の設定](#推奨する関数の設定)

## 設定

設定ファイル（例: `functions/src/doc-sync.config.ts`。名前は自由で、`--config` で渡します）は `defineConfig({ ... })` をエクスポートします。TypeScript でも JavaScript でも、ESM でも CJS でも構いません。完全な例: [examples/functions/src/doc-sync.config.ts](../examples/functions/src/doc-sync.config.ts)。

| キー | 意味 |
|---|---|
| `name` | インスタンス名。トリガー名の接頭辞（`[a-z][a-z0-9-]*`） |
| `region` | Eventarc のロケーション = Firestore データベースのロケーション（`asia-northeast1`、`nam5` など） |
| `database` | Firestore のデータベース ID。既定 `(default)` |
| `service` | 関数の Cloud Run サービス名（`onRequest` の場合は関数名を小文字化したもの） |
| `serviceRegion` | Cloud Run のリージョン。既定は `region`。`region` がマルチリージョン（`nam5`、`eur3` など）のときは必須 |
| `serviceAccount` | トリガー用サービスアカウント。ID だけ書くと `<id>@<project>.iam.gserviceaccount.com` に補完される |
| `rules[]` | ルール。順序は自由: `defineConnection(...)`、`defineAggregate(...)`、`defineView(...)`、`defineProjection(...)`（または `kind` を持つオブジェクト） |

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
createDocSyncHandler(config, { firestore, logger, maxRetries, pageSize })
```

| オプション | 既定 | 意味 |
|---|---|---|
| `firestore` | `getFirestore()` | Firestore インスタンス |
| `logger` | 標準出力への JSON | `info` / `warn` / `error` を持つ任意のオブジェクト。`console` も使えます |
| `maxRetries` | 5 | 条件付き書き込みが失敗したターゲットのやり直し回数 |
| `pageSize` | 500 | ターゲット検索のページサイズ |

ハンドラは `(req, res) => Promise<void>` で、Express や Node の `http` でも使えます。

## CLI

| コマンド | 内容 |
|---|---|
| `validate [--strict]` | 設定を検査します。トリガー、コストの見積もり、書き込みの連鎖、警告を表示します。`--strict` を付けると警告があれば失敗します |
| `setup` | トリガー用サービスアカウントを作成し、`roles/eventarc.eventReceiver`（プロジェクト）と `roles/run.invoker`（サービス）を付与し、API を有効化します。冪等です。サービスがまだ存在しない間は invoker の付与をスキップするので、最初のデプロイ後に再実行してください |
| `deploy [--deploy-function <name>]` | 不足しているトリガーを作成し、ずれたもの（サービス、サービスのリージョン、パスパターン、サービスアカウント）を更新し、不要になったものを削除します。対象は `region` にある `doc-sync-instance=<name>` ラベル付きのトリガーだけです。先に `firebase deploy` を実行することもできます |
| `rebuild [--dry-run] [--rule]... [--start-after]` | 全ターゲットを巡り、実際のイベントが書き込むはずの値を書き込みます。ソースが存在しない場合は `onSourceDelete` に従います |
| `verify [--fix] [--rule]... [--start-after]` | 全ターゲットを巡り、不整合（実際の値と期待値の差）を報告します。`--fix` を付けると修復します。不整合が残っていると終了コード 1 になります |
| `dev --url <handler>` | Firestore エミュレータとハンドラを CloudEvents で橋渡しします。エミュレータ専用です |

- `--config` の既定は `./doc-sync.config.ts`、`--project` の既定は `$GOOGLE_CLOUD_PROJECT`、次いで gcloud のアクティブなプロジェクトです。
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

1 イベント・1 ルールにつき 1 行の JSON ログを出力します: `eventId`、`rule`、`kind`、`source`（ビューのソースキー）、`document`、`role`、`action`（`skip` / `write` / `delete`）、`reason`、`targets`、`writes`、`retries`、`reads`、`queries`、`aggregations`、`durationMs`（イベント全体の時間）。失敗したルールは `error` 付きで `doc-sync: failed, will be retried by Eventarc` をログに出します。

## コストの見積もり

`validate` はルールごとに、1 イベントが引き起こす読み取り・書き込みを `N`（マッチするターゲット数）と `M`（ターゲット 1 件あたりのソース文書数）の式で表示し、`refField` のビューのソース（ファンアウト）と、`limit` も `patch` も無い多対一のビューのソースを警告します。`--strict` で警告を終了コード 1 にできます。

## 既知の制約

- ソースが削除されたときにターゲットは削除されません。`setNull` または `deleteField` を使ってください。
- アプリが上書きした `targetField` は、ソースが次に変わるか `rebuild` / `verify --fix` を実行するまで誤った値のままです。フィールドが削除された場合は、次のイベントで直ります。
- ターゲット検索には `idField` の単一フィールドインデックスが必要です。コレクショングループクエリ（`validate` が一覧します）にはコレクショングループインデックスが必要です。ビューで `idField` と `orderBy` を併用する場合は複合インデックスが必要です。初回実行時に Firestore が作成用のリンクを表示します。
- `build` / `patch` での恒久的な失敗やインデックス不足は 500 を返し、最大 24 時間再送されます。`doc-sync: failed` のログ行を監視してください。

## セキュリティ

- ハンドラはリクエストを認証しません。トリガー用サービスアカウントだけが呼べるように制限してください: `onRequest` の `invoker:`、または Cloud Run での `--no-allow-unauthenticated` + `roles/run.invoker` です。これがないと関数は公開状態になります。
- 偽造・再送されたリクエストができるのは、再計算(読み取り)を強制することだけです。値は常に本物のソースから読み直され、`patch` が受け取るのもリクエストのデータではなく、メンバーシップを確認した上での読み直しです。
- `setup` がトリガー用サービスアカウントに付与するのは、プロジェクトへの `roles/eventarc.eventReceiver` とサービスへの `roles/run.invoker` だけです。
- 関数のランタイム用サービスアカウントには Firestore の読み書き権限（`roles/datastore.user`）が必要で、あなたの `build` / `patch` を実行します。既定のコンピュート用サービスアカウントではなく専用のものを使ってください。
- ファンアウトにはイベント単位の上限がありません。`validate` の警告、`maxInstances`、`timeoutSeconds` で制御してください。
- `verify` の出力と `Mismatch` オブジェクトにはドキュメントの値が含まれます。

## 推奨する関数の設定

| 設定 | 値 | 理由 |
|---|---|---|
| `cpu` | 1 | `concurrency > 1` に必要。I/O 待ち中心の処理です |
| `memory` | 512MiB | ターゲット検索はページングされます |
| `concurrency` | 80 | Firestore の応答待ちが中心です |
| `minInstances` | 1 | コールドスタートを避けます（任意） |
| `maxInstances` | 10 | 書き込みの急増を抑えます |
| `timeoutSeconds` | 300 | ファンアウトの余裕を持たせつつ、Eventarc の ack 期限 600 秒より短くします |
| `invoker` | トリガー SA のメールアドレス | 必須。これがないと公開状態になります |
