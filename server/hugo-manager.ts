import { spawn, execFile, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface HugoStatus {
  running: boolean;
  managed: boolean;
  pid: number | null;
  url: string | null;
  siteDir: string;
  port: number;
  buildDrafts: boolean;
  buildFuture: boolean;
  startedAt: string | null;
  lastError: string | null;
}

export interface HugoPost {
  title: string;
  path: string;
  relPath: string;
  filePath: string;
  date: string;
  publishDate: string;
  draft: boolean;
  future: boolean;
  section: string;
  kind: string;
}

export interface StartOptions {
  siteDir: string;
  port: number;
  buildDrafts: boolean;
  buildFuture: boolean;
}

const MAX_LOG_LINES = 150;

const SCROLL_SYNC_SCRIPT = `<script>(function(){
  var raf=null,targetTop=null,targetBehavior='auto',ignoreUntil=0,outRaf=null;
  window.addEventListener('message',function(ev){
    var d=ev.data;
    if(!d||d.type!=='hugo-preview-scroll')return;
    var max=Math.max(0,document.documentElement.scrollHeight-window.innerHeight);
    targetTop=Math.round(Math.min(1,Math.max(0,Number(d.ratio)||0))*max);
    targetBehavior=d.smooth?'smooth':'auto';
    ignoreUntil=Date.now()+(d.smooth?400:180);
    if(!raf){
      raf=requestAnimationFrame(function(){
        raf=null;
        if(targetTop!==null){
          ignoreUntil=Date.now()+(targetBehavior==='smooth'?400:180);
          window.scrollTo({top:targetTop,behavior:targetBehavior});
        }
      });
    }
  });
  window.addEventListener('scroll',function(){
    if(Date.now()<ignoreUntil)return;
    if(!outRaf){
      outRaf=requestAnimationFrame(function(){
        outRaf=null;
        if(Date.now()<ignoreUntil)return;
        var max=Math.max(1,document.documentElement.scrollHeight-window.innerHeight);
        var ratio=Math.min(1,Math.max(0,window.scrollY/max));
        try{window.parent.postMessage({type:'hugo-preview-scrolled',ratio:ratio},'*');}catch(e){}
      });
    }
  },{passive:true});
  window.addEventListener('load',function(){
    try{window.parent.postMessage({type:'hugo-preview-ready'},'*');}catch(e){}
  });
})();</script>`;

function injectScrollScript(html: string): string {
  const idx = html.lastIndexOf("</body>");
  if (idx !== -1) {
    return html.slice(0, idx) + SCROLL_SYNC_SCRIPT + html.slice(idx);
  }
  return html + SCROLL_SYNC_SCRIPT;
}

function resolveHugoBinary(): string {
  const candidates = [
    "/opt/homebrew/bin/hugo",
    "/usr/local/bin/hugo",
    "hugo",
  ];
  for (const bin of candidates) {
    if (bin === "hugo" || fs.existsSync(bin)) {
      return bin;
    }
  }
  return "hugo";
}

function isPortOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.setTimeout(400);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch === "\r") {
      // ignore CR
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function extractUrlPath(permalink: string): string {
  if (!permalink) return "/";
  try {
    const u = new URL(permalink);
    return u.pathname.startsWith("/") ? u.pathname : `/${u.pathname}`;
  } catch {
    return permalink.startsWith("/") ? permalink : `/${permalink}`;
  }
}

export class HugoManager {
  private child: ChildProcess | null = null;
  private proxyServer: http.Server | null = null;
  private activeOpts: StartOptions;
  private startedAt: string | null = null;
  private lastError: string | null = null;
  private logs: string[] = [];
  private readonly hugoBin: string;

  constructor(initialOpts: StartOptions) {
    this.activeOpts = { ...initialOpts };
    this.hugoBin = resolveHugoBinary();

    const cleanup = () => {
      this.killSync();
    };
    process.on("SIGINT", () => {
      cleanup();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      cleanup();
      process.exit(0);
    });
    process.on("exit", cleanup);
  }

  private pushLog(line: string): void {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed.trim()) return;
    const ts = new Date().toISOString().slice(11, 19);
    this.logs.push(`[${ts}] ${trimmed}`);
    if (this.logs.length > MAX_LOG_LINES) {
      this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
    }
    if (/^ERROR\b|Error:/i.test(trimmed)) {
      this.lastError = trimmed;
    } else if (/Web Server is available at|Total in \d+ ms/i.test(trimmed)) {
      this.lastError = null;
    }
  }

  getLogs(): string[] {
    return [...this.logs];
  }

  async getStatus(fallbackOpts?: StartOptions): Promise<HugoStatus> {
    const opts = this.child ? this.activeOpts : fallbackOpts || this.activeOpts;
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      return {
        running: true,
        managed: true,
        pid: this.child.pid ?? null,
        url: `http://localhost:${opts.port}`,
        siteDir: opts.siteDir,
        port: opts.port,
        buildDrafts: opts.buildDrafts,
        buildFuture: opts.buildFuture,
        startedAt: this.startedAt,
        lastError: this.lastError,
      };
    }

    const externalOpen = await isPortOpen(opts.port);
    return {
      running: externalOpen,
      managed: false,
      pid: null,
      url: externalOpen ? `http://localhost:${opts.port}` : null,
      siteDir: opts.siteDir,
      port: opts.port,
      buildDrafts: opts.buildDrafts,
      buildFuture: opts.buildFuture,
      startedAt: null,
      lastError: this.lastError,
    };
  }

  async start(opts: StartOptions): Promise<HugoStatus> {
    if (!fs.existsSync(opts.siteDir)) {
      throw new Error(`Hugo site directory does not exist: ${opts.siteDir}`);
    }

    // If already running with identical options, return current status.
    if (
      this.child &&
      this.child.exitCode === null &&
      !this.child.killed &&
      this.activeOpts.siteDir === opts.siteDir &&
      this.activeOpts.port === opts.port &&
      this.activeOpts.buildDrafts === opts.buildDrafts &&
      this.activeOpts.buildFuture === opts.buildFuture
    ) {
      return this.getStatus(opts);
    }

    // Stop any previous managed instance before starting with new options.
    if (this.child) {
      await this.stop();
    }

    // Check if an unmanaged server is already bound to this port.
    if (await isPortOpen(opts.port)) {
      this.activeOpts = { ...opts };
      this.pushLog(
        `Port ${opts.port} is already serving (external process detected).`
      );
      return this.getStatus(opts);
    }

    const internalPort = opts.port + 1000;
    const args = [
      "server",
      "--port",
      String(internalPort),
      "--bind",
      "127.0.0.1",
      "--baseURL",
      `http://localhost:${opts.port}/`,
      "--appendPort=false",
      "--liveReloadPort",
      String(opts.port),
    ];
    if (opts.buildDrafts) args.push("--buildDrafts");
    if (opts.buildFuture) args.push("--buildFuture");

    this.logs = [];
    this.lastError = null;
    this.activeOpts = { ...opts };
    this.pushLog(`Starting: ${this.hugoBin} ${args.join(" ")} (cwd: ${opts.siteDir})`);

    const child = spawn(this.hugoBin, args, {
      cwd: opts.siteDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}`,
      },
    });
    this.child = child;
    this.startedAt = new Date().toISOString();

    let readyResolve: (() => void) | null = null;
    let readyReject: ((err: Error) => void) | null = null;
    const readyPromise = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });

    const handleChunk = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        this.pushLog(line);
        if (/Web Server is available at/i.test(line)) {
          readyResolve?.();
          readyResolve = null;
          readyReject = null;
        }
      }
    };

    child.stdout?.on("data", handleChunk);
    child.stderr?.on("data", handleChunk);

    child.on("error", (err) => {
      this.lastError = err.message;
      this.pushLog(`Process error: ${err.message}`);
      readyReject?.(err);
      readyResolve = null;
      readyReject = null;
    });

    child.on("exit", (code, signal) => {
      this.pushLog(`Hugo exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
      if (this.child === child) {
        this.child = null;
        this.startedAt = null;
        this.closeProxy();
      }
      if (readyReject) {
        readyReject(
          new Error(
            this.lastError ||
              `Hugo exited early with code ${code ?? signal ?? "unknown"}`
          )
        );
        readyResolve = null;
        readyReject = null;
      }
    });

    // Race against a 10s startup timeout + port readiness poll.
    const timeout = setTimeout(async () => {
      if (readyResolve) {
        if (await isPortOpen(internalPort)) {
          readyResolve();
        } else {
          readyReject?.(
            new Error(
              this.lastError ||
                `Timed out waiting for Hugo server on port ${internalPort}`
            )
          );
        }
        readyResolve = null;
        readyReject = null;
      }
    }, 10_000);

    try {
      await readyPromise;
      await this.startProxy(opts.port, internalPort);
    } catch (err) {
      await this.stop();
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    return this.getStatus(opts);
  }

  private async startProxy(listenPort: number, targetPort: number): Promise<void> {
    this.closeProxy();

    const server = http.createServer((req, res) => {
      const headers = { ...req.headers };
      // Request uncompressed responses so we can inject the scroll-sync snippet into HTML
      headers["accept-encoding"] = "identity";
      headers.host = `127.0.0.1:${targetPort}`;

      const proxyReq = http.request(
        {
          hostname: "127.0.0.1",
          port: targetPort,
          path: req.url || "/",
          method: req.method,
          headers,
        },
        (proxyRes) => {
          const contentType = String(proxyRes.headers["content-type"] || "");
          if (contentType.includes("text/html")) {
            const chunks: Buffer[] = [];
            proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
            proxyRes.on("end", () => {
              const rawHtml = Buffer.concat(chunks).toString("utf8");
              const injected = injectScrollScript(rawHtml);
              const outBuf = Buffer.from(injected, "utf8");
              const outHeaders = { ...proxyRes.headers };
              delete outHeaders["content-encoding"];
              outHeaders["content-length"] = String(outBuf.length);
              res.writeHead(proxyRes.statusCode || 200, outHeaders);
              res.end(outBuf);
            });
          } else {
            res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
            proxyRes.pipe(res);
          }
        }
      );

      proxyReq.on("error", () => {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/plain" });
        }
        res.end("Hugo preview proxy error");
      });

      req.pipe(proxyReq);
    });

    // Forward Hugo's /livereload WebSocket upgrade transparently
    server.on("upgrade", (req, socket, head) => {
      const upstream = net.connect(targetPort, "127.0.0.1", () => {
        let rawReq = `${req.method || "GET"} ${req.url || "/"} HTTP/${req.httpVersion}\r\n`;
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const key = req.rawHeaders[i];
          const lower = key.toLowerCase();
          let val = req.rawHeaders[i + 1];
          if (lower === "host") {
            val = `127.0.0.1:${targetPort}`;
          } else if (lower === "origin") {
            val = `http://127.0.0.1:${targetPort}`;
          }
          rawReq += `${key}: ${val}\r\n`;
        }
        rawReq += "\r\n";
        upstream.write(rawReq);
        if (head.length > 0) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(listenPort, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    this.proxyServer = server;
  }

  private closeProxy(): void {
    if (this.proxyServer) {
      try {
        this.proxyServer.close();
      } catch {
        // ignore
      }
      this.proxyServer = null;
    }
  }

  async stop(): Promise<HugoStatus> {
    this.closeProxy();
    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.child = null;
      this.startedAt = null;
      return this.getStatus();
    }

    this.pushLog("Stopping Hugo server...");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve();
      }, 3000);

      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });

      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });

    this.child = null;
    this.startedAt = null;
    return this.getStatus();
  }

  private killSync(): void {
    if (this.child && this.child.exitCode === null) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  }

  async listPosts(
    siteDir: string,
    filter?: {
      query?: string;
      draftsOnly?: boolean;
      futureOnly?: boolean;
      section?: string;
      limit?: number;
    }
  ): Promise<HugoPost[]> {
    if (!fs.existsSync(siteDir)) {
      throw new Error(`Hugo site directory does not exist: ${siteDir}`);
    }

    const { stdout } = await execFileAsync(this.hugoBin, ["list", "all"], {
      cwd: siteDir,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}`,
      },
    });

    const rows = parseCsv(stdout);
    if (rows.length <= 1) return [];

    const header = rows[0].map((h) => h.trim());
    const idx = (name: string) => header.indexOf(name);
    const iPath = idx("path");
    const iTitle = idx("title");
    const iDate = idx("date");
    const iPublishDate = idx("publishDate");
    const iDraft = idx("draft");
    const iPermalink = idx("permalink");
    const iKind = idx("kind");
    const iSection = idx("section");

    const now = Date.now();
    const posts: HugoPost[] = [];

    for (let r = 1; r < rows.length; r++) {
      const cols = rows[r];
      if (!cols || cols.length < 2) continue;

      const relPath = (cols[iPath] || "").trim();
      if (!relPath) continue;
      const kind = iKind >= 0 ? (cols[iKind] || "").trim() : "page";
      if (kind && kind !== "page") continue;

      const section = iSection >= 0 ? (cols[iSection] || "").trim() : "";
      const title =
        (cols[iTitle] || "").trim() ||
        path.basename(relPath, path.extname(relPath));
      const date = (cols[iDate] || "").trim();
      const publishDate = (cols[iPublishDate] || "").trim();
      const draft = (cols[iDraft] || "").trim().toLowerCase() === "true";
      const permalink = (cols[iPermalink] || "").trim();
      const urlPath = extractUrlPath(permalink);

      const effectiveDateStr =
        publishDate && !publishDate.startsWith("0001-") ? publishDate : date;
      const parsedTime = effectiveDateStr ? Date.parse(effectiveDateStr) : NaN;
      const future = !Number.isNaN(parsedTime) && parsedTime > now;

      posts.push({
        title,
        path: urlPath,
        relPath,
        filePath: path.join(siteDir, relPath),
        date,
        publishDate,
        draft,
        future,
        section,
        kind: kind || "page",
      });
    }

    // Sort newest first; prefer "posts" section on ties.
    posts.sort((a, b) => {
      const ta = Date.parse(a.date) || 0;
      const tb = Date.parse(b.date) || 0;
      if (tb !== ta) return tb - ta;
      if (a.section === "posts" && b.section !== "posts") return -1;
      if (b.section === "posts" && a.section !== "posts") return 1;
      return a.title.localeCompare(b.title);
    });

    let result = posts;
    if (filter?.section) {
      const sec = filter.section.toLowerCase();
      result = result.filter((p) => p.section.toLowerCase() === sec);
    }
    if (filter?.draftsOnly) {
      result = result.filter((p) => p.draft);
    }
    if (filter?.futureOnly) {
      result = result.filter((p) => p.future);
    }
    if (filter?.query) {
      const q = filter.query.toLowerCase();
      result = result.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.path.toLowerCase().includes(q) ||
          p.relPath.toLowerCase().includes(q)
      );
    }
    if (filter?.limit && filter.limit > 0) {
      result = result.slice(0, filter.limit);
    }

    return result;
  }
}
