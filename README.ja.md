# firestore-denormalize

Firestore の派生データ（非正規化コピー・件数・合計）を、**Cloud Run 関数 1 つ ＋ コレクションごとの Eventarc トリガー**で正しく保ちます。

[English README](./README.md)

`category/{id}` の一部フィールドを `post.category` にコピーしている、あるいは `post.likeCount` をいいねの件数に保っている場合、元が変わるたびに派生値を更新する必要があります。このパッケージは、そうしたルールを TypeScript の 1 ファイルで何個でも定義し、まとめて処理します。

```ts
// doc-sync.config.ts
import { defineConfig, defineView } from 'firestore-denormalize'

export default defineConfig({
  name: 'doc-sync',
  region: 'asia-northeast1',
  service: 'docsync',
  serviceAccount: 'doc-sync-trigger',
  connections: [
    {
      name: 'post-category',
      source: 'category',          // category/{id} から
      target: 'post',              // post ドキュメントへ
      idField: 'categoryId',       // post.categoryId == id のものを対象に
      fields: ['name', 'color'],   // このフィールドを
      targetField: 'category',     // post.category = { name, color } として書く
      onSourceDelete: 'setNull',   // 'setNull' | 'deleteField' | 'nothing'
    },
  ],
  aggregates: [
    {
      name: 'post-likes',
      source: 'post/{postId}/like', // このサブコレクションの件数を
      target: 'post',               // 親の post に
      idParam: 'postId',            // post を指すプレースホルダ
      aggregate: 'count',           // または { sum: 'amount' }
      targetField: 'likeCount',
    },
  ],
  views: [
    defineView({
      // post.latestComments = post/{postId}/comment の最新 2 件を [{ id, body }] として
      name: 'post-latest-comments',
      target: 'post',
      targetField: 'latestComments',
      sources: { comments: { collection: 'post/{postId}/comment', idParam: 'postId', orderBy: [['createdAt', 'desc']], limit: 2 } },
      build: ({ sources }) => sources.comments.map((c) => ({ id: c.id, body: c.get('body') })),
    }),
  ],
})
```

## 特徴

- `firestore-connect-document` 系 Extension の「ルール 1 つにつき関数 2 つ」を、関数 1 つに集約します。
- Eventarc の at-least-once・順序保証なしの配信でも正しく収束します。イベントの値は「処理が必要か」の判定にだけ使い、書き込む値は**常に Firestore から読み直し**（コピー）または**集計クエリで再計算**（件数・合計）し、書き込みは**ターゲットの `updateTime` を前提条件にした条件付き書き込み**で行います。遅延・重複したイベントが新しい値を古い値で上書きすることはなく、`increment()` を使わないのでカウンタがずれることもありません。
- トリガーの作成・削除は、同じ設定ファイルからコマンド 1 つで行います。`rebuild` で既存データをバックフィルでき、`dev` で同じハンドラを Emulator Suite で動かせます。

## 必要なもの

- Node.js 20 以上、`firebase-admin` 12 以上（peerDependency）
- Native モードの Firestore。トリガーはデータベースのロケーション（`asia-northeast1`、`nam5` など）に作成します。
- `doc-sync setup` / `doc-sync deploy` には認証済みの `gcloud` CLI

## インストール

```sh
npm install firestore-denormalize
```

## クイックスタート

### 1. 設定ファイルを書く

Firebase プロジェクトのルートに `doc-sync.config.ts` を置きます（上記参照）。

| キー | 意味 |
|---|---|
| `name` | インスタンス名。トリガー名・ラベルに使います（`[a-z][a-z0-9-]*`） |
| `region` | Eventarc トリガーのロケーション。Firestore のロケーションと一致させます |
| `database` | Firestore のデータベース ID。既定 `(default)` |
| `service` | デプロイした関数の Cloud Run サービス名（`onRequest` なら関数名の小文字） |
| `serviceRegion` | Cloud Run サービスのリージョン。既定は `region` |
| `serviceAccount` | トリガー用サービスアカウント。ID だけ書くと `<id>@<project>.iam.gserviceaccount.com` に補完されます |
| `connections[]` | コピーのルール（後述） |
| `aggregates[]` | 件数・合計のルール（後述） |
| `views[]` | 自前の `build` 関数で値を計算するルール（後述） |

**コレクション**はパスで書きます。サブコレクションは親 ID をプレースホルダにします: `users/{uid}/posts`。**フィールド**はドット区切りのパスも使えます: `address.city`。

**`connections[]`** は `source/{id}` の `fields` を、`target.idField == id` である全ターゲットの `target.targetField` にコピーします。ターゲットからソースをたどれるよう、`source` のプレースホルダはすべて `target` にも現れる必要があります。`target` 側に余分なプレースホルダがある場合（`category` → `users/{uid}/posts`）は、コレクショングループクエリでターゲットを探します。

**`aggregates[]`** は、ターゲットに属するソースドキュメントの `count()` または `{ sum: 'field' }` を `target.targetField` に保ちます。ターゲットの指定は、ソース上のフィールド（`idField: 'postId'`）か、ソースパスのプレースホルダ（`post/{postId}/like` に対する `idParam: 'postId'`）のどちらかです。

**`views[]`** は `build({ target, sources })` の戻り値を `target.targetField` に保ちます。「最新 N 件」「ID をキーにしたマップ」「独自のサマリー」など、他のルールでは表現できない形のためのものです。`sources` は `build` から見える名前をキーにしたオブジェクトで、各ソースにはコレクションと、そのドキュメントがターゲットとどう結びつくかを書きます:

| ソースのキー | 関係 |
|---|---|
| `idField: 'postId'` | 多対一: このフィールドにターゲット ID を持つソースドキュメント |
| `idParam: 'postId'` | 多対一: ターゲット配下のソースドキュメント（`post/{postId}/comment`） |
| `refField: 'authorId'` | 一対一: ターゲット自身のこのフィールドが指すドキュメント |

多対一のソースには `orderBy`（`['createdAt', ['score', 'desc']]`）と `limit` を指定できます。`watch` は再計算のきっかけになるソース側のフィールドで、省略するとどのフィールドの変更でも再計算します。`build` には各ソースが `QueryDocumentSnapshot` の配列として渡され（`refField` は 0 件か 1 件）、決定的でなければなりません。戻り値がそのまま保存され、`undefined` を返すとフィールドを削除します。任意の `patch(current, change, { target, firestore })` は高速パスで、現在値と変更されたドキュメントだけから新しい値を導きます。`undefined` を返すと `build` にフォールバックします。`change.after` はイベントのペイロードではなく、そのドキュメントを読み直した現在の状態です（もう存在しなければ `undefined`）。そのため遅延・重複したイベントでも現在の状態に収束しますが、`patch` は冪等で、位置ではなくドキュメント ID をキーにしなければなりません。`firestore` は、削除後に「最新 N 件」を `limit(1)` で補充するような、少量の追加読み取りのためのものです。ターゲット側で監視するのは `refField` だけです。`build` がターゲットの他のフィールドを読む場合、その変更は次のソース変更か `rebuild` まで反映されません。各ビューを `defineView(...)` で包むと、`build` の中で `sources` に型が付きます。

バリデーションでは、名前の重複、同じコレクションの重なるフィールドへの二重書き込み、解決できないプレースホルダ、不正なパス、「あるルールの書き込みが次のルールを起動し、一周して戻る」ループを拒否します。

### 2. ハンドラを HTTP 関数として公開する

```ts
// functions/src/index.ts
import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { onRequest } from 'firebase-functions/v2/https'
import { createDocSyncHandler } from 'firestore-denormalize'
import config from '../../doc-sync.config'

initializeApp()

export const docSync = onRequest(
  {
    region: 'asia-northeast1',
    cpu: 1,
    memory: '512MiB',
    concurrency: 80,
    minInstances: 1,
    maxInstances: 10,
    timeoutSeconds: 300,
    invoker: 'doc-sync-trigger@<project>.iam.gserviceaccount.com',
  },
  createDocSyncHandler(config, {
    firestore: getFirestore(), // 省略時 getFirestore()
    logger: console,           // 省略時は構造化 JSON ロガー
    maxRetries: 5,             // 条件付き書き込みが失敗したターゲットをやり直す回数
    pageSize: 500,             // ターゲット検索のページサイズ
  }),
)
```

ハンドラは素の `(req, res) => Promise<void>` なので、Express や Node の `http` サーバーでも使えます。`firebase-functions` には依存しません。

### 3. トリガー用サービスアカウントを作る（初回のみ）

```sh
npx doc-sync setup --project <project>
```

サービスアカウントの作成、プロジェクトへの `roles/eventarc.eventReceiver` 付与、サービスへの `roles/run.invoker` 付与、Eventarc / Cloud Run API の有効化を行います。冪等です。`--dry-run` を付けると `gcloud` コマンドを表示するだけになります。

### 4. 関数をデプロイし、トリガーを作る

```sh
firebase deploy --only functions:docSync
npx doc-sync deploy --project <project>
```

`deploy` は、ラベル `doc-sync-instance=<name>` 付きの既存トリガーを取得し、`source` または `target` に現れるコレクションごとに不足分を作成、設定とずれたもの（サービス・リージョン・データベース・サービスアカウント）を更新、設定から消えたコレクションの分を削除し、それ以外には触れません。`--deploy-function docSync` で先に `firebase deploy` を実行、`--dry-run` でコマンド表示のみにできます。

トリガー名は `<name>-<コレクション ID を - で連結>`（`users/{uid}/payments` → `<name>-users-payments`、`_` は `-` に置換）です。各トリガーは `google.cloud.firestore.document.v1.written` をそのコレクションのパスパターン（`document=users/{uid}/payments/{docId}`）でフィルタし、protobuf 形式で配信します。

### 5. 既存データをバックフィルする

```sh
npx doc-sync rebuild --project <project> --dry-run      # 何が変わるかを表示するだけ
npx doc-sync rebuild --project <project>                 # 適用
npx doc-sync rebuild --project <project> --rule post-category --start-after post/abc   # ルール指定・途中から再開
```

`rebuild` は各ルールのターゲットをページ単位で全件たどり、ハンドラと同じ「計算して条件付き書き込み」のコードで現在のソースに揃えます。ソースが存在しないターゲットには `onSourceDelete` を適用します。進捗行に最後に処理したパスが出るので、中断しても `--start-after` で再開できます。認証は Application Default Credentials（`gcloud auth application-default login`）、`FIRESTORE_EMULATOR_HOST` があればエミュレータに接続します。

### 6. 検証する

```sh
npx doc-sync verify --project <project>                 # 不整合を一覧表示するだけ
npx doc-sync verify --project <project> --fix           # 見つけて直す
npx doc-sync verify --project <project> --rule post-category --start-after post/abc
```

`verify` は `rebuild` と同じ要領で各ルールのターゲットを全件たどりますが、書き込む代わりに比較します。現在のソースから値を再計算し、`targetField` が異なるドキュメントをすべて報告するだけで、何も変更しません。`--fix` を付けると、ハンドラと同じ条件付き書き込みで不整合を直します。直っていない不整合が残っていると終了コードが非 0 になるので、CI やスケジュール実行で本番の整合性チェックとして使えます。

## Emulator Suite でのローカル開発

エミュレータには Firestore 用の Eventarc がないため、`doc-sync dev` がその穴を埋めます。実行経路は本番と同じです: Firestore エミュレータの対象コレクションを `onSnapshot` で監視し、変更を Eventarc と同じ形式（protobuf の `DocumentEventData`）に符号化して、Functions エミュレータで動いている関数に POST します。

```sh
firebase emulators:start --only firestore,functions
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx doc-sync dev --project demo-app \
  --url http://127.0.0.1:5001/demo-app/asia-northeast1/docSync
```

起動時に存在するドキュメントはキャッシュするだけでイベントにはせず、以降の変更を配信します。`FIRESTORE_EMULATOR_HOST`（または `--emulator-host`）がないと起動を拒否するので、誤って本番に向けることはできません。

## CLI

```
doc-sync validate [--config <path>]
doc-sync setup    [--config <path>] [--project <id>] [--dry-run]
doc-sync deploy   [--config <path>] [--project <id>] [--dry-run] [--deploy-function <name>]
doc-sync rebuild  [--config <path>] [--project <id>] [--dry-run] [--rule <name>]... [--start-after <path>] [--page-size <n>]
doc-sync verify   [--config <path>] [--project <id>] [--fix] [--rule <name>]... [--start-after <path>] [--page-size <n>]
doc-sync dev      [--config <path>] [--project <id>] --url <handler url> [--emulator-host <host:port>]
```

`--config` の既定は `./doc-sync.config.ts`、`--project` の既定は `$GOOGLE_CLOUD_PROJECT`、次いで gcloud のアクティブなプロジェクトです。設定ファイルは TypeScript / JavaScript、ESM / CJS のいずれでも構いません。

## 変更はこう処理される

`collection/docId` のイベントに対し、そのコレクションを `source` または `target` に持つ全 connection が独立に動きます。

**ソースとして**（`category/c1` が変わった）

1. 更新イベントで `fields` のどれも変わっていなければ終了。
2. `target where idField == docId` を `pageSize` 件ずつ検索。
3. ページごとに現在のソースを `get()`。存在すれば `{ ...fields }` を作る（ソースにないフィールドは含めない）。存在しなければ `onSourceDelete` に従い、`null` を書く / フィールドを削除する / 終了する。
4. `targetField` がその値と異なるターゲットだけ、手順 2 で観測した `updateTime` を `lastUpdateTime` にして `update()`。書き込みは `BulkWriter` 経由。

**ターゲットとして**（`post/p1` が変わった）

1. 削除イベント、または `idField` が変わっていなければ終了。
2. 現在のターゲットを `get()`。`idField` が空なら `targetField` を削除（存在する場合）。
3. それ以外は参照先ソースを `get()` して値を作る。ソースが存在しなければ何もしない。
4. 値に差がある場合のみ、手順 2 の `updateTime` を前提条件に書き込む。

**件数・合計**（`post/p1/like/u1` の作成・削除、または監視フィールドの変更）

1. 更新イベントで `idField` も合計対象フィールドも変わっていなければ終了。
2. 変更前・変更後にそのドキュメントが属していたターゲット（最大 2 つ）ごとに、ターゲットを `get()` → 集計クエリ → 値が異なれば `updateTime` を前提条件に書き込み。新規作成されたターゲットにも同じ手順で初期値を入れます。

**ビュー。** ソース側の変更では（`watch` を指定していればそのフィールド、指定していなければドキュメント全体に変化がなければスキップ）、そのドキュメントが属する各ターゲットを読み、`patch`（定義されていれば、変更されたドキュメントを読み直して渡す。`undefined` を返せば `build` にフォールバック）または全ソースを読み直す `build` で値を計算し、差があれば条件付きで書き込みます。ターゲット側では、作成時と `refField` が変わったときに再計算します。`rebuild` / `verify` は常に `build` を使います。

**競合。** 間に別の書き込みがあって条件付き書き込みが失敗したら、そのターゲットだけ手順 2 からやり直します（最大 `maxRetries` 回。超えたら 500 を返し Eventarc が再送）。ソースが読んだ後に変わっていたら、その変更のイベントが面倒を見ます。値は深く比較する（`Timestamp` / `GeoPoint` / `DocumentReference` / バイト列を含む）ので、自身の書き込みによるイベントは no-op になり、`area -> shop.area -> post.shop.area` のような多段連鎖も必ず停止します。

**レスポンス。** 完了・処理不要は `204`。回復不能な入力（壊れたペイロード、未知のコレクション、別データベース）も `error` / `warn` ログを出して `204`（再送させない）。一時的な失敗は `500` で、Eventarc が最大 24 時間バックオフ再送します。処理は冪等です。

**ログ。** 1 イベント・1 ルールにつき 1 行の構造化ログ: `rule`、`kind`、`document`、`role`、`action`（`skip` / `write` / `delete`）、`reason`、`targets`、`writes`、`retries`、`durationMs`。

## 既知の制約

- ソース削除時にターゲットを削除することはできません。`setNull` か `deleteField` を使ってください。
- アプリが `targetField` を直接書いた場合、ソースが次に変わる（または `rebuild` する）までその値のままです。
- ターゲット検索のため `idField` に既定の単一フィールドインデックスが必要です。コレクショングループクエリが必要なルール（`validate` が一覧します）には、そのフィールドのコレクショングループスコープのインデックスが必要です。初回実行時に Firestore が作成用リンクを出します。
- 件数・合計は、影響を受けるターゲット 1 つにつきイベントごとに集計読み取り 1 回のコストがかかります。ビューは `patch` で処理できない限り、影響を受けるターゲット 1 つにつきソースごとに読み取り（またはクエリ）1 回です。
- 遅延は Eventarc の配信遅延（通常 1 秒未満〜数秒）に依存します。

## 推奨する関数の設定

| 項目 | 値 | 根拠 |
|---|---|---|
| `cpu` | 1 | `concurrency > 1` に必要。I/O 待ち中心 |
| `memory` | 512MiB | ターゲット検索をページングするため上限は一定 |
| `concurrency` | 80 | Firestore の応答待ちが中心 |
| `minInstances` | 1 | コールドスタート回避（任意） |
| `maxInstances` | 10 | Firestore への書き込み急増の抑制 |
| `timeoutSeconds` | 300 | 大量書き込み用。Eventarc の ack 期限 600 秒より短く |

導入後は Cloud Run の CPU・メモリ・レイテンシ・インスタンス数を見て調整してください。

## 開発

```sh
npm install
npm run typecheck
npm test          # Firestore エミュレータを使ったユニット＋結合テスト（firebase-tools と Java が必要）
npm run build     # dist/ に ESM + CJS + .d.ts を出力
```

`npm run protos:build` で `protos/` の `.proto` から `src/proto/firestore-events.json` を再生成します。

## ライセンス

MIT
