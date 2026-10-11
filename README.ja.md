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
- `--deploy-function` と Emulator Suite には Firebase CLI（`firebase-tools`）

## インストール

```sh
npm install firestore-denormalize
```

## クイックスタート

### 1. 設定ファイルを書く

`doc-sync.config.ts` は functions のソースツリーの中、`functions/src/doc-sync.config.ts` に置きます（内容は上記参照）。プロジェクトのルートではなくここに置く必要があります。`firebase deploy` は `functions/` 配下のファイルしかデプロイしませんし、`functions/src` に置くことで `tsc` がそれを他のコードと同じフラットな `functions/lib` にそのままコンパイルできるからです。

| キー | 意味 |
|---|---|
| `name` | インスタンス名。トリガー名・ラベルに使います（`[a-z][a-z0-9-]*`） |
| `region` | Eventarc トリガーのロケーション。Firestore のロケーションと一致させます（マルチリージョンの Firestore なら `nam5` など） |
| `database` | Firestore のデータベース ID。既定 `(default)` |
| `service` | デプロイした関数の Cloud Run サービス名（`onRequest` なら関数名の小文字） |
| `serviceRegion` | Cloud Run サービスのリージョン。既定は `region`。`region` がマルチリージョン（`nam5`、`eur3` など）のときは必須です。Cloud Run にはそのリージョンが存在しないためです |
| `serviceAccount` | トリガー用サービスアカウント。ID だけ書くと `<id>@<project>.iam.gserviceaccount.com` に補完されます |
| `connections[]` | コピーのルール（後述） |
| `aggregates[]` | 件数・合計のルール（後述） |
| `views[]` | 自前の `build` 関数で値を計算するルール（後述） |

トリガー名はコレクション ID を小文字化して作られます（`chatRooms` → `chatrooms`）。バリデーションは、これが衝突する組み合わせを拒否します。また `users/admin/posts` と `users/{uid}/posts` のように、同じドキュメントにマッチし得る 2 つのコレクションパターンも拒否します。

**コレクション**はパスで書きます。サブコレクションは親 ID をプレースホルダにします: `users/{uid}/posts`。**フィールド**はドット区切りのパスも使えます: `address.city`。

**`connections[]`** は `source/{id}` の `fields` を、`target.idField == id` である全ターゲットの `target.targetField` にコピーします。ターゲットからソースをたどれるよう、`source` のプレースホルダはすべて `target` にも現れる必要があります。`target` 側に余分なプレースホルダがある場合（`category` → `users/{uid}/posts`）は、コレクショングループクエリでターゲットを探します。

**`aggregates[]`** は、ターゲットに属するソースドキュメントの `count()` または `{ sum: 'field' }` を `target.targetField` に保ちます。ターゲットの指定は、ソース上のフィールド（`idField: 'postId'`）か、ソースパスのプレースホルダ（`post/{postId}/like` に対する `idParam: 'postId'`）のどちらかです。

**`views[]`** は `build({ target, sources })` の戻り値を `target.targetField` に保ちます。「最新 N 件」「ID をキーにしたマップ」「独自のサマリー」など、他のルールでは表現できない形のためのものです。`sources` は `build` から見える名前をキーにしたオブジェクトで、各ソースにはコレクションと、そのドキュメントがターゲットとどう結びつくかを書きます:

| ソースのキー | 関係 |
|---|---|
| `idField: 'postId'` | 多対一: このフィールドにターゲット ID を持つソースドキュメント |
| `idParam: 'postId'` | 多対一: ターゲット配下のソースドキュメント（`post/{postId}/comment`） |
| `refField: 'authorId'` | 一対一: ターゲット自身のこのフィールドが指すドキュメント |

多対一のソースには `orderBy`（`['createdAt', ['score', 'desc']]`）と `limit` を指定できます。`watch` は再計算のきっかけになるソース側のフィールドで、省略するとどのフィールドの変更でも再計算します。`watch` には、ソースに `idField` があればそれと `orderBy` のフィールドが常に自動で加わります。メンバーシップと順序を決めるのがこれらのフィールドだからです。`build` には各ソースが `QueryDocumentSnapshot` の配列として渡され（`refField` は 0 件か 1 件）、決定的でなければなりません。戻り値がそのまま保存され、`undefined` を返すとフィールドを削除します。書き込む前に戻り値から `undefined` は取り除かれます。マップのエントリが `undefined` なら削除され、配列の要素が `undefined` なら `null` になります。任意の `patch(current, change, { target, firestore })` は高速パスで、現在値と変更されたドキュメントだけから新しい値を導きます。`undefined` を返すと `build` にフォールバックします。`change.after` はイベントのペイロードではなく、そのドキュメントを読み直した現在の状態です。ドキュメントが削除されたときだけでなく、変更後にこのターゲットに属さなくなったとき（たとえば別の親に移動したとき）も `undefined` になります。そのため `patch` は「`after` が `undefined`」を「この項目を取り除く」として扱えます。遅延・重複したイベントでも現在の状態に収束しますが、`patch` は冪等で、位置ではなくドキュメント ID をキーにしなければなりません。`firestore` は、削除後に「最新 N 件」を `limit(1)` で補充するような、少量の追加読み取りのためのものです。ターゲット側で監視するのは `refField` だけです。`build` がターゲットの他のフィールドを読む場合、その変更は次のソース変更か `rebuild` まで反映されません。各ビューを `defineView(...)` で包むと、`build` の中で `sources` に型が付きます。

バリデーションでは、名前の重複、同じコレクションの重なるフィールドへの二重書き込み、解決できないプレースホルダ、不正なパス、「あるルールの書き込みが次のルールを起動し、一周して戻る」ループを拒否します。

#### 型付きの設定

`typed<Collections>()` にコレクションパスをキーにしたドキュメント型を渡すと、設定内のフィールド名がすべてコンパイル時に検査されます。フィールドをリネームしたとき、黙って `undefined` がコピーされる代わりに `tsc` が失敗します。

```ts
import { typed } from 'firestore-denormalize'
import type { Post, Category, Comment } from './types'

type Collections = { post: Post; category: Category; 'post/{postId}/comment': Comment }
const { defineConfig, defineView } = typed<Collections>()

export default defineConfig({
  // ...
  connections: [
    // `source` / `target` は Collections のキー。`fields` は Category のパス、
    // `idField` は Post の string フィールド、`targetField` は Post のフィールド
    { name: 'post-category', source: 'category', target: 'post', idField: 'categoryId', fields: ['name', 'color'], targetField: 'category', onSourceDelete: 'setNull' },
  ],
  views: [
    defineView({
      name: 'post-latest-comments',
      target: 'post',
      targetField: 'latestComments', // Post に存在する必要があり、build はその型を返す
      sources: { comments: { collection: 'post/{postId}/comment', idParam: 'postId', orderBy: [['createdAt', 'desc']], limit: 2 } },
      build: ({ sources }) => sources.comments.map((c) => ({ id: c.id, body: c.data().body })), // c は QueryDocumentSnapshot<Comment>
    }),
  ],
})
```

フィールドパスはドット区切りも使えます（`'address.city'`）。`idField` / `refField` は string のフィールド、`sum` と集計の `targetField` は number のフィールド、`idParam` はソースパスのプレースホルダに限られます。`Collections` はインターフェースではなく型エイリアスで書いてください。どちらの関数も実行時には何もしないので、`validateConfig` と CLI には通常の設定として見えます。

### 2. ハンドラを HTTP 関数として公開する

```ts
// functions/src/index.ts
import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { onRequest } from 'firebase-functions/v2/https'
import { createDocSyncHandler } from 'firestore-denormalize'
// doc-sync.config.ts はこのファイルと同じ functions/src の中にあります。
import config from './doc-sync.config'

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
npx doc-sync setup --project <project> --config functions/src/doc-sync.config.ts
```

サービスアカウントの作成、プロジェクトへの `roles/eventarc.eventReceiver` 付与、サービスへの `roles/run.invoker` 付与、Eventarc / Cloud Run API の有効化を行います。冪等です。`--dry-run` を付けると `gcloud` コマンドを表示するだけになります。

初回実行時はまだ Cloud Run サービスが存在しないため、`roles/run.invoker` をそこに付与できません。`setup` はその旨を表示してこの手順だけ飛ばし、代わりに手順 2 で設定した `invoker:` に任せます。最初の `firebase deploy` の後にもう一度 `setup` を実行すると、そのとき付与されます（再実行は常に安全です）。

### 4. 関数をデプロイし、トリガーを作る

```sh
firebase deploy --only functions:docSync
npx doc-sync deploy --project <project> --config functions/src/doc-sync.config.ts
```

`deploy` は、ラベル `doc-sync-instance=<name>` 付きの既存トリガーを取得し、`source` または `target` に現れるコレクションごとに不足分を作成、設定とずれたもの（Cloud Run サービスとそのリージョン、ドキュメントのパスパターン、サービスアカウント）を更新、設定から消えたコレクションの分を削除し、それ以外には触れません。`--deploy-function docSync` で先に `firebase deploy` を実行、`--dry-run` でコマンド表示のみにできます。

トリガー名は `<name>-<コレクション ID を - で連結>`（`users/{uid}/payments` → `<name>-users-payments`、`_` は `-` に置換）です。各トリガーは `google.cloud.firestore.document.v1.written` をそのコレクションのパスパターン（`document=users/{uid}/payments/{docId}`）でフィルタし、protobuf 形式で配信します。

### 5. 既存データをバックフィルする

```sh
npx doc-sync rebuild --project <project> --config functions/src/doc-sync.config.ts --dry-run      # 何が変わるかを表示するだけ
npx doc-sync rebuild --project <project> --config functions/src/doc-sync.config.ts                 # 適用
npx doc-sync rebuild --project <project> --config functions/src/doc-sync.config.ts --rule post-category --start-after post/abc   # ルール指定・途中から再開
```

`rebuild` は各ルールのターゲットをページ単位で全件たどり、ハンドラと同じ「計算して条件付き書き込み」のコードで現在のソースに揃えます。ソースが存在しないターゲットには `onSourceDelete` を適用します。進捗行に最後に処理したパスが出るので、中断しても `--start-after` で再開できます。認証は Application Default Credentials（`gcloud auth application-default login`）、`FIRESTORE_EMULATOR_HOST` があればエミュレータに接続します。

### 6. 検証する

```sh
npx doc-sync verify --project <project> --config functions/src/doc-sync.config.ts                 # 不整合を一覧表示するだけ
npx doc-sync verify --project <project> --config functions/src/doc-sync.config.ts --fix           # 見つけて直す
npx doc-sync verify --project <project> --config functions/src/doc-sync.config.ts --rule post-category --start-after post/abc
```

`verify` は `rebuild` と同じ要領で各ルールのターゲットを全件たどりますが、書き込む代わりに比較します。現在のソースから値を再計算し、`targetField` が異なるドキュメントをすべて報告するだけで、何も変更しません。`--fix` を付けると、ハンドラと同じ条件付き書き込みで不整合を直します。直っていない不整合が残っていると終了コードが非 0 になるので、CI やスケジュール実行で本番の整合性チェックとして使えます。

## Emulator Suite でのローカル開発

エミュレータには Firestore 用の Eventarc がないため、`doc-sync dev` がその穴を埋めます。実行経路は本番と同じです: Firestore エミュレータの対象コレクションを `onSnapshot` で監視し、変更を Eventarc と同じ形式（protobuf の `DocumentEventData`）に符号化して、Functions エミュレータで動いている関数に POST します。

```sh
firebase emulators:start --only firestore,functions
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx doc-sync dev --project demo-app \
  --config functions/src/doc-sync.config.ts \
  --url http://127.0.0.1:5001/demo-app/asia-northeast1/docSync
```

起動時に存在するドキュメントはキャッシュするだけでイベントにはせず、以降の変更を配信します。`FIRESTORE_EMULATOR_HOST`（または `--emulator-host`）がないと起動を拒否するので、誤って本番に向けることはできません。

## CLI

```
doc-sync validate [--config <path>] [--strict]
doc-sync setup    [--config <path>] [--project <id>] [--dry-run]
doc-sync deploy   [--config <path>] [--project <id>] [--dry-run] [--deploy-function <name>]
doc-sync rebuild  [--config <path>] [--project <id>] [--dry-run] [--rule <name>]... [--start-after <path>] [--page-size <n>]
doc-sync verify   [--config <path>] [--project <id>] [--fix] [--rule <name>]... [--start-after <path>] [--page-size <n>]
doc-sync dev      [--config <path>] [--project <id>] --url <handler url> [--emulator-host <host:port>]
```

`--config` の既定は `./doc-sync.config.ts` です。`functions/` の中から実行するなら `--config src/doc-sync.config.ts`、プロジェクトのルートからなら `--config functions/src/doc-sync.config.ts` を指定します。`--project` の既定は `$GOOGLE_CLOUD_PROJECT`、次いで gcloud のアクティブなプロジェクトです。設定ファイルは TypeScript / JavaScript、ESM / CJS のいずれでも構いません。

`--emulator-host` は `dev` だけでなく `rebuild` / `verify` にも効きます。これ（または `FIRESTORE_EMULATOR_HOST`）を指定すると、3 つとも本番ではなくエミュレータに接続します。`--start-after` は最初に処理するルールにしか効かないので、特定のルールを再開したいときは `--rule` と組み合わせて使います。

`deploy` のドリフト検出は、既存トリガーのサービス・そのリージョン・ドキュメントのパスパターン・サービスアカウントを設定と比較します。Eventarc トリガー自身の `region` は比較しません。トリガーの一覧・作成はその場所に対して行われるため、`region` 自体を変えると古いトリガーがそのまま残ります。手動で削除するか、新しい設定に切り替える前に古い設定でもう一度 `deploy` を実行してください。

`verify` では、CLI は各不整合の実際の値と期待値を標準出力に表示します（CI のログにそのまま残ります）。一方、ライブラリ側のログ行（`doc-sync verify: mismatch`）にはドキュメントのパスとフィールドしか含まれません。値には個人情報が入り得るためです。

### コストの見積もり

`doc-sync validate` はルールごとに、1 イベントが引き起こす Firestore の読み取り・書き込みを、`N`（変更されたソースにマッチするターゲットの数）と `M`（1 つのターゲットに属するソースドキュメントの数）の式として表示します。読み取りは課金対象のドキュメント読み取りを指し、集計クエリ（`count()` / `sum()`）は課金体系が異なるため別枠で数えます。ビューの `build` / `patch` 自身が行う読み取りはユーザーコードなので静的には数えられず、「(+ reads inside build)」「(+ reads inside patch)」として示されます。ハンドラはイベントごとの実際の件数を `reads` / `queries` / `aggregations` としてログに出し（後述の「ログ」）、`rebuild` / `verify` もルールごとに表示します。

2 種類の警告は、構造的にコストがかかる形を指摘します。`refField` を使うビューのソースはファンアウトします。参照先ドキュメントが 1 件変わるだけで、それを指す全ターゲットが再計算されるためです。`limit` も `patch` も指定していない多対一のソースは、近道も上限もないため、毎イベントでターゲットの全ソースドキュメントを読みます。`--strict` を付けると、いずれかの警告が出た場合に終了コードを失敗にできるので、コストの高いルールが本番に届く前に CI で止められます。

## 変更はこう処理される

`collection/docId` のイベントに対し、そのコレクションを `source` または `target` に持つ全ルール（connection・aggregate・view）が動きます。異なるルールのソース側の処理は並列に、そのイベント自身のドキュメントに対するターゲット側の処理はルールごとに順番に行われます。

**ソースとして**（`category/c1` が変わった）

1. 更新イベントで `fields` のどれも変わっていなければ終了。
2. `target where idField == docId` を `pageSize` 件ずつ検索。
3. ページごとに現在のソースを `get()`。存在すれば `{ ...fields }` を作る（ソースにないフィールドは含めない）。存在しなければ `onSourceDelete` に従い、`null` を書く / フィールドを削除する / 終了する。
4. `targetField` がその値と異なるターゲットだけ、手順 2 で観測した `updateTime` を `lastUpdateTime` にして `update()`。書き込みは `BulkWriter` 経由。

**ターゲットとして**（`post/p1` が変わった）

1. 削除イベント、または `idField` が変わっていなければ終了。
2. 現在のターゲットを `get()`。`idField` が空なら `targetField` を削除（存在する場合）。
3. それ以外は参照先ソースを `get()` して値を作る。ソースが存在しなければ、何もしないのではなく `onSourceDelete` に従う（`rebuild` がソース欠落時に行うのと同じ処理）。
4. 値に差がある場合のみ、手順 2 の `updateTime` を前提条件に書き込む。

アプリが `targetField` を直接書き換えて消した場合（例: merge なしの `set()`）、ソース側の値自体は変わっていなくても、そのドキュメントへの次のイベントで再計算されます。

**件数・合計**（`post/p1/like/u1` の作成・削除、または監視フィールドの変更）

1. 更新イベントで `idField` も合計対象フィールドも変わっていなければ終了。
2. 変更前・変更後にそのドキュメントが属していたターゲット（最大 2 つ）ごとに、ターゲットを `get()` → 集計クエリ → 値が異なれば `updateTime` を前提条件に書き込み。新規作成されたターゲットにも同じ手順で初期値を入れます。

ここでも同じ再計算規則が働きます。アプリが `targetField` を消していれば、そのターゲットへの次のイベントで再計算されます。

**ビュー。** ソース側の変更では（`watch` を指定していればそのフィールド、指定していなければドキュメント全体に変化がなければスキップ）、そのドキュメントが属する各ターゲットを読み、`patch`（定義されていれば、変更されたドキュメントを読み直して渡す。`undefined` を返せば `build` にフォールバック）または全ソースを読み直す `build` で値を計算し、差があれば条件付きで書き込みます。この読み直しのタイミングでメンバーシップも再確認されます。変更されたドキュメントがもうこのターゲットに属していなければ（たとえば別の親に移動した場合）、`patch` に渡る `change.after` は削除時と同じく `undefined` になります。ターゲット側では、作成時・`refField` が変わったとき、そしてアプリの書き込みで `targetField` が消えたときに再計算します。`rebuild` / `verify` は常に `build` を使います。

**競合。** 間に別の書き込みがあって条件付き書き込みが失敗したら、そのターゲットだけ手順 2 からやり直します（最大 `maxRetries` 回。超えたら 500 を返し Eventarc が再送）。ソースが読んだ後に変わっていたら、その変更のイベントが面倒を見ます。値は深く比較する（`Timestamp` / `GeoPoint` / `DocumentReference` / バイト列を含む）ので、自身の書き込みによるイベントは no-op になり、`area -> shop.area -> post.shop.area` のような多段連鎖も必ず停止します。

**レスポンス。** 完了・処理不要は `204`。回復不能な入力も `204` です。壊れたペイロードや未知のコレクションは `warn` / `error` ログを出して再送させません。別データベース宛てのイベントは `info` ログを出して無視します。Firestore のドキュメントイベントでない `ce-type`、16 MiB を超えるリクエストボディ、20 階層を超えてネストした値も同様に `204` で捨てます。一時的な失敗は `500` で、Eventarc が最大 24 時間バックオフ再送します。処理は冪等です。

**ログ。** 1 イベント・1 ルールにつき 1 行の構造化ログ: `eventId`、`rule`、`kind`、`source`（マッチしたビューのソースキー。ビューのみ）、`document`、`role`、`action`（`skip` / `write` / `delete`）、`reason`、`targets`、`writes`、`retries`、`reads`、`queries`、`aggregations`、`durationMs`。`durationMs` はそのルールだけでなくイベント全体にかかった時間で、同じイベントの行はすべて同じ値になります。読み取りのカウンタは Firestore の課金に合わせています。ドキュメント読み取り 1 件につき 1（存在しないドキュメントも含む）、クエリは返ってきたドキュメント 1 件につき 1（クエリ 1 回につき最低 1）、集計は別枠です。ビューの `build` / `patch` がコンテキストの `firestore` を通して行う読み取りは含まれ、別経路で取得した Firestore インスタンスによる読み取りは含まれません。Cloud Logging で `rule` ごとに `reads` を合計すると、どのルールがコストを使っているかが分かります。失敗したルールは代わりに `doc-sync: failed, will be retried by Eventarc` を `eventId`、`document`、`rule`、`error`、`durationMs` 付きでログに出します。

## 既知の制約

- ソース削除時にターゲットを削除することはできません。`setNull` か `deleteField` を使ってください。
- アプリが `targetField` を別の値で上書きした場合、ソースが次に変わる（または `rebuild` / `verify --fix` する）までその値のままです。フィールドを削除した場合は、そのドキュメントへの次のイベントで直ります。
- ターゲット検索のため `idField` に既定の単一フィールドインデックスが必要です。コレクショングループクエリが必要なルール（`validate` が一覧します）には、そのフィールドのコレクショングループスコープのインデックスが必要です。初回実行時に Firestore が作成用リンクを出します。
- `idField` に加えて別のフィールドで `orderBy` するビューのソースには複合インデックスが必要です（`validate` が一覧するのはコレクショングループのインデックスだけです。複合インデックスについては Firestore が初回実行時にリンクを出します）。
- 件数・合計は、影響を受けるターゲット 1 つにつきイベントごとに集計読み取り 1 回のコストがかかります。ビューはターゲット読み取り 1 回に加え、ソースごとに返ってきたドキュメント数分（`limit` があればその上限、なければ M 件全部）の読み取りが、影響を受けるターゲット 1 つにつきかかります。`patch` が処理できた場合は読み取り 2 回だけです。
- ユーザーコード内での恒久的な失敗（`build` / `patch` の例外）やインデックス不足は 500 を返し、Eventarc が最大 24 時間バックオフ再送します。`doc-sync: failed` のログ行を監視し、トリガーにデッドレタートピックを設定することも検討してください。
- 遅延は Eventarc の配信遅延（通常 1 秒未満〜数秒）に依存します。

予定なしの項目は [ROADMAP.ja.md](./ROADMAP.ja.md) を参照してください。

## セキュリティ

- ハンドラ自体はリクエストを認証しません。トリガー用サービスアカウントだけが呼べるように制限するのは任意ではなく必須です: `onRequest`（手順 2）に `invoker: '<トリガー SA>@<project>.iam.gserviceaccount.com'` を渡すか、素の Cloud Run デプロイなら `--no-allow-unauthenticated` とそのアカウントへの `roles/run.invoker` を使ってください。これがないと関数は誰でも呼び出せる公開状態になります。
- 偽造・再送されたリクエストが通ってしまった場合にできることは、再計算を強制してコストのかかる読み取りを発生させることだけです。攻撃者のデータを書き込ませることは決してできません。値は常に本物のソースから読み直し、ビューの `patch` もリクエストボディの内容ではなく、変更されたドキュメントのメンバーシップを確認した上での読み直しを受け取るからです。
- ハンドラ自体も、どんなリクエストでもできることを制限しています: `ce-type` は Firestore のドキュメントイベントであること、ボディは 16 MiB まで、値のネストは 20 階層までです。それ以外はルールに届く前に `204` で捨てられます。
- `doc-sync setup` がトリガー用サービスアカウントに付与するのは、プロジェクトへの `roles/eventarc.eventReceiver` と、1 つの Cloud Run サービスへの `roles/run.invoker` だけです。
- 関数自身のランタイムサービスアカウント（`onRequest` / Cloud Run が実際に実行される側で、トリガー用 SA とは別のもの）には Firestore の読み書き権限（典型的には `roles/datastore.user`）が必要で、あなたの `build` / `patch` コードを実行します。既定のコンピュートサービスアカウントではなく専用のものを使ってください。
- ファンアウトにはイベント単位の上限がありません。1 つのルールが上限のない数のターゲットに触れる可能性があります。`validate` の警告、`maxInstances`、`timeoutSeconds` が制御手段なので、1 イベントが引き起こす最悪のケースを想定して設定してください。
- `deploy` が扱うのは `region` にある `doc-sync-instance=<name>` ラベル付きのトリガーだけです。同じプロジェクト・リージョンに同じ `name` の設定を 2 つデプロイすると、同じトリガーを取り合います。
- CLI は `gcloud` と `firebase` を引数配列として実行し、POSIX ではシェルを経由しません（Windows でのみシェル用にクォートします）。設定ファイルの読み込みには `jiti` を使います。設定ファイルは他のローカルスクリプトと同じく、あなた自身のコードとしてあなた自身の権限で実行されます。
- `verify` の出力（標準出力と `onMismatch` に渡る `Mismatch` オブジェクトの両方）には実際のドキュメントのフィールド値が入ります。個人情報を含む可能性があるので、CI のログでの扱いには注意してください。

## 推奨する関数の設定

| 項目 | 値 | 根拠 |
|---|---|---|
| `cpu` | 1 | `concurrency > 1` に必要。I/O 待ち中心 |
| `memory` | 512MiB | ターゲット検索をページングするため上限は一定 |
| `concurrency` | 80 | Firestore の応答待ちが中心 |
| `minInstances` | 1 | コールドスタート回避（任意） |
| `maxInstances` | 10 | Firestore への書き込み急増の抑制 |
| `timeoutSeconds` | 300 | 大量書き込み用。Eventarc の ack 期限 600 秒より短く |
| `invoker` | トリガー SA のメールアドレス | 必須。これがないと関数が公開されてしまう |

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
