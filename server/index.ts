import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { ConfigStore, parseRuntimeOptions } from "./config.js";
import { HugoManager, type HugoPost, type HugoStatus } from "./hugo-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_URI = "ui://hugo/app.html";

const ALLOWED_FRAME_DOMAINS: string[] = [];
for (let port = 1313; port <= 1320; port++) {
  ALLOWED_FRAME_DOMAINS.push(`http://localhost:${port}`);
  ALLOWED_FRAME_DOMAINS.push(`http://127.0.0.1:${port}`);
}

const RESOURCE_UI_META = {
  prefersBorder: false,
  csp: {
    frameDomains: ALLOWED_FRAME_DOMAINS,
  },
};

const runtimeOpts = parseRuntimeOptions(process.argv.slice(2));
const configStore = new ConfigStore(runtimeOpts);
const hugoManager = new HugoManager(configStore.get());

function resolveUiHtmlPath(): string {
  if (runtimeOpts.appHtmlPath && fs.existsSync(runtimeOpts.appHtmlPath)) {
    return runtimeOpts.appHtmlPath;
  }
  return path.resolve(__dirname, "../ui/index.html");
}

function readUiHtml(): string {
  const htmlPath = resolveUiHtmlPath();
  if (!fs.existsSync(htmlPath)) {
    throw new Error(
      `Hugo Preview UI bundle not found at ${htmlPath}. Run "npm run build" first.`
    );
  }
  return fs.readFileSync(htmlPath, "utf8");
}

async function safeListPosts(siteDir: string, limit = 500): Promise<{
  posts: HugoPost[];
  postsError: string | null;
}> {
  try {
    const posts = await hugoManager.listPosts(siteDir, { limit });
    return { posts, postsError: null };
  } catch (err) {
    return {
      posts: [],
      postsError: err instanceof Error ? err.message : String(err),
    };
  }
}

function normalizeUrlPath(p?: string): string {
  if (!p || !p.trim()) return "/";
  const trimmed = p.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      return new URL(trimmed).pathname || "/";
    } catch {
      return "/";
    }
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function resolveSafePostFile(siteDir: string, filePath: string): string {
  const root = fs.existsSync(siteDir)
    ? fs.realpathSync(siteDir)
    : path.resolve(siteDir);
  const candidate = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(root, filePath);
  const resolved = fs.existsSync(candidate)
    ? fs.realpathSync(candidate)
    : candidate;

  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Access denied: file is outside Hugo site directory (${root}).`);
  }
  const ext = path.extname(resolved).toLowerCase();
  if (![".md", ".markdown", ".mdown", ".html", ".toml", ".yaml", ".yml"].includes(ext)) {
    throw new Error(`Unsupported file type for editing: ${ext || "(none)"}`);
  }
  return resolved;
}

function formatStatusText(status: HugoStatus, activePath?: string): string {
  if (status.running) {
    const mode = status.managed ? `managed PID ${status.pid}` : "external";
    const flags = [
      status.buildDrafts ? "-D" : null,
      status.buildFuture ? "-F" : null,
    ]
      .filter(Boolean)
      .join(" ");
    const targetUrl =
      activePath && status.url ? `${status.url}${activePath}` : status.url;
    return `Hugo server is running (${mode}) at ${targetUrl} for ${status.siteDir}${flags ? ` [${flags}]` : ""}.`;
  }
  return `Hugo server is stopped (site: ${status.siteDir}, port: ${status.port}).`;
}

const server = new McpServer({
  name: "hugo-preview",
  version: "0.1.0",
});

// UI Resource
registerAppResource(
  server,
  "Hugo Preview UI",
  APP_URI,
  {
    description: "Interactive side-panel UI for managing and previewing a local Hugo blog",
    mimeType: RESOURCE_MIME_TYPE,
    _meta: {
      ui: RESOURCE_UI_META,
    },
  },
  async () => {
    const html = readUiHtml();
    return {
      contents: [
        {
          uri: APP_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
          _meta: {
            ui: RESOURCE_UI_META,
          },
        },
      ],
    };
  }
);

// 1. Primary Side Panel Entrypoint Tool
registerAppTool(
  server,
  "hugo_preview",
  {
    title: "Hugo Preview",
    description:
      "Open or update the Hugo Preview side panel. Optionally start the Hugo server and navigate directly to a specific blog post path.",
    inputSchema: {
      siteDir: z
        .string()
        .optional()
        .describe("Path to the Hugo site directory (defaults to saved config)"),
      path: z
        .string()
        .optional()
        .describe(
          "Relative URL path to preview, e.g. /posts/2026/my-post/ (defaults to /)"
        ),
      autoStart: z
        .boolean()
        .optional()
        .describe("If true, automatically start Hugo server when stopped"),
      buildDrafts: z
        .boolean()
        .optional()
        .describe("Include drafts (-D). Defaults to saved config (true)."),
      buildFuture: z
        .boolean()
        .optional()
        .describe("Include future posts (--buildFuture). Defaults to saved config (true)."),
    },
    _meta: {
      ui: {
        resourceUri: APP_URI,
      },
      "com.google.antigravity/ui": {
        entrypoints: [
          {
            type: "aux_pane",
            title: "Hugo Preview",
          },
        ],
      },
    },
  },
  async (args) => {
    const cfg = configStore.get();
    const siteDir = args.siteDir?.trim() || cfg.siteDir;
    const buildDrafts = args.buildDrafts ?? cfg.buildDrafts;
    const buildFuture = args.buildFuture ?? cfg.buildFuture;
    const targetPath = normalizeUrlPath(args.path);

    if (
      args.siteDir !== undefined ||
      args.buildDrafts !== undefined ||
      args.buildFuture !== undefined
    ) {
      configStore.update({ siteDir, buildDrafts, buildFuture });
    }

    let status = await hugoManager.getStatus({
      siteDir,
      port: cfg.port,
      buildDrafts,
      buildFuture,
    });

    if (args.autoStart && !status.running) {
      status = await hugoManager.start({
        siteDir,
        port: cfg.port,
        buildDrafts,
        buildFuture,
      });
    }

    const { posts, postsError } = await safeListPosts(siteDir, 500);

    const payload = {
      status,
      posts,
      postsError,
      activePath: targetPath,
      config: configStore.get(),
    };

    return {
      content: [
        {
          type: "text",
          text: `${formatStatusText(status, targetPath)} Found ${posts.length} pages.`,
        },
      ],
      structuredContent: payload,
    };
  }
);

// 2. Start Hugo Server
registerAppTool(
  server,
  "hugo_start",
  {
    title: "Start Hugo Server",
    description:
      "Start the local Hugo dev server for previewing blog posts. Persists updated site/flag settings.",
    inputSchema: {
      siteDir: z.string().optional().describe("Hugo site directory"),
      port: z
        .number()
        .int()
        .min(1313)
        .max(1320)
        .optional()
        .describe("Local port (1313-1320, default 1313)"),
      buildDrafts: z.boolean().optional().describe("Pass --buildDrafts (-D)"),
      buildFuture: z.boolean().optional().describe("Pass --buildFuture (-F)"),
    },
    _meta: {
      ui: {
        visibility: ["model", "app"],
      },
    },
  },
  async (args) => {
    const cfg = configStore.update({
      ...(args.siteDir ? { siteDir: args.siteDir } : {}),
      ...(args.port !== undefined ? { port: args.port } : {}),
      ...(args.buildDrafts !== undefined
        ? { buildDrafts: args.buildDrafts }
        : {}),
      ...(args.buildFuture !== undefined
        ? { buildFuture: args.buildFuture }
        : {}),
    });

    const status = await hugoManager.start(cfg);
    const { posts, postsError } = await safeListPosts(cfg.siteDir, 500);

    return {
      content: [{ type: "text", text: formatStatusText(status) }],
      structuredContent: {
        status,
        posts,
        postsError,
        config: cfg,
      },
    };
  }
);

// 3. Stop Hugo Server
registerAppTool(
  server,
  "hugo_stop",
  {
    title: "Stop Hugo Server",
    description: "Stop the managed local Hugo server.",
    inputSchema: {},
    _meta: {
      ui: {
        visibility: ["model", "app"],
      },
    },
  },
  async () => {
    const status = await hugoManager.stop();
    return {
      content: [{ type: "text", text: formatStatusText(status) }],
      structuredContent: {
        status,
        config: configStore.get(),
      },
    };
  }
);

// 4. Status
registerAppTool(
  server,
  "hugo_status",
  {
    title: "Hugo Server Status",
    description: "Check whether the local Hugo server is running and its current settings.",
    inputSchema: {},
    _meta: {
      ui: {
        visibility: ["model", "app"],
      },
    },
  },
  async () => {
    const cfg = configStore.get();
    const status = await hugoManager.getStatus(cfg);
    return {
      content: [{ type: "text", text: formatStatusText(status) }],
      structuredContent: {
        status,
        config: cfg,
      },
    };
  }
);

// 5. List Posts
registerAppTool(
  server,
  "hugo_list_posts",
  {
    title: "List Hugo Posts",
    description:
      "List blog posts and pages from the Hugo site using `hugo list all`, including draft/future status, permalink paths, and source file paths.",
    inputSchema: {
      siteDir: z.string().optional().describe("Hugo site directory"),
      query: z.string().optional().describe("Filter by title or path substring"),
      draftsOnly: z.boolean().optional().describe("Only return draft posts"),
      futureOnly: z.boolean().optional().describe("Only return future-dated posts"),
      section: z.string().optional().describe("Filter by Hugo section (e.g. posts)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Maximum number of posts to return (default 100)"),
    },
    _meta: {
      ui: {
        visibility: ["model", "app"],
      },
    },
  },
  async (args) => {
    const cfg = configStore.get();
    const siteDir = args.siteDir?.trim() || cfg.siteDir;
    const posts = await hugoManager.listPosts(siteDir, {
      query: args.query,
      draftsOnly: args.draftsOnly,
      futureOnly: args.futureOnly,
      section: args.section,
      limit: args.limit ?? 100,
    });

    const summaryLines = posts.slice(0, 20).map((p) => {
      const badges = [p.draft ? "DRAFT" : null, p.future ? "FUTURE" : null]
        .filter(Boolean)
        .join(",");
      return `- ${p.title} (${p.path})${badges ? ` [${badges}]` : ""}`;
    });

    return {
      content: [
        {
          type: "text",
          text:
            posts.length === 0
              ? `No posts found in ${siteDir}.`
              : `Found ${posts.length} pages in ${siteDir}:\n${summaryLines.join("\n")}`,
        },
      ],
      structuredContent: {
        siteDir,
        posts,
      },
    };
  }
);

// 6. App-only: Get Logs
registerAppTool(
  server,
  "hugo_get_logs",
  {
    title: "Get Hugo Logs",
    description: "Retrieve recent Hugo server stdout/stderr logs for the UI.",
    inputSchema: {},
    _meta: {
      ui: {
        visibility: ["app"],
      },
    },
  },
  async () => {
    const logs = hugoManager.getLogs();
    const status = await hugoManager.getStatus(configStore.get());
    return {
      content: [{ type: "text", text: `${logs.length} log lines` }],
      structuredContent: {
        logs,
        lastError: status.lastError,
      },
    };
  }
);

// 7. App-only: Save Config
registerAppTool(
  server,
  "hugo_save_config",
  {
    title: "Save Hugo Config",
    description: "Persist Hugo Preview settings (siteDir, port, buildDrafts, buildFuture).",
    inputSchema: {
      siteDir: z.string().optional(),
      port: z.number().int().min(1313).max(1320).optional(),
      buildDrafts: z.boolean().optional(),
      buildFuture: z.boolean().optional(),
    },
    _meta: {
      ui: {
        visibility: ["app"],
      },
    },
  },
  async (args) => {
    const cfg = configStore.update(args);
    const { posts, postsError } = await safeListPosts(cfg.siteDir, 500);
    const status = await hugoManager.getStatus(cfg);
    return {
      content: [{ type: "text", text: `Saved config for ${cfg.siteDir}` }],
      structuredContent: {
        config: cfg,
        status,
        posts,
        postsError,
      },
    };
  }
);

// 8. App-only: Read Post Markdown
registerAppTool(
  server,
  "hugo_read_post",
  {
    title: "Read Hugo Post",
    description: "Read a Markdown post file inside the configured Hugo site directory.",
    inputSchema: {
      filePath: z.string().describe("Path to the Markdown post file"),
    },
    _meta: {
      ui: {
        visibility: ["app"],
      },
    },
  },
  async (args) => {
    const cfg = configStore.get();
    const safePath = resolveSafePostFile(cfg.siteDir, args.filePath);
    const content = fs.readFileSync(safePath, "utf8");
    const stat = fs.statSync(safePath);
    return {
      content: [{ type: "text", text: `Read ${path.relative(cfg.siteDir, safePath)} (${content.length} chars)` }],
      structuredContent: {
        filePath: safePath,
        content,
        mtimeMs: stat.mtimeMs,
      },
    };
  }
);

// 9. App-only: Write Post Markdown
registerAppTool(
  server,
  "hugo_write_post",
  {
    title: "Write Hugo Post",
    description: "Save edited Markdown back to a post file inside the configured Hugo site directory.",
    inputSchema: {
      filePath: z.string().describe("Path to the Markdown post file"),
      content: z.string().describe("Full Markdown file content to write"),
    },
    _meta: {
      ui: {
        visibility: ["app"],
      },
    },
  },
  async (args) => {
    const cfg = configStore.get();
    const safePath = resolveSafePostFile(cfg.siteDir, args.filePath);
    fs.writeFileSync(safePath, args.content, "utf8");
    const stat = fs.statSync(safePath);
    return {
      content: [{ type: "text", text: `Saved ${path.relative(cfg.siteDir, safePath)}` }],
      structuredContent: {
        filePath: safePath,
        savedAt: new Date().toISOString(),
        mtimeMs: stat.mtimeMs,
        bytes: Buffer.byteLength(args.content, "utf8"),
      },
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error starting hugo-preview MCP server:", err);
  process.exit(1);
});
