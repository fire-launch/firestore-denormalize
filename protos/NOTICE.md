The `.proto` files in this directory are copied unmodified from

- https://github.com/googleapis/google-cloudevents (`google/events/cloud/firestore/v1/data.proto`)
- https://github.com/protocolbuffers/protobuf (`google/protobuf/struct.proto`, `timestamp.proto`)
- https://github.com/googleapis/googleapis (`google/type/latlng.proto`)

and are licensed under the Apache License 2.0 by their respective authors.
`src/proto/firestore-events.json` is generated from them with `npm run protos:build`.
