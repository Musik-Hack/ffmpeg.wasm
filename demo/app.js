import {
  attachAudio,
  decodeAudioForPlayback,
  extractAudio,
  hashVideo,
  loadFilePathFromHash,
  onTaskEvent,
  pickVideoFile,
  saveFilePathToHash,
} from "./ffmpeg-tasks.js";

const $ = (selector) => document.querySelector(selector);

const state = {
  busy: false,
  downloadUrl: "",
  memoryAudioContext: null,
  memoryAudioSource: null,
  logs: [],
  extractVideo: null,
  extractFileHandle: null,
  extractPath: "",
  attachVideo: null,
};

const els = {
  extractChoose: $("#extract-choose"),
  extractFile: $("#extract-file"),
  extractButton: $("#extract-button"),
  attachChoose: $("#attach-choose"),
  attachFile: $("#attach-file"),
  attachAudio: $("#attach-audio"),
  attachButton: $("#attach-button"),
  hashValue: $("#hash-value"),
  recoverButton: $("#recover-button"),
  status: $("#status"),
  command: $("#command"),
  log: $("#log"),
  output: $("#output"),
};

const setDisabled = (button, disabled) => {
  button.disabled = disabled;
  button.toggleAttribute("disabled", disabled);
};

const selected = (input) => input.files && input.files[0];

const hasAudioFile = () => Boolean(selected(els.attachAudio));

const labelFor = (file, path) => {
  if (!file) return "No file selected";
  if (path && path !== file.name) return `${file.name} (${path})`;
  return file.name;
};

const setFileLabel = (el, file, path) => {
  el.textContent = labelFor(file, path);
  el.title = labelFor(file, path);
};

const updateControls = () => {
  setDisabled(els.extractChoose, state.busy);
  setDisabled(els.attachChoose, state.busy);
  setDisabled(els.extractButton, state.busy || !state.extractVideo);
  setDisabled(els.attachButton, state.busy || !state.attachVideo || !hasAudioFile());
  setDisabled(els.recoverButton, state.busy || !els.hashValue.value.trim());
};

const setBusy = (busy) => {
  state.busy = busy;
  updateControls();
};

const setStatus = (message) => {
  els.status.textContent = message;
};

const appendLog = (line) => {
  state.logs.push(line);
  els.log.textContent = `${els.log.textContent}${line}\n`;
  els.log.scrollTop = els.log.scrollHeight;
};

const clearOutput = () => {
  stopMemoryAudio();
  if (state.downloadUrl) URL.revokeObjectURL(state.downloadUrl);
  state.downloadUrl = "";
  els.output.replaceChildren();
};

const start = (command = "") => {
  clearOutput();
  els.command.textContent = command;
  els.log.textContent = "";
  state.logs = [];
  setBusy(true);
};

const appendDownload = (file) => {
  const link = document.createElement("a");
  link.href = state.downloadUrl;
  link.download = file.name;
  link.textContent = `Download ${file.name}`;
  link.className = "download";
  els.output.append(link);
};

const stopMemoryAudio = () => {
  if (state.memoryAudioSource) {
    try {
      state.memoryAudioSource.stop();
    } catch (_) {
      // Ignore sources that have already ended.
    }
    state.memoryAudioSource = null;
  }
};

const appendMemoryAudioButton = (file) => {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Play from memory";

  button.addEventListener("click", async () => {
    if (state.memoryAudioSource) {
      stopMemoryAudio();
      button.textContent = "Play from memory";
      return;
    }

    button.disabled = true;
    button.textContent = "Decoding";
    try {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) throw new Error("Web Audio API is not available");
      const context = state.memoryAudioContext || new AudioContextCtor();
      state.memoryAudioContext = context;
      if (context.state === "suspended") await context.resume();

      let buffer;
      try {
        buffer = await context.decodeAudioData(await file.arrayBuffer());
      } catch (error) {
        appendLog("Browser decode failed; decoding preview with ffmpeg");
        const decoded = await decodeAudioForPlayback(file);
        if (!decoded) throw error;
        buffer = context.createBuffer(decoded.channels, decoded.samples.length / decoded.channels, decoded.sampleRate);
        for (let channel = 0; channel < decoded.channels; channel += 1) {
          const channelData = buffer.getChannelData(channel);
          for (let index = 0; index < channelData.length; index += 1) {
            channelData[index] = decoded.samples[index * decoded.channels + channel];
          }
        }
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.addEventListener(
        "ended",
        () => {
          if (state.memoryAudioSource === source) {
            state.memoryAudioSource = null;
            button.textContent = "Play from memory";
          }
        },
        { once: true }
      );
      source.start();
      state.memoryAudioSource = source;
      button.textContent = "Stop memory playback";
    } catch (error) {
      console.error("Unable to play extracted audio from memory", error);
      appendLog("Browser could not decode this extracted audio from memory");
      button.textContent = "Play from memory";
    } finally {
      button.disabled = false;
    }
  });

  els.output.append(button);
};

const attachMediaDiagnostics = (media, label) => {
  for (const eventName of ["loadstart", "loadedmetadata", "durationchange", "canplay", "canplaythrough", "play", "playing", "waiting", "stalled", "suspend"]) {
    media.addEventListener(eventName, () => {
      appendLog(`${label}: ${eventName}; readyState=${media.readyState}; duration=${Number.isFinite(media.duration) ? media.duration.toFixed(3) : media.duration}`);
    });
  }
  media.addEventListener("error", () => {
    const error = media.error;
    const code = error ? error.code : "unknown";
    const message = error?.message || "No browser error message";
    appendLog(`${label}: error; code=${code}; ${message}`);
  });
};

const finishFile = (file) => {
  clearOutput();
  state.downloadUrl = URL.createObjectURL(file);
  appendDownload(file);
  setStatus("Ready");
  setBusy(false);
};

const finishAudio = (file) => {
  clearOutput();
  appendLog(`Extracted ${file.name}; type=${file.type || "unknown"}; size=${file.size}`);
  state.downloadUrl = URL.createObjectURL(file);
  const audio = document.createElement("audio");
  audio.controls = true;
  audio.preload = "metadata";
  attachMediaDiagnostics(audio, "audio element");
  els.output.append(audio);
  audio.src = state.downloadUrl;
  audio.load();
  appendMemoryAudioButton(file);
  appendDownload(file);
  setStatus("Ready");
  setBusy(false);
};

const finishVideo = (file) => {
  clearOutput();
  state.downloadUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = state.downloadUrl;
  video.controls = true;
  video.playsInline = true;
  els.output.append(video);
  setStatus("Ready");
  setBusy(false);
};

const fail = (message) => {
  appendLog(message);
  setStatus("Error");
  setBusy(false);
};

const chooseVideo = async () => {
  const picked = await pickVideoFile();
  if (!picked) return null;
  return picked;
};

const saveSourceVideoHash = async ({ file, path, fileHandle }) => {
  els.command.textContent = "crypto.subtle.digest SHA-256";
  const hash = await hashVideo(file);
  if (!hash) {
    appendLog("Video hash failed; source video was not saved for recovery");
    return null;
  }

  els.hashValue.value = hash;
  await saveFilePathToHash({
    path,
    hash,
    videoFile: file,
    fileHandle,
  });
  appendLog(`Saved ${path || file.name} as ${hash}`);
  updateControls();
  return hash;
};

els.extractChoose.addEventListener("click", async () => {
  const picked = await chooseVideo();
  if (!picked) return;
  state.extractVideo = picked.file;
  state.extractFileHandle = picked.fileHandle;
  state.extractPath = picked.path;
  setFileLabel(els.extractFile, picked.file, picked.path);
  updateControls();
});

els.attachChoose.addEventListener("click", async () => {
  const picked = await chooseVideo();
  if (!picked) return;
  state.attachVideo = picked.file;
  setFileLabel(els.attachFile, picked.file, picked.path);
  updateControls();
});

els.extractButton.addEventListener("click", async () => {
  if (!state.extractVideo) return;
  start();
  const file = await extractAudio(state.extractVideo);
  if (!file) {
    fail("Audio extraction failed");
    return;
  }

  await saveSourceVideoHash({
    file: state.extractVideo,
    path: state.extractPath,
    fileHandle: state.extractFileHandle,
  });
  finishAudio(file);
});

els.attachButton.addEventListener("click", async () => {
  const audioFile = selected(els.attachAudio);
  if (!state.attachVideo || !audioFile) return;
  start();
  const file = await attachAudio(audioFile, state.attachVideo);
  if (file) finishFile(file);
  else fail("Audio attach failed");
});

els.recoverButton.addEventListener("click", async () => {
  const hash = els.hashValue.value.trim();
  if (!hash) return;

  start("loadFilePathFromHash");
  const result = await loadFilePathFromHash(hash);
  if (!result) {
    fail("Video recovery failed");
    return;
  }

  state.attachVideo = result.file;
  setFileLabel(els.attachFile, result.file, result.path);
  appendLog(`Recovered ${result.path}`);
  finishVideo(result.file);
});

els.attachAudio.addEventListener("change", updateControls);
els.attachAudio.addEventListener("input", updateControls);
els.hashValue.addEventListener("input", updateControls);

onTaskEvent((data) => {
  if (data.type === "status") setStatus(data.message);
  if (data.type === "notice") appendLog(data.message);
  if (data.type === "command") els.command.textContent = `${data.tool || "ffmpeg"} ${data.args.join(" ")}`;
  if (data.type === "log") appendLog(data.message);
});

updateControls();
