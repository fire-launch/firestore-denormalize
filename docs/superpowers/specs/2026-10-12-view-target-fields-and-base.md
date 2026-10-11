# View: `targetFields`, `base`, `defineProjection` — 設計仕様

対象バージョン: 0.8.0（公開前なので破壊的変更を許容する）

## 背景

読み取りモデル（例: `user` から機微なフィールドを除いた `userPublicView`）を別コレクションに組み立てる用途に view を使いたい。現状の view は

- ターゲットの 1 フィールド（`targetField`）しか書けない。ルート直下に複数フィールドを置けない。
- ターゲットのドキュメントを作成・削除しない。ターゲットが無ければ skip する。

利用者視点の位置づけは「view が一般形、connection / aggregate / projection はよくある形の簡易設定」とする。内部実装は共有しなくてよいが、projection は view に変換して実装する。

## 1. `targetFields`（view）

`ViewRule.targetField: string` を廃止し、`targetFields: string[]` を必須にする。

- 要素は Firestore のフィールドパス（`title`、`stats.followerCount`、`profile`）または文字列 `'rest'`。
- `build` はネストしたオブジェクトを返す。ライブラリは宣言したパスの値だけを取り出して書く。
  - 宣言パスの値が `undefined`（または親が無い）→ `FieldValue.delete()`。
  - 宣言外のパスに値がある → 1 回だけ `logger.warn`（ルール名・パス）して無視する。typed config の型でコンパイル時に弾くのが主で、実行時は警告にとどめる。
  - `build` が `undefined` を返す → 全宣言パスを削除。
- 書き込みは変化したパスだけを 1 回の `update` にまとめ、従来どおり `lastUpdateTime` を条件にする。`set` は使わない。
- 同じ view 内でパスが重なる宣言（`profile` と `profile.bio`）は validate で拒否。他ルールとの重なりは既存の `writtenFields` の判定を複数パスに広げる。
- `patch` は `current` として「宣言パスごとの現在値を持つオブジェクト」を受け取り、同じ形のオブジェクトを返す。`undefined` を返した場合は従来どおり `build` にフォールバックする（全削除は build が `undefined` を返したとき）。
- `verify` は宣言パスごとに比較し、mismatch の理由にパスを含める。`rebuild` は同じ比較で修復する。
- `validate` のコスト見積もりは書き込み 1 回のまま。

### `'rest'`

- `base` を持つ view でのみ許可（validate）。
- 意味: ターゲットのルート直下のキーのうち、**どのルールもどの深さでも宣言していない**もの全部。この view 自身の明示パス（`stats.followerCount` なら `stats`）も除く。
- 書き: build の戻り値のルート直下で、明示宣言されておらず他ルールにも属さないキーをそのまま書く（値全体の置き換え）。
- 消し: ターゲットにあって build の戻り値に無く、他ルールにも属さないルートキーを `delete()`。
- `verify` も同じ規則で判定する。
- 「他ルールが宣言しているか」は resolve 時に target パターンごとに計算して `ResolvedView` に持たせる（実行時にメタデータは読まない）。

## 2. `base`（view）

`ViewRule.base?: string`（コレクションのパスパターン。`target` と同じプレースホルダ集合を持つこと）。

- 関係: `base/{id}` と `target/{id}` は同じ ID。プレースホルダは同名で対応する（`shop/{shopId}/user` → `shop/{shopId}/userPublicView`）。
- 存在の規則: **読み直した時点で base が存在すればターゲットも存在させ、無ければターゲットを削除する。** イベントの種類（create / update / delete）は見ない。
- base のイベント、sources のイベント、target 側の作成・削除イベントで同じ規則を適用する（target 側の単なる更新イベントは従来どおり refField 変更と宣言パスの消失だけを見る）。
  - base あり・ターゲット無し → `create()` で宣言フィールドを書く。`ALREADY_EXISTS` なら読み直して通常の更新に切り替える。
  - base 無し・ターゲットあり → 読んだ時点の `lastUpdateTime` を条件に `delete()`。
  - base 無し・ターゲット無し → skip。
- `build` / `patch` の context に `base: DocumentSnapshot` を渡す（呼ばれる時点で必ず存在する）。base の変更は再計算のトリガーになる（`watch` 相当は `base` 全フィールド）。
- base のイベントは「同じ ID のターゲット 1 件」に対応する。クエリは不要。
- 同じ target コレクションに対して複数の view が `base` を宣言してよい。validate は全宣言が同じ base パターンであることを確認する。aggregate / connection は base を持たず、ターゲットが無ければ従来どおり skip（作成イベントで追いつく）。
- `rebuild`: base を持つ view は base コレクションを歩いて不足分を作り、target コレクションを歩いて base を失った孤児を削除する。
- `verify`: 上と同じ両方向で `missing` / `orphan` を報告する。
- CLI の trigger 計画に base コレクションを含める。
- コスト見積もり: base イベントで target 読み 1 + base 読み 1 + sources 読み + 書き 1。
- Firestore の仕様でターゲット削除時にサブコレクションは残る。ドキュメントに明記する。
- `RuleResult.action`（および内部の `Outcome`）に `create`（ターゲット作成）と `remove`（ターゲット削除）を追加する。`delete` は従来どおりフィールド削除。
- `verify` の `Mismatch` は `issue: 'value' | 'missing' | 'orphan'` を持ち、`field` は `value` のときだけ入る。

## 3. `defineProjection`

```ts
defineProjection({
  name: 'user-public',
  base: 'user',
  target: 'userPublicView',
  targetFields: ['displayName', 'bio', 'avatarUrl'],
})
```

- `kind: 'projection'`。`build` も `sources` も持たない。
- resolve 時に `ResolvedView` に変換する: `base` あり、`sources` 空、`build = ({ base }) => 宣言パスを base から同じパスで取り出したオブジェクト`。
- `'rest'`、リネーム（`rename`）、`exclude` はこの版では対応しない（validate で拒否）。
- 同じ target に `'rest'` を宣言できる view は 1 つまで（validate）。sources のキー `base` は予約語（`RuleResult.source` と衝突するため）。
- handler / rebuild / verify に projection 専用コードを持たない。`ResolvedView.kind` は `'view'` のまま `projection: true` を立て、handler のログ（`RuleResult.kind`）だけ `'projection'` を出す。

## 4. 変更しないもの

- connection と aggregate の API（`targetField` 単数のまま）。
- view の sources に `aggregate: 'count' | { sum }` を置く拡張（別計画）。
- `_sync` 系メタデータは導入しない。

## 5. ドキュメント

- README（両言語）: 「できること」に projection を追加し、view を一般形として位置づける。「ターゲットは作らない」原則と、`base` 付き view だけがその例外であることを明記。
- `docs/reference*.md`: `targetFields`、`'rest'`、`base`、projection、発火表の更新、サブコレクションが残る注記。
- CHANGELOG 0.8.0。
- examples の view を `targetFields` に更新し、projection の例を追加。
