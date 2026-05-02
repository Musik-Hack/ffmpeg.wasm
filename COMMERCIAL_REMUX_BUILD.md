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
- builds and links `libmp3lame` for deliberately scoped MP3 audio output
- disables most FFmpeg encoders, decoders, filters, input devices, output devices, hardware accelerators, and `postproc`
- enables only minimal audio format/resample filters required by the selected audio encoders
- enables native decoders for common movie audio tracks plus native PCM/FLAC encoders/decoders and `libmp3lame` encode, so extracted audio can keep browser-compatible MP3/AAC-family streams or normalize other sources to lossless FLAC
- keeps FFmpeg's native muxers, demuxers, parsers, bitstream filters, protocols, and `zlib`

The goal is broad container support for remuxing common movie/audio files while keeping the generated core aligned with LGPL-style FFmpeg redistribution.

## Practical limits

This build is primarily for stream copy. It can extract existing audio tracks and attach compatible audio tracks to movie containers. It keeps browser-compatible MP3/AAC-family streams without conversion and can decode common movie audio tracks to normalize other sources to FLAC.

If the input audio codec is not accepted by the target container and is not native PCM/FLAC/MP3, choose a different output container or add a deliberately scoped LGPL-compatible audio transcode path.
