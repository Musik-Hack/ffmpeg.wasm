const FFMPEG_CORE_SOURCE = __FFMPEG_CORE_SOURCE__;

const DEFAULT_INPUT_NAME = "input";
const ALLOWED_AUDIO_EXTENSIONS = ["wav", "aiff", "m4a", "mp3", "flac"];
const DURATION_EPSILON_SECONDS = 0.05;

let corePromise;
let core;
let activeTaskId = null;
let logBuffer = [];
let suppressLogs = false;

const send = (type, payload = {}) => {
  self.postMessage({ id: activeTaskId, type, ...payload });
};

const extensionOf = (name = "") => {
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index + 1).toLowerCase();
};

const basenameOf = (name = DEFAULT_INPUT_NAME) => {
  const index = name.lastIndexOf(".");
  return index === -1 ? name : name.slice(0, index);
};

const filenameFor = (prefix, file) => {
  const name = file?.name || DEFAULT_INPUT_NAME;
  const ext = extensionOf(name);
  return `${prefix}${ext ? `.${ext}` : ".bin"}`;
};

const unique = (items) => [...new Set(items)];

const audioContainersForCodec = (codec) => {
  const normalized = codec.toLowerCase();
  if (normalized === "aac" || normalized === "alac") return ["m4a"];
  if (normalized === "mp3") return ["mp3", "m4a"];
  if (normalized === "flac") return ["flac"];
  if (normalized.startsWith("pcm_")) return ["wav", "aiff"];
  return ALLOWED_AUDIO_EXTENSIONS;
};

const isBrowserCompatibleCompressedCodec = (codec) => {
  const normalized = codec.toLowerCase();
  return normalized === "mp3" || normalized === "aac" || normalized === "alac";
};

const resolveWasmURL = (wasmURL) => {
  if (wasmURL) return wasmURL;
  throw new Error("Missing ffmpeg-core.wasm URL");
};

const importEmbeddedCore = () => {
  if (self.createFFmpegCore) return null;
  const url = URL.createObjectURL(
    new Blob([FFMPEG_CORE_SOURCE], { type: "text/javascript" })
  );
  importScripts(url);
  return url;
};

const loadCore = async ({ wasmURL } = {}) => {
  if (core) return core;
  if (!corePromise) {
    corePromise = (async () => {
      send("status", { message: "Loading ffmpeg-core" });
      const resolvedWasmURL = resolveWasmURL(wasmURL);
      const coreURL = importEmbeddedCore() || self.location.href;

      const instance = await self.createFFmpegCore({
        mainScriptUrlOrBlob: `${coreURL}#${btoa(
          JSON.stringify({ wasmURL: resolvedWasmURL, workerURL: "" })
        )}`,
      });
      instance.setLogger(({ type, message }) => {
        if (message === "Aborted()") return;
        logBuffer.push(message);
        if (!suppressLogs) send("log", { stream: type, message });
      });
      return instance;
    })();
  }
  core = await corePromise;
  return core;
};

const writeFile = async (name, file) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  core.FS.writeFile(name, bytes);
};

const readOutput = (name, mimeType) => {
  const data = core.FS.readFile(name);
  return new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)], {
    type: mimeType || "application/octet-stream",
  });
};

const cleanup = (names) => {
  for (const name of names) {
    try {
      core.FS.unlink(name);
    } catch (_) {
      // Ignore missing files; failed commands may not create every output.
    }
  }
};

const run = async (args, options = {}) => {
  send("command", { args });
  logBuffer = [];
  suppressLogs = Boolean(options.silent);
  let ret;
  try {
    ret = core.exec(...args);
  } finally {
    suppressLogs = false;
    core.reset();
  }
  if (ret !== 0 && !options.allowFailure) throw new Error(`ffmpeg exited with code ${ret}`);
  return ret;
};

const detectAudioCodecFromLogs = () => {
  const streamLine = logBuffer.find((line) => /Stream #0:\d+.*Audio:/.test(line));
  const match = streamLine && streamLine.match(/Audio:\s*([^,\s]+)/);
  return match ? match[1].trim() : "";
};

const durationFromLogs = () => {
  const line = logBuffer.find((entry) => entry.includes("Duration:"));
  const match = line && line.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (![hours, minutes, seconds].every(Number.isFinite)) return null;
  return hours * 3600 + minutes * 60 + seconds;
};

const readDuration = async (inputName) => {
  await run(["-i", inputName], { allowFailure: true, silent: true });
  return durationFromLogs();
};

const extractAsFlac = async (inputName) => {
  const outputName = "audio.flac";
  cleanup([outputName]);
  send("notice", { message: "Encoding lossless FLAC for uncompressed audio" });
  await run([
    "-i",
    inputName,
    "-map",
    "0:a:0",
    "-vn",
    "-c:a",
    "flac",
    outputName,
  ]);
  return outputName;
};

const extractCompatibleStreamCopy = async (inputName, codec) => {
  const normalized = codec.toLowerCase();
  const outputName = normalized === "mp3" ? "audio.mp3" : "audio.m4a";
  cleanup([outputName]);
  send("notice", { message: `Keeping ${codec || "compatible"} audio with stream copy` });
  await run(["-i", inputName, "-map", "0:a:0", "-vn", "-c:a", "copy", outputName]);
  return outputName;
};

const extractWithFallback = async (inputName, codec, preferredExt) => {
  const candidates =
    preferredExt === "auto"
      ? audioContainersForCodec(codec)
      : unique([preferredExt, ...audioContainersForCodec(codec)]);
  const allowedCandidates = candidates.filter((ext) => ALLOWED_AUDIO_EXTENSIONS.includes(ext));
  const failures = [];

  for (const ext of allowedCandidates) {
    const outputName = `audio.${ext}`;
    cleanup([outputName]);
    send("notice", { message: `Trying .${ext} with stream copy` });
    try {
      await run(["-i", inputName, "-map", "0:a:0", "-c", "copy", outputName]);
      return outputName;
    } catch (error) {
      cleanup([outputName]);
      failures.push(`.${ext}`);
      send("notice", { message: `${error.message}; .${ext} did not accept ${codec || "this codec"}` });
      if (ext === "wav") {
        send("notice", { message: "Trying browser-playable PCM WAV fallback" });
        try {
          await run(["-i", inputName, "-map", "0:a:0", "-vn", "-c:a", "pcm_s16le", outputName]);
          return outputName;
        } catch (conversionError) {
          cleanup([outputName]);
          send("notice", {
            message: `${conversionError.message}; PCM WAV fallback failed`,
          });
        }
      }
    }
  }

  throw new Error(
    `Could not copy ${codec || "the audio stream"} into ${failures.join(", ")}. This file needs audio decoding/encoding.`
  );
};

const extractAudio = async ({ movieFile, audioExt = "auto", wasmURL }) => {
  await loadCore({ wasmURL });
  const inputName = filenameFor("movie", movieFile);
  let outputName = null;

  try {
    cleanup([inputName]);
    await writeFile(inputName, movieFile);
    await run(["-i", inputName], { allowFailure: true, silent: true });
    const codec = detectAudioCodecFromLogs();
    send("notice", { message: `Detected audio codec: ${codec || "unknown"}` });
    if (audioExt === "auto") {
      try {
        if (isBrowserCompatibleCompressedCodec(codec)) {
          outputName = await extractCompatibleStreamCopy(inputName, codec);
        } else {
          outputName = await extractAsFlac(inputName);
        }
      } catch (error) {
        send("notice", { message: `${error.message}; encode failed, falling back to stream copy` });
        outputName = await extractWithFallback(inputName, codec, audioExt);
      }
    } else {
      outputName = await extractWithFallback(inputName, codec, audioExt);
    }
    const blob = readOutput(outputName);
    send("done", { mode: "extract", name: outputName, blob });
  } finally {
    cleanup([inputName, outputName].filter(Boolean));
  }
};

const decodeAudioPreview = async ({ audioFile, wasmURL }) => {
  await loadCore({ wasmURL });
  const inputName = filenameFor("audio", audioFile);
  const outputName = "audio-preview.f32";

  try {
    cleanup([inputName, outputName]);
    await writeFile(inputName, audioFile);
    await run([
      "-i",
      inputName,
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      "2",
      "-ar",
      "48000",
      "-c:a",
      "pcm_f32le",
      "-f",
      "f32le",
      outputName,
    ]);
    const blob = readOutput(outputName, "application/octet-stream");
    send("done", {
      mode: "decode-audio-preview",
      name: outputName,
      blob,
      sampleRate: 48000,
      channels: 2,
    });
  } finally {
    cleanup([inputName, outputName]);
  }
};

const attachAudio = async ({ movieFile, audioFile, containerExt, wasmURL }) => {
  await loadCore({ wasmURL });
  const movieName = filenameFor("movie", movieFile);
  const audioName = filenameFor("audio", audioFile);
  const baseName = basenameOf(movieFile?.name || "movie") || "movie";
  const outputName = `${baseName}-with-audio.${containerExt}`;

  try {
    cleanup([movieName, audioName, outputName]);
    await writeFile(movieName, movieFile);
    await writeFile(audioName, audioFile);

    const movieDuration = await readDuration(movieName);
    const audioDuration = await readDuration(audioName);
    if (movieDuration === null || audioDuration === null) {
      throw new Error("Could not read media durations from ffmpeg logs");
    }
    if (audioDuration > movieDuration + DURATION_EPSILON_SECONDS) {
      throw new Error("Audio is longer than the video");
    }

    await run([
      "-i",
      movieName,
      "-i",
      audioName,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-map",
      "0:s?",
      "-map_metadata",
      "0",
      "-c",
      "copy",
      outputName,
    ]);
    const blob = readOutput(outputName);
    send("done", { mode: "attach", name: outputName, blob });
  } finally {
    cleanup([movieName, audioName, outputName]);
  }
};

const convertLosslessToFlac = async ({ audioFile, wasmURL }) => {
  await loadCore({ wasmURL });
  const inputName = filenameFor("lossless", audioFile);
  const baseName = basenameOf(audioFile?.name || "audio") || "audio";
  const outputName = `${baseName}.flac`;
  const sourceExt = extensionOf(audioFile?.name || "");

  try {
    cleanup([inputName, outputName]);
    await writeFile(inputName, audioFile);

    if (sourceExt === "flac") {
      try {
        send("notice", { message: "Input is FLAC; trying stream copy" });
        await run(["-i", inputName, "-map", "0:a:0", "-vn", "-c:a", "copy", "-f", "flac", outputName]);
        const blob = readOutput(outputName, "audio/flac");
        send("done", { mode: "convert-lossless-to-flac", name: outputName, blob });
        return;
      } catch (error) {
        cleanup([outputName]);
        send("notice", { message: `${error.message}; stream copy failed, encoding FLAC` });
      }
    }

    await run(["-i", inputName, "-map", "0:a:0", "-vn", "-c:a", "flac", outputName]);
    const blob = readOutput(outputName, "audio/flac");
    send("done", { mode: "convert-lossless-to-flac", name: outputName, blob });
  } finally {
    cleanup([inputName, outputName]);
  }
};

self.onmessage = async ({ data }) => {
  activeTaskId = data.id;
  try {
    if (data.mode === "load") {
      await loadCore(data);
      send("done", { mode: "load", loaded: true });
    } else {
      send("status", { message: "Working" });
      if (data.mode === "extract") await extractAudio(data);
      else if (data.mode === "decode-audio-preview") await decodeAudioPreview(data);
      else if (data.mode === "attach") await attachAudio(data);
      else if (data.mode === "convert-lossless-to-flac") await convertLosslessToFlac(data);
      else throw new Error(`Unknown task mode: ${data.mode}`);
      send("status", { message: "Ready" });
    }
  } catch (error) {
    send("error", { message: error instanceof Error ? error.message : String(error) });
  } finally {
    activeTaskId = null;
  }
};
