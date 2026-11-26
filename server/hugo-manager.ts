import { spawn, execFile, type ChildProcess } from "node:child_process";
import fs from "node:fs";
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

    const args = [
      "server",
      "--port",
      String(opts.port),
      "--bind",
      "127.0.0.1",
      "--baseURL",
      `http://localhost:${opts.port}/`,
      "--appendPort=false",
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
        if (await isPortOpen(opts.port)) {
          readyResolve();
        } else {
          readyReject?.(
            new Error(
              this.lastError ||
                `Timed out waiting for Hugo server on port ${opts.port}`
            )
          );
        }
        readyResolve = null;
        readyReject = null;
      }
    }, 10_000);

    try {
      await readyPromise;
    } finally {
      clearTimeout(timeout);
    }

    return this.getStatus(opts);
  }

  async stop(): Promise<HugoStatus> {
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
