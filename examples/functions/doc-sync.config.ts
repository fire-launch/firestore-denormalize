import { defineConfig, defineView } from "firestore-denormalize";

export default defineConfig({
  name: "doc-sync",
  region: "asia-northeast1",
  database: "(default)",
  service: "docsync",
  serviceAccount: "doc-sync-trigger",

  connections: [
    {
      name: "post-category",
      source: "category",
      target: "post",
      idField: "categoryId",
      fields: ["name", "color"],
      targetField: "category",
      onSourceDelete: "setNull",
    },
    {
      name: "post-author",
      source: "user",
      target: "post",
      idField: "authorId",
      fields: ["displayName", "photoUrl"],
      targetField: "author",
      onSourceDelete: "deleteField",
    },
    {
      // Subcollections: every placeholder of `source` must also appear in `target`.
      name: "user-post-tag",
      source: "users/{uid}/tags",
      target: "users/{uid}/posts",
      idField: "tagId",
      fields: ["label"],
      targetField: "tag",
      onSourceDelete: "setNull",
    },
  ],

  aggregates: [
    {
      // post.likeCount = number of documents in post/{postId}/like
      name: "post-likes",
      source: "post/{postId}/like",
      target: "post",
      idParam: "postId",
      aggregate: "count",
      targetField: "likeCount",
    },
    {
      // customer.total = sum of order.amount where order.customerId == customer id
      name: "customer-total",
      source: "order",
      target: "customer",
      idField: "customerId",
      aggregate: { sum: "amount" },
      targetField: "total",
    },
  ],

  views: [
    defineView({
      // post.latestComments = the 2 newest comments of post/{postId}/comment, as [{ id, body }]
      name: "post-latest-comments",
      target: "post",
      targetField: "latestComments",
      sources: {
        comments: {
          collection: "post/{postId}/comment",
          idParam: "postId",
          orderBy: [["createdAt", "desc"]],
          limit: 2,
        },
      },
      build: ({ sources }) =>
        sources.comments.map((c) => ({ id: c.id, body: c.get("body") })),
    }),

    defineView({
      // A map keyed by document id: user.badges = { [badgeId]: { name } } over badge where badge.userId == uid.
      // `patch` handles creates and deletes from the changed document alone; updates fall back to `build`.
      name: "user-badges",
      target: "user",
      targetField: "badges",
      sources: { badges: { collection: "badge", idField: "userId", orderBy: ["name"] } },
      build: ({ sources }) =>
        Object.fromEntries(sources.badges.map((b) => [b.id, { name: b.get("name") }])),
      patch: (current, change) => {
        const id = change.path.split("/").pop()!;
        if (change.before && change.after) return undefined; // an update: let build recompute
        const next = { ...(current ?? {}) };
        // `after` is undefined when the badge was deleted or moved to another user
        if (change.after) next[id] = { name: change.after.name };
        else delete next[id];
        return next;
      },
    }),

    defineView({
      // Latest N kept by patch with at most one extra read per event (the refill after a delete).
      // thread.latest = newest 50 messages where message.threadId == thread id, as [{ id, body, createdAt }].
      // Needs a composite index on message (threadId asc, createdAt desc).
      name: "thread-latest-messages",
      target: "thread",
      targetField: "latest",
      sources: {
        messages: {
          collection: "message",
          idField: "threadId",
          orderBy: [["createdAt", "desc"]],
          limit: 50,
          watch: ["body"], // threadId and createdAt are watched implicitly
        },
      },
      build: ({ sources }) =>
        sources.messages.map((m) => ({ id: m.id, body: m.get("body"), createdAt: m.get("createdAt") })),
      patch: async (current, change, { target, firestore }) => {
        const id = change.path.split("/").pop()!;
        const rest = (current ?? []).filter((m) => m.id !== id);
        const after = change.after;
        if (after) {
          // created or edited: upsert by id, newest first, keep 50
          const item = { id, body: after.body, createdAt: after.createdAt };
          return [...rest, item].sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis()).slice(0, 50);
        }
        if (rest.length === current?.length) return current; // not in the window: nothing to do
        if (rest.length === 0) return rest;
        // deleted: pull in the next older message so the window stays full (one limit(1) read)
        const older = await firestore
          .collection("message")
          .where("threadId", "==", target.id)
          .where("createdAt", "<", rest[rest.length - 1]!.createdAt)
          .orderBy("createdAt", "desc")
          .limit(1)
          .get();
        for (const m of older.docs) rest.push({ id: m.id, body: m.get("body"), createdAt: m.get("createdAt") });
        return rest;
      },
    }),

    defineView({
      // Several numbers at once from a subcollection, where aggregates (one number each) would need three rules:
      // order.summary = { itemCount, total, skus } over order/{orderId}/item.
      name: "order-summary",
      target: "order",
      targetField: "summary",
      sources: { items: { collection: "order/{orderId}/item", idParam: "orderId" } },
      build: ({ sources }) => ({
        itemCount: sources.items.length,
        total: sources.items.reduce((n, i) => n + (i.get("price") as number) * (i.get("qty") as number), 0),
        skus: sources.items.map((i) => i.get("sku") as string).sort(),
      }),
    }),

    defineView({
      // One-to-one sources via refField: post.summary = "<author name> / <category name>".
      // Fans out: a change of a user or category rebuilds every post pointing at it, so `watch` keeps that to name changes.
      name: "post-summary",
      target: "post",
      targetField: "summary",
      sources: {
        author: { collection: "user", refField: "authorId", watch: ["displayName"] },
        category: { collection: "category", refField: "categoryId", watch: ["name"] },
      },
      build: ({ sources }) => {
        const [author] = sources.author;
        const [category] = sources.category;
        if (!author && !category) return undefined; // deletes post.summary
        return `${author?.get("displayName") ?? "?"} / ${category?.get("name") ?? "?"}`;
      },
    }),
  ],
});
