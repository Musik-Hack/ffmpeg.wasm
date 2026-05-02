# Remux Demo

This static demo uses the locally built single-thread artifacts in `packages/core/dist/umd`.

Start a local server from the repository root:

```bash
node demo/server.mjs
```

Open:

```text
http://localhost:8080/demo/
```

The demo runs FFmpeg in a Web Worker and uses stream copy only. It can extract an existing audio track or attach/replace an audio track when the chosen output container accepts the existing encoded streams.
