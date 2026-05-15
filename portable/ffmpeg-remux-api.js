/**
 * Portable FFmpeg remux API for modern Vite projects.
 *
 * Put this file and `ffmpeg-core.wasm` in the same folder, then import this module
 * from application code. Importing this file does not download the WASM. The WASM
 * is requested only when `ensureLoaded()` or a FFmpeg-backed media method first runs.
 *
 * @module ffmpeg-remux-api
 */
const WORKER_SOURCE = __WORKER_SOURCE__;

const STORAGE_PREFIX = "ffmpeg-remux.video.";
const DB_NAME = "ffmpeg-remux-file-handles";
const DB_VERSION = 1;
const HANDLE_STORE = "handles";
const VIDEO_ACCEPT = {
  "video/*": [".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"],
};

const mimeByExtension = {
  aiff: "audio/aiff",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  mp4: "video/mp4",
  webm: "video/webm",
};

let dbPromise;

const storageKey = (hash) => `${STORAGE_PREFIX}${hash}`;

const extensionOf = (name = "") => {
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index + 1).toLowerCase();
};

const basenameOf = (name = "audio") => {
  const index = name.lastIndexOf(".");
  return index === -1 ? name : name.slice(0, index);
};

const hex = (buffer) =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const fileMetadataMatches = (file, record) =>
  file.name === record.name &&
  file.size === record.size &&
  file.lastModified === record.lastModified &&
  (!record.type || file.type === record.type);

const namedBlob = (blob, name, type) => {
  const fileType = type || blob.type || "application/octet-stream";
  if (typeof File === "function") {
    return new File([blob], name, {
      type: fileType,
      lastModified: Date.now(),
    });
  }

  try {
    blob.name = name;
    blob.lastModified = Date.now();
  } catch (_) {
    // Older non-browser runtimes may expose immutable Blob objects.
  }
  return blob;
};

const openDb = () => {
  if (!("indexedDB" in globalThis)) return Promise.resolve(null);
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch((error) => {
      console.error("Unable to open file handle database", error);
      return null;
    });
  }
  return dbPromise;
};

const withStore = async (mode, callback) => {
  const db = await openDb();
  if (!db) return null;

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(HANDLE_STORE, mode);
    const store = transaction.objectStore(HANDLE_STORE);
    const request = callback(store);

    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    console.error("File handle database operation failed", error);
    return null;
  });
};

const saveFileHandle = (hash, fileHandle) =>
  withStore("readwrite", (store) => store.put(fileHandle, hash));

const loadFileHandle = (hash) => withStore("readonly", (store) => store.get(hash));

const pickerOptions = (startIn) => {
  const options = {
    id: "ffmpeg-remux-video",
    multiple: false,
    types: [
      {
        description: "Video files",
        accept: VIDEO_ACCEPT,
      },
    ],
  };
  if (startIn) options.startIn = startIn;
  return options;
};

const inputFileFallback = () =>
  new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "video/*,.avi,.m4v,.mkv,.mov,.mp4,.webm";
    input.style.position = "fixed";
    input.style.left = "-10000px";
    input.addEventListener(
      "change",
      () => {
        const file = input.files && input.files[0] ? input.files[0] : null;
        input.remove();
        resolve(file ? { file, fileHandle: null, path: file.webkitRelativePath || file.name } : null);
      },
      { once: true }
    );
    document.body.append(input);
    input.click();
  });

/**
 * Hashes a video file with SHA-256 and returns a stable `sha256:<hex>` identifier.
 *
 * This is a convenience helper for matching a later-picked file to a previously
 * saved reference. It reads the full file into memory via `File.arrayBuffer()`.
 *
 * @param {File|Blob} videoFile - Video file or blob to hash.
 * @returns {Promise<string>} A hash string such as `sha256:abc123...`.
 */
export const hashVideo = async (videoFile) => {
  const digest = await crypto.subtle.digest("SHA-256", await videoFile.arrayBuffer());
  return `sha256:${hex(digest)}`;
};

/**
 * Opens a browser file picker for one video file.
 *
 * Chromium browsers use the File System Access API when available, returning a
 * persistent `fileHandle`. Other browsers fall back to a hidden `<input type=file>`.
 *
 * @param {FileSystemHandle|string} [startIn] - Optional File System Access API start directory or prior handle.
 * @returns {Promise<{file: File, fileHandle: FileSystemFileHandle|null, path: string}|null>} Picked file metadata, or `null` if the user cancels.
 */
export const pickVideoFile = async (startIn) => {
  try {
    if ("showOpenFilePicker" in window) {
      const [fileHandle] = await window.showOpenFilePicker(pickerOptions(startIn));
      const file = await fileHandle.getFile();
      return {
        file,
        fileHandle,
        path: fileHandle.name || file.webkitRelativePath || file.name,
      };
    }
  } catch (error) {
    if (error?.name === "AbortError") return null;
    console.error("Unable to open Chromium file picker", error);
  }

  return inputFileFallback();
};

/**
 * Saves metadata for a video file so it can be recovered by hash later.
 *
 * The metadata record is stored in `localStorage`. If a `fileHandle` is provided,
 * the handle is also stored in IndexedDB so Chromium can reopen the file without
 * asking the user to browse manually.
 *
 * @param {object} reference - Reference data to save.
 * @param {string} [reference.path] - Display path or label for the file.
 * @param {string} reference.hash - Hash returned by `hashVideo(videoFile)`.
 * @param {File} reference.videoFile - Original video file.
 * @param {FileSystemFileHandle|null} [reference.fileHandle] - Optional persistent handle from `pickVideoFile()`.
 * @returns {Promise<object>} The saved metadata record.
 */
export const saveVideoReference = async ({ path, hash, videoFile, fileHandle }) => {
  const record = {
    path: path || videoFile.webkitRelativePath || videoFile.name,
    hash,
    name: videoFile.name,
    size: videoFile.size,
    type: videoFile.type,
    lastModified: videoFile.lastModified,
    savedAt: new Date().toISOString(),
  };

  localStorage.setItem(storageKey(hash), JSON.stringify(record));
  if (fileHandle) await saveFileHandle(hash, fileHandle);
  return record;
};

/**
 * Loads a previously saved video reference by hash.
 *
 * If a persistent file handle is available, this requests read permission and
 * verifies the file metadata still matches. If no usable handle exists, this
 * prompts the user to pick the file again and verifies the SHA-256 hash before
 * returning it.
 *
 * @param {string} hash - Hash returned by `hashVideo(videoFile)`.
 * @returns {Promise<{path: string, file: File, hash: string, record: object}|null>} Recovered file reference, or `null` if unavailable or mismatched.
 */
export const loadVideoReferenceByHash = async (hash) => {
  const raw = localStorage.getItem(storageKey(hash));
  if (!raw) return null;

  const record = JSON.parse(raw);
  const handle = await loadFileHandle(hash);

  if (handle) {
    try {
      let permission = await handle.queryPermission({ mode: "read" });
      if (permission !== "granted") {
        permission = await handle.requestPermission({ mode: "read" });
      }

      if (permission === "granted") {
        const file = await handle.getFile();
        if (fileMetadataMatches(file, record)) return { path: record.path, file, hash, record };
      }
    } catch (error) {
      console.error("Unable to load saved video handle", error);
    }
  }

  const picked = await pickVideoFile(handle || "videos");
  if (!picked) return null;

  const pickedHash = await hashVideo(picked.file);
  if (pickedHash !== hash) return null;

  const updatedRecord = await saveVideoReference({
    path: record.path,
    hash,
    videoFile: picked.file,
    fileHandle: picked.fileHandle,
  });

  return {
    path: record.path,
    file: picked.file,
    hash,
    record: updatedRecord,
  };
};

/**
 * Creates an isolated FFmpeg task client.
 *
 * Use this when an application needs a custom WASM URL, separate event listeners,
 * or an independently terminable worker. Most apps can use the singleton exports
 * at the bottom of this module instead.
 *
 * The returned client is lazy. Creating it does not create a worker and does not
 * fetch `ffmpeg-core.wasm`; first use does.
 *
 * @param {object} [options] - Client options.
 * @param {string} [options.wasmURL] - URL for `ffmpeg-core.wasm`. Defaults to `./ffmpeg-core.wasm` next to this module.
 * @returns {{
 *   ensureLoaded: () => Promise<boolean>,
 *   extractAudio: (file: File|Blob, options?: {audioExt?: "auto"|"wav"|"aiff"|"m4a"|"mp3"|"flac"}) => Promise<File|Blob>,
 *   decodeAudioForPlayback: (file: File|Blob) => Promise<{sampleRate: number, channels: number, samples: Float32Array}>,
 *   attachAudio: (audioFile: File|Blob, videoFile: File) => Promise<File|Blob>,
 *   convertLosslessToFlac: (file: File|Blob) => Promise<File|Blob>,
 *   onTaskEvent: (callback: (event: object) => void) => () => void,
 *   terminate: () => void
 * }} A lazy FFmpeg task client.
 */
export const createFFmpegTasks = (options = {}) => {
  const wasmURL = options.wasmURL || new URL("./ffmpeg-core.wasm", import.meta.url).href;
  let worker = null;
  let workerURL = null;
  let nextTaskId = 1;
  let taskQueue = Promise.resolve();
  const pendingTasks = new Map();
  const taskEvents = new EventTarget();

  const createWorker = () => {
    if (worker) return worker;

    workerURL = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
    worker = new Worker(workerURL);
    worker.onmessage = ({ data }) => {
      if (!data || typeof data.id !== "number") return;
      const pending = pendingTasks.get(data.id);

      if (data.type === "done") {
        pendingTasks.delete(data.id);
        pending?.resolve(data);
        return;
      }

      if (data.type === "error") {
        pendingTasks.delete(data.id);
        pending?.reject(new Error(data.message || "ffmpeg task failed"));
        return;
      }

      taskEvents.dispatchEvent(new CustomEvent("task", { detail: data }));
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || "ffmpeg worker failed");
      for (const { reject } of pendingTasks.values()) reject(error);
      pendingTasks.clear();
    };
    return worker;
  };

  const postWorkerTask = (mode, payload = {}) =>
    new Promise((resolve, reject) => {
      const id = nextTaskId++;
      pendingTasks.set(id, { resolve, reject });
      createWorker().postMessage({ id, mode, wasmURL, ...payload });
    });

  const requestWorkerTask = (mode, payload) => {
    const run = () => postWorkerTask(mode, payload);
    const task = taskQueue.then(run, run);
    taskQueue = task.catch(() => {});
    return task;
  };

  /**
   * Subscribes to status, command, log, and notice events emitted by this client.
   *
   * The callback receives worker event objects such as:
   * `{ type: "status", message }`, `{ type: "command", args }`,
   * `{ type: "log", stream, message }`, or `{ type: "notice", message }`.
   *
   * @param {(event: object) => void} callback - Event callback.
   * @returns {() => void} Unsubscribe function.
   */
  const onTaskEvent = (callback) => {
    const listener = (event) => callback(event.detail);
    taskEvents.addEventListener("task", listener);
    return () => taskEvents.removeEventListener("task", listener);
  };

  /**
   * Explicitly initializes FFmpeg and downloads `ffmpeg-core.wasm` if needed.
   *
   * Calling this is optional because media methods load FFmpeg lazily. Use it to
   * show a loading state before the first operation.
   *
   * @returns {Promise<boolean>} `true` once the worker core is loaded.
   */
  const ensureLoaded = async () => {
    const result = await requestWorkerTask("load");
    return Boolean(result.loaded);
  };

  /**
   * Extracts the first audio stream from a media file.
   *
   * With `audioExt: "auto"`, browser-compatible compressed audio is stream-copied
   * when possible, while uncompressed or less-compatible audio is encoded to FLAC.
   * Pass a specific extension to request a container, with stream-copy fallbacks.
   *
   * @param {File|Blob} file - Source media file. A `File` with a useful name is preferred.
   * @param {object} [options] - Extraction options.
   * @param {"auto"|"wav"|"aiff"|"m4a"|"mp3"|"flac"} [options.audioExt="auto"] - Preferred output extension.
   * @returns {Promise<File|Blob>} Extracted audio file/blob.
   */
  const extractAudio = async (file, { audioExt = "auto" } = {}) => {
    const { name, blob } = await requestWorkerTask("extract", {
      movieFile: file,
      audioExt,
    });
    const ext = extensionOf(name);
    return namedBlob(blob, name, mimeByExtension[ext] || blob.type || "application/octet-stream");
  };

  /**
   * Decodes an audio file into interleaved Float32 PCM suitable for Web Audio previews.
   *
   * The output is normalized to stereo, 48 kHz, little-endian float samples. Use
   * this as a fallback when `AudioContext.decodeAudioData()` cannot decode a file.
   *
   * @param {File|Blob} file - Audio file to decode.
   * @returns {Promise<{sampleRate: number, channels: number, samples: Float32Array}>} Decoded PCM data.
   */
  const decodeAudioForPlayback = async (file) => {
    const { blob, sampleRate, channels } = await requestWorkerTask("decode-audio-preview", {
      audioFile: file,
    });
    return {
      sampleRate,
      channels,
      samples: new Float32Array(await blob.arrayBuffer()),
    };
  };

  /**
   * Attaches or replaces a video's audio track using stream copy.
   *
   * The output keeps the source video's first video stream, the provided audio
   * file's first audio stream, optional subtitle streams, and original metadata.
   * The audio must not be longer than the video.
   *
   * @param {File|Blob} audioFile - Audio file to attach.
   * @param {File} videoFile - Source video file. Its extension determines the output container.
   * @returns {Promise<File|Blob>} New video file/blob with attached audio.
   */
  const attachAudio = async (audioFile, videoFile) => {
    const containerExt = extensionOf(videoFile.name);
    if (!containerExt) throw new Error("Video file must have a container extension");

    const { name, blob } = await requestWorkerTask("attach", {
      movieFile: videoFile,
      audioFile,
      containerExt,
    });
    return namedBlob(
      blob,
      name,
      mimeByExtension[containerExt] || videoFile.type || "application/octet-stream"
    );
  };

  /**
   * Converts a lossless audio file to FLAC.
   *
   * Supported inputs depend on the bundled FFmpeg core and typically include WAV,
   * AIFF, FLAC, ALAC/M4A, and other decodable lossless audio containers. FLAC
   * inputs are stream-copied when possible, otherwise re-encoded to FLAC.
   *
   * @param {File|Blob} file - Lossless audio file/blob. A filename helps preserve the output basename.
   * @returns {Promise<File|Blob>} FLAC file/blob named `<input-basename>.flac`.
   */
  const convertLosslessToFlac = async (file) => {
    const { name, blob } = await requestWorkerTask("convert-lossless-to-flac", {
      audioFile: file,
    });
    const outputName = name || `${basenameOf(file?.name || "audio")}.flac`;
    return namedBlob(blob, outputName, "audio/flac");
  };

  /**
   * Terminates this client's worker and rejects pending tasks.
   *
   * A later media call will create a new worker and initialize FFmpeg again.
   * Browser HTTP cache may still avoid re-downloading the WASM bytes.
   *
   * @returns {void}
   */
  const terminate = () => {
    if (worker) {
      worker.terminate();
      worker = null;
    }
    if (workerURL) {
      URL.revokeObjectURL(workerURL);
      workerURL = null;
    }
    for (const { reject } of pendingTasks.values()) reject(new Error("ffmpeg worker terminated"));
    pendingTasks.clear();
    taskQueue = Promise.resolve();
  };

  return {
    ensureLoaded,
    extractAudio,
    decodeAudioForPlayback,
    attachAudio,
    convertLosslessToFlac,
    onTaskEvent,
    terminate,
  };
};

const defaultTasks = createFFmpegTasks();

/**
 * Explicitly initializes the singleton FFmpeg worker and downloads `ffmpeg-core.wasm` if needed.
 *
 * This is optional because all singleton media methods load lazily on first use.
 *
 * @type {() => Promise<boolean>}
 */
export const ensureLoaded = defaultTasks.ensureLoaded;

/**
 * Extracts the first audio stream from a media file using the singleton worker.
 *
 * @type {(file: File|Blob, options?: {audioExt?: "auto"|"wav"|"aiff"|"m4a"|"mp3"|"flac"}) => Promise<File|Blob>}
 */
export const extractAudio = defaultTasks.extractAudio;

/**
 * Decodes an audio file to stereo 48 kHz interleaved Float32 PCM using the singleton worker.
 *
 * @type {(file: File|Blob) => Promise<{sampleRate: number, channels: number, samples: Float32Array}>}
 */
export const decodeAudioForPlayback = defaultTasks.decodeAudioForPlayback;

/**
 * Attaches an audio file to a video using stream copy and the singleton worker.
 *
 * @type {(audioFile: File|Blob, videoFile: File) => Promise<File|Blob>}
 */
export const attachAudio = defaultTasks.attachAudio;

/**
 * Converts a lossless audio file to FLAC using the singleton worker.
 *
 * @type {(file: File|Blob) => Promise<File|Blob>}
 */
export const convertLosslessToFlac = defaultTasks.convertLosslessToFlac;

/**
 * Subscribes to singleton worker task events.
 *
 * @type {(callback: (event: object) => void) => () => void}
 */
export const onTaskEvent = defaultTasks.onTaskEvent;

/**
 * Terminates the singleton worker and rejects pending singleton tasks.
 *
 * @type {() => void}
 */
export const terminate = defaultTasks.terminate;

/**
 * Backward-compatible alias for `saveVideoReference()`.
 *
 * @type {typeof saveVideoReference}
 */
export const saveFilePathToHash = saveVideoReference;

/**
 * Backward-compatible alias for `loadVideoReferenceByHash()`.
 *
 * @type {typeof loadVideoReferenceByHash}
 */
export const loadFilePathFromHash = loadVideoReferenceByHash;
