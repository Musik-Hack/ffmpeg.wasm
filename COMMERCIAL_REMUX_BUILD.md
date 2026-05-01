# Commercial Remux Core Build

This fork is configured for browser-side audio extraction and audio attachment by remuxing streams instead of transcoding video.

## Intended operations

Use stream copy whenever possible:

```bash
ffmpeg -i input.mp4 -map 0:a:0 -c copy output.m4a
ffmpeg -i input.mp4 -i audio.m4a -map 0:v:0 -map 1:a:0 -c copy -shortest output.mp4
```

This preserves encoded packets and avoids H.264/H.265 encoding or decoding.

## Build profile

The Docker build intentionally avoids GPL and nonfree FFmpeg configuration:

- does not pass `--enable-gpl`
- does not pass `--enable-nonfree`
- does not build or link `libx264` or `libx265`
- disables FFmpeg encoders, decoders, filters, input devices, output devices, hardware accelerators, and `postproc`
- keeps FFmpeg's native muxers, demuxers, parsers, bitstream filters, protocols, and `zlib`

The goal is broad container support for remuxing common movie/audio files while keeping the generated core aligned with LGPL-style FFmpeg redistribution.

## Practical limits

This build is for stream copy. It can extract existing audio tracks and attach compatible audio tracks to movie containers, but it will not convert audio or video codecs.

If the input audio codec is not accepted by the target container, choose a different output container or add a deliberately scoped LGPL-compatible audio transcode path.
