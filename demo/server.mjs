import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const port = Number(process.env.PORT || 8080);

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
};

const resolvePath = (url) => {
  const pathname = decodeURIComponent(new URL(url, `http://127.0.0.1:${port}`).pathname);
  const candidate = normalize(join(root, pathname));
  if (!candidate.startsWith(root)) return null;
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    if (!pathname.endsWith("/")) return { redirect: `${pathname}/` };
    return join(candidate, "index.html");
  }
  return candidate;
};

createServer((req, res) => {
  const file = resolvePath(req.url || "/");
  if (file && typeof file === "object" && file.redirect) {
    res.writeHead(308, {
      Location: file.redirect,
      "Cache-Control": "no-store",
    });
    res.end();
    return;
  }
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end("Not found");
    return;
  }

  res.writeHead(200, {
    "Content-Type": types[extname(file)] || "application/octet-stream",
    "Cache-Control": "no-store",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  createReadStream(file).pipe(res);
}).listen(port, "127.0.0.1", () => {
  console.log(`Demo server: http://127.0.0.1:${port}/demo/`);
});
