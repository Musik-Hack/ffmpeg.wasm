# syntax=docker/dockerfile-upstream:master-labs

# Base emsdk image with environment variables.
FROM emscripten/emsdk:3.1.40 AS emsdk-base
ARG EXTRA_CFLAGS
ARG EXTRA_LDFLAGS
ARG FFMPEG_ST
ARG FFMPEG_MT
ENV INSTALL_DIR=/opt
# We cannot upgrade to n6.0 as ffmpeg bin only supports multithread at the moment.
ENV FFMPEG_VERSION=n5.1.4
ENV CFLAGS="-I$INSTALL_DIR/include $CFLAGS $EXTRA_CFLAGS"
ENV CXXFLAGS="$CFLAGS"
ENV LDFLAGS="-L$INSTALL_DIR/lib $LDFLAGS $CFLAGS $EXTRA_LDFLAGS"
ENV EM_PKG_CONFIG_PATH=$EM_PKG_CONFIG_PATH:$INSTALL_DIR/lib/pkgconfig:/emsdk/upstream/emscripten/system/lib/pkgconfig
ENV EM_TOOLCHAIN_FILE=$EMSDK/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake
ENV PKG_CONFIG_PATH=$PKG_CONFIG_PATH:$EM_PKG_CONFIG_PATH
ENV FFMPEG_ST=$FFMPEG_ST
ENV FFMPEG_MT=$FFMPEG_MT
RUN apt-get update && \
      apt-get install -y pkg-config autoconf automake libtool ragel

# Build lame
FROM emsdk-base AS lame-builder
ENV LAME_BRANCH=master
ADD https://github.com/ffmpegwasm/lame.git#$LAME_BRANCH /src
COPY build/lame.sh /src/build.sh
RUN bash -x /src/build.sh

# Build zlib
FROM emsdk-base AS zlib-builder
ENV ZLIB_BRANCH=v1.2.11
ADD https://github.com/ffmpegwasm/zlib.git#$ZLIB_BRANCH /src
COPY build/zlib.sh /src/build.sh
RUN bash -x /src/build.sh

# Base ffmpeg image with dependencies and source code populated.
FROM emsdk-base AS ffmpeg-base
ADD https://github.com/FFmpeg/FFmpeg.git#$FFMPEG_VERSION /src
COPY --from=zlib-builder $INSTALL_DIR $INSTALL_DIR

# Build ffmpeg
FROM ffmpeg-base AS ffmpeg-builder
COPY build/ffmpeg.sh /src/build.sh
COPY --from=lame-builder $INSTALL_DIR $INSTALL_DIR
# Remux-only LGPL-oriented profile: copy encoded streams between containers
# without GPL/nonfree codecs or video transcoding support. Keep a tiny native
# audio decode/encode path so extracted audio can be normalized to browser-
# playable WAV and previewed through Web Audio.
RUN bash -x /src/build.sh \
      --enable-zlib \
      --enable-libmp3lame \
      --disable-postproc \
      --disable-encoders \
      --disable-decoders \
      --enable-encoder=pcm_s16le \
      --enable-encoder=pcm_s24le \
      --enable-encoder=pcm_s32le \
      --enable-encoder=pcm_f32le \
      --enable-encoder=pcm_s16be \
      --enable-encoder=pcm_s24be \
      --enable-encoder=pcm_s32be \
      --enable-encoder=pcm_f32be \
      --enable-encoder=flac \
      --enable-encoder=libmp3lame \
      --enable-decoder=pcm_s16le \
      --enable-decoder=pcm_s24le \
      --enable-decoder=pcm_s32le \
      --enable-decoder=pcm_f32le \
      --enable-decoder=pcm_s16be \
      --enable-decoder=pcm_s24be \
      --enable-decoder=pcm_s32be \
      --enable-decoder=pcm_f32be \
      --enable-decoder=flac \
      --enable-decoder=aac \
      --enable-decoder=aac_fixed \
      --enable-decoder=alac \
      --enable-decoder=ac3 \
      --enable-decoder=eac3 \
      --enable-decoder=mp3 \
      --enable-decoder=mp3float \
      --enable-decoder=opus \
      --enable-decoder=vorbis \
      --disable-filters \
      --enable-filter=aformat \
      --enable-filter=anull \
      --enable-filter=aresample \
      --disable-indevs \
      --disable-outdevs \
      --disable-hwaccels

# Build ffmpeg.wasm
FROM ffmpeg-builder AS ffmpeg-wasm-builder
COPY src/bind /src/src/bind
COPY src/fftools /src/src/fftools
COPY build/ffmpeg-wasm.sh build.sh
# libraries to link
ENV FFMPEG_LIBS \
      -lmp3lame \
      -lz
RUN mkdir -p /src/dist/umd && bash -x /src/build.sh \
      ${FFMPEG_LIBS} \
      -o dist/umd/ffmpeg-core.js
RUN mkdir -p /src/dist/esm && bash -x /src/build.sh \
      ${FFMPEG_LIBS} \
      -sEXPORT_ES6 \
      -o dist/esm/ffmpeg-core.js

# Export ffmpeg-core.wasm to dist/, use `docker buildx build -o . .` to get assets
FROM scratch AS exportor
COPY --from=ffmpeg-wasm-builder /src/dist /dist
