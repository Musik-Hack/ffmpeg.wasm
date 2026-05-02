const worker = new Worker("/demo/ffmpeg-tasks.worker.js");

const STORAGE_PREFIX = "ffmpeg-demo.video.";
const DB_NAME = "ffmpeg-demo-file-handles";
const DB_VERSION = 1;
const HANDLE_STORE = "handles";
const VIDEO_ACCEPT = {
  "video/*": [".avi", ".m4v", ".mkv", ".mov", ".mp4", ".webm"],
};

let nextTaskId = 1;
let dbPromise;

const pendingTasks = new Map();
const taskEvents = new EventTarget();
let taskQueue = Promise.resolve();

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

const storageKey = (hash) => `${STORAGE_PREFIX}${hash}`;

const extensionOf = (name) => {
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index + 1).toLowerCase();
};

const hex = (buffer) =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const fileMetadataMatches = (file, record) =>
  file.name === record.name &&
  file.size === record.size &&
  file.lastModified === record.lastModified &&
  (!record.type || file.type === record.type);

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
    id: "ffmpeg-demo-video",
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

const postWorkerTask = (mode, payload) =>
  new Promise((resolve, reject) => {
    const id = nextTaskId++;
    pendingTasks.set(id, { resolve, reject });
    worker.postMessage({ id, mode, ...payload });
  });

const requestWorkerTask = (mode, payload) => {
  const run = () => postWorkerTask(mode, payload);
  const task = taskQueue.then(run, run);
  taskQueue = task.catch(() => {});
  return task;
};

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

export const onTaskEvent = (callback) => {
  const listener = (event) => callback(event.detail);
  taskEvents.addEventListener("task", listener);
  return () => taskEvents.removeEventListener("task", listener);
};

export const hashVideo = async (videoFile) => {
  try {
    const digest = await crypto.subtle.digest("SHA-256", await videoFile.arrayBuffer());
    return `sha256:${hex(digest)}`;
  } catch (error) {
    console.error("Unable to hash video", error);
    return null;
  }
};

export const extractAudio = async (file) => {
  try {
    const { name, blob } = await requestWorkerTask("extract", {
      movieFile: file,
      audioExt: "auto",
    });
    const ext = extensionOf(name);
    return new File([blob], name, {
      type: mimeByExtension[ext] || blob.type || "application/octet-stream",
      lastModified: Date.now(),
    });
  } catch (error) {
    console.error("Unable to extract audio", error);
    return null;
  }
};

export const decodeAudioForPlayback = async (file) => {
  try {
    const { blob, sampleRate, channels } = await requestWorkerTask("decode-audio-preview", {
      audioFile: file,
    });
    return {
      sampleRate,
      channels,
      samples: new Float32Array(await blob.arrayBuffer()),
    };
  } catch (error) {
    console.error("Unable to decode audio for playback", error);
    return null;
  }
};

export const attachAudio = async (audioFile, videoFile) => {
  try {
    const containerExt = extensionOf(videoFile.name);
    if (!containerExt) throw new Error("Video file must have a container extension");

    const { name, blob } = await requestWorkerTask("attach", {
      movieFile: videoFile,
      audioFile,
      containerExt,
    });
    return new File([blob], name, {
      type: mimeByExtension[containerExt] || videoFile.type || "application/octet-stream",
      lastModified: Date.now(),
    });
  } catch (error) {
    console.error("Unable to attach audio", error);
    return null;
  }
};

export const saveFilePathToHash = async ({ path, hash, videoFile, fileHandle }) => {
  try {
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
  } catch (error) {
    console.error("Unable to save video path for hash", error);
  }
};

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

export const loadFilePathFromHash = async (hash) => {
  try {
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

    await saveFilePathToHash({
      path: record.path,
      hash,
      videoFile: picked.file,
      fileHandle: picked.fileHandle,
    });

    return {
      path: record.path,
      file: picked.file,
      hash,
      record: JSON.parse(localStorage.getItem(storageKey(hash))),
    };
  } catch (error) {
    console.error("Unable to load video path from hash", error);
    return null;
  }
};
