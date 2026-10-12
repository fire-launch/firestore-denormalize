import { defineAggregate, defineConfig, defineConnection, defineProjection, defineView } from "firestore-denormalize";

/** order.summary shape, computed the same way by build and patch. */
function summarize(items: Record<string, { sku: string; amount: number }>) {
  return { items, total: Object.values(items).reduce((n, i) => n + i.amount, 0) };
}

export default defineConfig({
  name: "doc-sync",
  region: "asia-northeast1",
  database: "(default)",
  service: "docsync",
  serviceAccount: "doc-sync-trigger",

  rules: [
    defineConnection({
      name: "post-category",
      source: "category",
      target: "post",
      idField: "categoryId",
      fields: ["name", "color"],
      targetField: "category",
      onSourceDelete: "setNull",
    }),
    defineConnection({
      name: "post-author",
      source: "user",
      target: "post",
      idField: "authorId",
      fields: ["displayName", "photoUrl"],
      targetField: "author",
      onSourceDelete: "deleteField",
    }),
    defineConnection({
      // Subcollections: every placeholder of `source` must also appear in `target`.
      name: "user-post-tag",
      source: "users/{uid}/tags",
      target: "users/{uid}/posts",
      idField: "tagId",
      fields: ["label"],
      targetField: "tag",
      onSourceDelete: "setNull",
    }),

    defineAggregate({
      // post.likeCount = number of documents in post/{postId}/like
      name: "post-likes",
      source: "post/{postId}/like",
      target: "post",
      idParam: "postId",
      aggregate: "count",
      targetField: "likeCount",
    }),
    defineAggregate({
      // customer.total = sum of order.amount where order.customerId == customer id
      name: "customer-total",
      source: "order",
      target: "customer",
      idField: "customerId",
      aggregate: { sum: "amount" },
      targetField: "total",
    }),
    defineAggregate({
      // post.likeCountNightly = number of documents in post/{postId}/like, recomputed nightly instead of on every like
      name: "post-likes-nightly",
      source: "post/{postId}/like",
      target: "post",
      idParam: "postId",
      aggregate: "count",
      targetField: "likeCountNightly",
      schedule: "0 3 * * *",
      timeZone: "Asia/Tokyo",
    }),

    defineView({
      // post.latestComments = the 2 newest comments of post/{postId}/comment, as [{ id, body }]
      name: "post-latest-comments",
      target: "post",
      targetFields: ["latestComments"],
      sources: {
        comments: {
          collection: "post/{postId}/comment",
          idParam: "postId",
          orderBy: [["createdAt", "desc"]],
          limit: 2,
        },
      },
      build: ({ sources }) => ({
        latestComments: sources.comments.map((c) => ({ id: c.id, body: c.get("body") })),
      }),
    }),

    defineView({
      // A map keyed by document id: user.badges = { [badgeId]: { name } } over badge where badge.userId == uid.
      // `patch` handles creates and deletes from the changed document alone; updates fall back to `build`.
      // Without `patch` (or a `limit`), validate warns: every badge change would read all badges of the user.
      name: "user-badges",
      target: "user",
      targetFields: ["badges"],
      sources: { badges: { collection: "badge", idField: "userId", orderBy: ["name"] } },
      build: ({ sources }) => ({
        badges: Object.fromEntries(sources.badges.map((b) => [b.id, { name: b.get("name") }])),
      }),
      patch: (current, change) => {
        const id = change.path.split("/").pop()!;
        if (change.before && change.after) return undefined; // an update: let build recompute
        const next: Record<string, { name: unknown }> = { ...((current.badges as Record<string, { name: unknown }> | undefined) ?? {}) };
        // `after` is undefined when the badge was deleted or moved to another user
        if (change.after) next[id] = { name: change.after.name };
        else delete next[id];
        return { badges: next };
      },
    }),

    defineView({
      // Latest N kept by patch with at most one extra read per event (the refill after a delete).
      // thread.latest = newest 50 messages where message.threadId == thread id, as [{ id, body, createdAt }].
      // Needs a composite index on message (threadId asc, createdAt desc). `limit` alone would already satisfy
      // validate; `patch` additionally keeps the per-event cost at two reads instead of 50.
      name: "thread-latest-messages",
      target: "thread",
      targetFields: ["latest"],
      sources: {
        messages: {
          collection: "message",
          idField: "threadId",
          orderBy: [["createdAt", "desc"]],
          limit: 50,
          watch: ["body"], // threadId and createdAt are watched implicitly
        },
      },
      build: ({ sources }) => ({
        latest: sources.messages.map((m) => ({ id: m.id, body: m.get("body"), createdAt: m.get("createdAt") })),
      }),
      patch: async (current, change, { target, firestore }) => {
        const id = change.path.split("/").pop()!;
        const list = (current.latest as { id: string; body: unknown; createdAt: any }[] | undefined) ?? [];
        const rest = list.filter((m) => m.id !== id);
        const after = change.after;
        if (after) {
          // created or edited: upsert by id, newest first, keep 50
          const item = { id, body: after.body, createdAt: after.createdAt };
          return { latest: [...rest, item].sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis()).slice(0, 50) };
        }
        if (rest.length === list.length) return { latest: list }; // not in the window: nothing to do
        if (rest.length === 0) return { latest: rest };
        // deleted: pull in the next older message so the window stays full (one limit(1) read)
        const older = await firestore
          .collection("message")
          .where("threadId", "==", target.id)
          .where("createdAt", "<", rest[rest.length - 1]!.createdAt)
          .orderBy("createdAt", "desc")
          .limit(1)
          .get();
        for (const m of older.docs) rest.push({ id: m.id, body: m.get("body"), createdAt: m.get("createdAt") });
        return { latest: rest };
      },
    }),

    defineView({
      // Several values at once from a subcollection, where aggregates (one number each) would need several rules:
      // order.summary = { items: { [itemId]: { sku, amount } }, total } over order/{orderId}/item.
      // Without `patch` (or a `limit`), validate warns: every item change would read all items of the order.
      name: "order-summary",
      target: "order",
      targetFields: ["summary"],
      sources: { items: { collection: "order/{orderId}/item", idParam: "orderId" } },
      build: ({ sources }) => ({
        summary: summarize(Object.fromEntries(sources.items.map((i) => [i.id, { sku: i.get("sku") as string, amount: i.get("price") * i.get("qty") }]))),
      }),
      patch: (current, change) => {
        // keyed by item id, so a duplicate or late event converges on the same value
        const id = change.path.split("/").pop()!;
        const summary = current.summary as { items: Record<string, { sku: string; amount: number }> } | undefined;
        const items = { ...(summary?.items ?? {}) };
        if (change.after) items[id] = { sku: change.after.sku, amount: change.after.price * change.after.qty };
        else delete items[id];
        return { summary: summarize(items) };
      },
    }),

    // A view with a `refField` source (e.g. post.summary = "<author name> / <category name>" from user and
    // category) always makes validate warn about fan-out: one change of the referenced document rebuilds every
    // post that points at it. Prefer a connection for one-to-one copies; use refField only when the referenced
    // document changes rarely and the number of targets is small.

    defineProjection({
      // userPublicView/{uid} = user/{uid} without the private fields; created and deleted with it
      name: "user-public",
      base: "user",
      target: "userPublicView",
      targetFields: ["displayName", "avatarUrl"],
    }),

    defineView({
      // userPublicView.stats.postCount next to the projected fields: another rule may own other paths of the same document
      name: "user-public-posts",
      target: "userPublicView",
      base: "user",
      targetFields: ["stats.postCount"],
      sources: { posts: { collection: "post", idField: "authorId", watch: ["authorId"] } },
      build: ({ sources }) => ({ stats: { postCount: sources.posts.length } }),
    }),
  ],
});
