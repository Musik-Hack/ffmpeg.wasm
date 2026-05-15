# Portable FFmpeg Remux Assets

This directory builds a two-file browser asset pair for modern Vite projects:

- `ffmpeg-remux-api.js`: ESM API, embedded worker, and embedded FFmpeg core glue
- `ffmpeg-core.wasm`: the single-thread FFmpeg WebAssembly binary

Importing the API does not fetch the WASM. `ffmpeg-core.wasm` is requested only
when `ensureLoaded()` or a FFmpeg-backed media operation first runs.

## Build

Build the portable asset pair after building the single-thread core:

```bash
make prd
npm run build:portable
```

The output is written to `dist/portable/`:

- `ffmpeg-remux-api.js`
- `ffmpeg-core.wasm`

Copy both files into the same folder in a Vite app, for example:

```text
src/vendor/ffmpeg-remux/ffmpeg-remux-api.js
src/vendor/ffmpeg-remux/ffmpeg-core.wasm
```

Then import from application code:

```js
import {
  ensureLoaded,
  extractAudio,
  attachAudio,
  convertLosslessToFlac,
  decodeAudioForPlayback,
  onTaskEvent,
} from "./vendor/ffmpeg-remux/ffmpeg-remux-api.js";
```

## API summary

- `ensureLoaded()` explicitly initializes the worker and downloads the WASM.
- `extractAudio(file, options)` extracts the first audio stream from a media file.
- `attachAudio(audioFile, videoFile)` stream-copies audio into a video container.
- `convertLosslessToFlac(file)` converts lossless audio to FLAC.
- `decodeAudioForPlayback(file)` decodes audio to stereo 48 kHz `Float32Array` PCM.
- `onTaskEvent(callback)` subscribes to status, command, log, and notice events.
- `terminate()` stops the worker and clears pending singleton tasks.
- `createFFmpegTasks({ wasmURL })` creates an isolated client with a custom WASM URL.

See the JSDoc comments in `ffmpeg-remux-api.js` for function-level usage details.

## Production and compliance notes

For production redistribution, ship both generated files together and keep the
corresponding source tag and distribution notice available:

- Release tag: `commercial-remux-portable-2026-05-15`
- Source URL: `https://github.com/Musik-Hack/ffmpeg.wasm/tree/commercial-remux-portable-2026-05-15`
- Notice file: `DIST_LICENSES.TXT`

This build is intended to use the single-thread LGPL-oriented core described in
`COMMERCIAL_REMUX_BUILD.md`. It avoids the multi-thread core because that would
require extra worker assets and cross-origin isolation headers, which would break
the two-file deployment model.
