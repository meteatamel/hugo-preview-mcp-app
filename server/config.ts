import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface HugoAppConfig {
  siteDir: string;
  port: number;
  buildDrafts: boolean;
  buildFuture: boolean;
}

export interface RuntimeOptions {
  dataDir: string;
  defaultSiteDir: string;
  appHtmlPath?: string;
}

export function parseRuntimeOptions(argv: string[]): RuntimeOptions {
  let dataDir = path.join(os.homedir(), ".gemini", "hugo-preview-data");
  let defaultSiteDir =
    process.env.HUGO_SITE_DIR ||
    "/Users/atamel/dev/github/meteatamel/atamel.dev";
  let appHtmlPath = process.env.HUGO_APP_HTML || undefined;

  for (const arg of argv) {
    if (arg.startsWith("--data-dir=")) {
      const val = arg.slice("--data-dir=".length).trim();
      if (val) dataDir = val;
    } else if (arg.startsWith("--default-site=")) {
      const val = arg.slice("--default-site=".length).trim();
      if (val) defaultSiteDir = val;
    } else if (arg.startsWith("--app-html=")) {
      const val = arg.slice("--app-html=".length).trim();
      if (val) appHtmlPath = val;
    }
  }

  return { dataDir, defaultSiteDir, appHtmlPath };
}

export class ConfigStore {
  private readonly configPath: string;
  private readonly defaults: HugoAppConfig;
  private cached: HugoAppConfig;

  constructor(opts: RuntimeOptions) {
    this.configPath = path.join(opts.dataDir, "config.json");
    this.defaults = {
      siteDir: opts.defaultSiteDir,
      port: Number(process.env.HUGO_PORT) || 1313,
      buildDrafts: true,
      buildFuture: true,
    };
    this.cached = this.load();
  }

  private load(): HugoAppConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, "utf8");
        const parsed = JSON.parse(raw) as Partial<HugoAppConfig>;
        return {
          siteDir:
            typeof parsed.siteDir === "string" && parsed.siteDir.trim()
              ? parsed.siteDir.trim()
              : this.defaults.siteDir,
          port:
            typeof parsed.port === "number" &&
            parsed.port >= 1313 &&
            parsed.port <= 1320
              ? parsed.port
              : this.defaults.port,
          buildDrafts:
            typeof parsed.buildDrafts === "boolean"
              ? parsed.buildDrafts
              : this.defaults.buildDrafts,
          buildFuture:
            typeof parsed.buildFuture === "boolean"
              ? parsed.buildFuture
              : this.defaults.buildFuture,
        };
      }
    } catch {
      // Fall back to defaults on corrupt config
    }
    return { ...this.defaults };
  }

  get(): HugoAppConfig {
    return { ...this.cached };
  }

  update(patch: Partial<HugoAppConfig>): HugoAppConfig {
    const next: HugoAppConfig = {
      ...this.cached,
      ...(patch.siteDir !== undefined ? { siteDir: patch.siteDir.trim() } : {}),
      ...(patch.port !== undefined ? { port: patch.port } : {}),
      ...(patch.buildDrafts !== undefined
        ? { buildDrafts: patch.buildDrafts }
        : {}),
      ...(patch.buildFuture !== undefined
        ? { buildFuture: patch.buildFuture }
        : {}),
    };
    this.cached = next;
    try {
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(next, null, 2), "utf8");
    } catch {
      // Non-fatal if data dir is read-only
    }
    return { ...this.cached };
  }
}
