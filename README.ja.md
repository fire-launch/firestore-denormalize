# firestore-denormalize

Firestore の非正規化データを、**Cloud Run 関数 1 つ ＋ コレクションごとの Eventarc トリガー**で同期します。

[English README](./README.md)

`category/{id}` の一部フィールドを `post.category` にコピーしている場合、カテゴリが変わるたびに全 `post` を更新する必要があります。このパッケージは、そうしたルールを TypeScript の 1 ファイルで何個でも定義し、まとめて処理します。

```ts
// doc-sync.config.ts
import { defineConfig } from 'firestore-denormalize'

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
})
```

## 特徴

- `firestore-connect-document` 系 Extension の「ルール 1 つにつき関数 2 つ」を、関数 1 つに集約します。
- Eventarc の at-least-once・順序保証なしの配信でも正しく収束します。イベントの値は「処理が必要か」の判定にだけ使い、書き込む値は**常に Firestore から読み直し**、書き込みは**ターゲットの `updateTime` を前提条件にした条件付き書き込み**で行います。遅延・重複したイベントが新しい値を古い値で上書きすることはありません。
- トリガーの作成・削除は、同じ設定ファイルからコマンド 1 つで行います。

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
| `connections[]` | 同期ルール。`source` / `target` はトップレベルのコレクション、`fields` はトップレベルのフィールド名 |

バリデーションでは、名前の重複、同じ `target.targetField` への二重書き込み、コレクション間の循環、サブコレクション、`.` などパス記法を含むフィールド名を拒否します。

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

トリガー名は `<name>-<collection>`（`_` は `-` に置換）です。各トリガーは `google.cloud.firestore.document.v1.written` を `document=<collection>/{docId}` でフィルタし、protobuf 形式で配信します。

## CLI

```
doc-sync validate [--config <path>]
doc-sync setup    [--config <path>] [--project <id>] [--dry-run]
doc-sync deploy   [--config <path>] [--project <id>] [--dry-run] [--deploy-function <name>]
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

**競合。** 間に別の書き込みがあって条件付き書き込みが失敗したら、そのターゲットだけ手順 2 からやり直します（最大 `maxRetries` 回。超えたら 500 を返し Eventarc が再送）。ソースが読んだ後に変わっていたら、その変更のイベントが面倒を見ます。値は深く比較する（`Timestamp` / `GeoPoint` / `DocumentReference` / バイト列を含む）ので、自身の書き込みによるイベントは no-op になり、`area -> shop.area -> post.shop.area` のような多段連鎖も必ず停止します。

**レスポンス。** 完了・処理不要は `204`。回復不能な入力（壊れたペイロード、未知のコレクション、別データベース）も `error` / `warn` ログを出して `204`（再送させない）。一時的な失敗は `500` で、Eventarc が最大 24 時間バックオフ再送します。処理は冪等です。

**ログ。** 1 イベント・1 connection につき 1 行の構造化ログ: `connection`、`document`、`role`、`action`（`skip` / `write` / `delete`）、`reason`、`targets`、`writes`、`retries`、`durationMs`。

## 既知の制約

- 対応するのはトップレベルのコレクションとトップレベルのフィールド名のみ。
- ソース削除時にターゲットを削除することはできません。`setNull` か `deleteField` を使ってください。
- バックフィルはありません。既存ターゲットは、ソースか自身の `idField` が次に変わったときに更新されます。
- アプリが `targetField` を直接書いた場合、ソースが次に変わるまでその値のままです。
- ターゲット検索のため `idField` に既定の単一フィールドインデックスが必要です。除外設定している場合は戻してください。
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
