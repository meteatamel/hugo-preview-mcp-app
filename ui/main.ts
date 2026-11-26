import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";

interface HugoStatus {
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

interface HugoPost {
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

interface HugoAppConfig {
  siteDir: string;
  port: number;
  buildDrafts: boolean;
  buildFuture: boolean;
}

interface ToolPayload {
  status?: HugoStatus;
  posts?: HugoPost[];
  postsError?: string | null;
  activePath?: string;
  config?: HugoAppConfig;
  logs?: string[];
  lastError?: string | null;
}

type ViewMode = "preview" | "split";

const state: {
  status: HugoStatus | null;
  posts: HugoPost[];
  config: HugoAppConfig;
  selectedPostPath: string | null;
  busy: boolean;
  mobile: boolean;
  logsOpen: boolean;
  settingsOpen: boolean;
  canUpdateContext: boolean;
  canOpenLinks: boolean;
  viewMode: ViewMode;
  editorFilePath: string | null;
  editorDirty: boolean;
  editorSaving: boolean;
  editorStatusText: string;
  autoSave: boolean;
} = {
  status: null,
  posts: [],
  config: {
    siteDir: "/Users/atamel/dev/github/meteatamel/atamel.dev",
    port: 1313,
    buildDrafts: true,
    buildFuture: true,
  },
  selectedPostPath: null,
  busy: false,
  mobile: false,
  logsOpen: false,
  settingsOpen: false,
  canUpdateContext: false,
  canOpenLinks: false,
  viewMode: "preview",
  editorFilePath: null,
  editorDirty: false,
  editorSaving: false,
  editorStatusText: "",
  autoSave: true,
};

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const statusBadge = $<HTMLSpanElement>("status-badge");
const statusLabel = $<HTMLSpanElement>("status-label");
const btnStartStop = $<HTMLButtonElement>("btn-start-stop");
const btnReload = $<HTMLButtonElement>("btn-reload");
const chkDrafts = $<HTMLInputElement>("chk-drafts");
const chkFuture = $<HTMLInputElement>("chk-future");
const btnMobile = $<HTMLButtonElement>("btn-mobile");
const btnOpenBrowser = $<HTMLButtonElement>("btn-open-browser");
const btnLogs = $<HTMLButtonElement>("btn-logs");
const btnSettings = $<HTMLButtonElement>("btn-settings");
const runningBar = $<HTMLDivElement>("running-bar");
const btnBackPosts = $<HTMLButtonElement>("btn-back-posts");
const postSelect = $<HTMLSelectElement>("post-select");
const btnRefreshPosts = $<HTMLButtonElement>("btn-refresh-posts");
const btnModePreview = $<HTMLButtonElement>("btn-mode-preview");
const btnModeSplit = $<HTMLButtonElement>("btn-mode-split");
const settingsPanel = $<HTMLElement>("settings-panel");
const inputSiteDir = $<HTMLInputElement>("input-site-dir");
const inputPort = $<HTMLInputElement>("input-port");
const btnSaveSettings = $<HTMLButtonElement>("btn-save-settings");
const banner = $<HTMLDivElement>("banner");
const editorPane = $<HTMLElement>("editor-pane");
const editorFilename = $<HTMLSpanElement>("editor-filename");
const editorStatus = $<HTMLSpanElement>("editor-status");
const chkAutosave = $<HTMLInputElement>("chk-autosave");
const btnSaveMd = $<HTMLButtonElement>("btn-save-md");
const mdEditor = $<HTMLTextAreaElement>("md-editor");
const iframeWrap = $<HTMLDivElement>("iframe-wrap");

let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
let scrollSyncTimer: ReturnType<typeof setTimeout> | null = null;
let lastSyncedHash: string | null = null;
const previewIframe = $<HTMLIFrameElement>("preview-iframe");
const emptyState = $<HTMLDivElement>("empty-state");
const emptySubtitle = $<HTMLDivElement>("empty-subtitle");
const postFilter = $<HTMLInputElement>("post-filter");
const btnRefreshStopped = $<HTMLButtonElement>("btn-refresh-stopped");
const recentPostsEl = $<HTMLDivElement>("recent-posts");
const logsDrawer = $<HTMLElement>("logs-drawer");
const logsOutput = $<HTMLPreElement>("logs-output");
const btnRefreshLogs = $<HTMLButtonElement>("btn-refresh-logs");

const app = new App({ name: "Hugo Preview", version: "0.1.0" }, {});

function showBanner(message: string | null, isError = false): void {
  if (!message) {
    banner.classList.add("hidden");
    banner.textContent = "";
    return;
  }
  banner.textContent = message;
  banner.className = isError ? "banner error" : "banner";
}

function normalizePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function getActivePost(): HugoPost | undefined {
  if (!state.selectedPostPath) return undefined;
  const norm = normalizePath(state.selectedPostPath);
  return state.posts.find((p) => p.path === norm);
}

function getPreviewUrl(): string | null {
  if (!state.status?.running || !state.status.url || !state.selectedPostPath) {
    return null;
  }
  return `${state.status.url}${normalizePath(state.selectedPostPath)}`;
}

function slugifyHugoHeading(raw: string): string {
  // Strip inline markdown links [text](url), emphasis, backticks, HTML tags
  const cleaned = raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*~]/g, "")
    .replace(/\s+#+\s*$/, "")
    .trim()
    .toLowerCase();

  // Matches Goldmark's default GitHub auto-heading ID rules
  return cleaned
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function findNearestHeadingSlug(markdown: string, cursorOffset: number): string | null {
  const beforeCursor = markdown.slice(0, Math.max(0, cursorOffset));
  const lines = beforeCursor.split("\n");
  let inFrontmatter = false;
  let frontmatterDelim = "";
  let inCodeFence = false;
  const counts = new Map<string, number>();
  let lastSlug: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (i === 0 && (trimmed === "---" || trimmed === "+++")) {
      inFrontmatter = true;
      frontmatterDelim = trimmed;
      continue;
    }
    if (inFrontmatter) {
      if (trimmed === frontmatterDelim) {
        inFrontmatter = false;
      }
      continue;
    }

    if (/^(```|~~~)/.test(trimmed)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    const m = /^#{1,6}\s+(.+)$/.exec(trimmed);
    if (m) {
      const base = slugifyHugoHeading(m[1]);
      if (!base) continue;
      const seen = counts.get(base) ?? 0;
      counts.set(base, seen + 1);
      lastSlug = seen === 0 ? base : `${base}-${seen}`;
    }
  }

  return lastSlug;
}

function syncPreviewToOffset(charOffset: number, force = false): void {
  if (state.viewMode !== "split" || !state.status?.running) return;
  const baseUrl = getPreviewUrl();
  if (!baseUrl) return;

  const slug =
    charOffset <= 0
      ? null
      : findNearestHeadingSlug(mdEditor.value, charOffset);
  const nextHash = slug ? `#${slug}` : "#";
  if (!force && lastSyncedHash === nextHash && previewIframe.src.startsWith(baseUrl)) {
    return;
  }
  lastSyncedHash = nextHash;
  previewIframe.src = `${baseUrl}${nextHash}`;
}

function scheduleScrollSync(source: "cursor" | "scroll" = "cursor"): void {
  if (state.viewMode !== "split" || !state.status?.running) return;
  if (scrollSyncTimer) clearTimeout(scrollSyncTimer);
  scrollSyncTimer = setTimeout(() => {
    scrollSyncTimer = null;
    if (source === "scroll") {
      if (mdEditor.scrollTop < 24) {
        syncPreviewToOffset(0, false);
        return;
      }
      const maxScroll = Math.max(1, mdEditor.scrollHeight - mdEditor.clientHeight);
      const ratio = Math.min(1, Math.max(0, mdEditor.scrollTop / maxScroll));
      const approxOffset = Math.floor(ratio * mdEditor.value.length);
      syncPreviewToOffset(approxOffset, false);
    } else {
      syncPreviewToOffset(mdEditor.selectionStart, false);
    }
  }, 180);
}

function loadIframe(forceBust = false): void {
  const url = getPreviewUrl();
  if (!url) {
    previewIframe.src = "about:blank";
    lastSyncedHash = null;
    return;
  }
  const hash =
    state.viewMode === "split" && lastSyncedHash ? lastSyncedHash : "";
  if (forceBust) {
    const sep = url.includes("?") ? "&" : "?";
    previewIframe.src = `${url}${sep}_reload=${Date.now()}${hash}`;
  } else {
    const currentBase = previewIframe.src.split("#")[0].split("?")[0];
    if (currentBase !== url) {
      lastSyncedHash = null;
      previewIframe.src = url;
    }
  }
}

function formatDateShort(iso: string): string {
  if (!iso || iso.startsWith("0001-")) return "";
  return iso.slice(0, 10);
}

function renderPosts(): void {
  const current = state.selectedPostPath
    ? normalizePath(state.selectedPostPath)
    : null;
  postSelect.innerHTML = "";

  for (const post of state.posts) {
    const opt = document.createElement("option");
    opt.value = post.path;
    const badges: string[] = [];
    if (post.draft) badges.push("DRAFT");
    if (post.future) badges.push("FUTURE");
    const dateStr = formatDateShort(post.date);
    const suffix = [
      badges.length ? `[${badges.join("·")}]` : "",
      dateStr,
    ]
      .filter(Boolean)
      .join(" ");
    opt.textContent = suffix ? `${post.title} — ${suffix}` : post.title;
    postSelect.appendChild(opt);
  }

  if (current) {
    const hasOption = Array.from(postSelect.options).some(
      (o) => o.value === current
    );
    if (hasOption) postSelect.value = current;
  }

  // Render searchable posts list on the main page
  recentPostsEl.innerHTML = "";
  const query = (postFilter.value || "").trim().toLowerCase();
  const filteredPosts = query
    ? state.posts.filter(
        (p) =>
          p.title.toLowerCase().includes(query) ||
          p.relPath.toLowerCase().includes(query)
      )
    : state.posts;

  if (filteredPosts.length > 0) {
    const visiblePosts = query ? filteredPosts.slice(0, 30) : filteredPosts.slice(0, 10);
    const olderPosts = query ? [] : filteredPosts.slice(10);

    const heading = document.createElement("div");
    heading.className = "recent-heading";
    heading.textContent = query
      ? `Matching Posts (${filteredPosts.length})`
      : "Recent & Upcoming Posts";
    recentPostsEl.appendChild(heading);

    const openPostInPreview = async (postPath: string) => {
      state.selectedPostPath = postPath;
      state.viewMode = "preview";
      lastSyncedHash = null;
      if (!state.status?.running) {
        await startServer();
      } else {
        render();
        loadIframe(false);
      }
    };

    for (const post of visiblePosts) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "recent-item";

      const titleSpan = document.createElement("span");
      titleSpan.className = "recent-item-title";
      titleSpan.textContent = post.title;

      const metaSpan = document.createElement("span");
      metaSpan.className = "recent-item-meta";
      if (post.draft) {
        const tag = document.createElement("span");
        tag.className = "tag-badge";
        tag.textContent = "DRAFT";
        metaSpan.appendChild(tag);
      }
      if (post.future) {
        const tag = document.createElement("span");
        tag.className = "tag-badge";
        tag.textContent = "FUTURE";
        metaSpan.appendChild(tag);
      }
      const dateSpan = document.createElement("span");
      dateSpan.textContent = formatDateShort(post.date);
      metaSpan.appendChild(dateSpan);

      btn.appendChild(titleSpan);
      btn.appendChild(metaSpan);
      btn.onclick = () => void openPostInPreview(post.path);
      recentPostsEl.appendChild(btn);
    }

    if (olderPosts.length > 0) {
      const olderWrap = document.createElement("div");
      olderWrap.className = "older-posts-wrap";

      const olderHeading = document.createElement("div");
      olderHeading.className = "recent-heading";
      olderHeading.textContent = `Older Posts (${olderPosts.length})`;
      olderWrap.appendChild(olderHeading);

      const select = document.createElement("select");
      select.className = "older-posts-select";
      select.setAttribute("aria-label", "Choose an older post");

      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = `Choose an older post (${olderPosts.length} more)...`;
      select.appendChild(placeholder);

      for (const post of olderPosts) {
        const opt = document.createElement("option");
        opt.value = post.path;
        const dateStr = formatDateShort(post.date);
        opt.textContent = dateStr ? `${post.title} — ${dateStr}` : post.title;
        select.appendChild(opt);
      }

      select.onchange = () => {
        if (select.value) {
          void openPostInPreview(select.value);
        }
      };

      olderWrap.appendChild(select);
      recentPostsEl.appendChild(olderWrap);
    }
  } else if (state.posts.length > 0) {
    const emptyMsg = document.createElement("div");
    emptyMsg.className = "empty-subtitle";
    emptyMsg.textContent = `No posts matching "${postFilter.value.trim()}".`;
    recentPostsEl.appendChild(emptyMsg);
  }
}

function render(): void {
  const running = Boolean(state.status?.running);
  const managed = Boolean(state.status?.managed);
  const port = state.status?.port ?? state.config.port;

  if (state.busy) {
    statusBadge.className = "status-badge";
    statusLabel.textContent = "Working...";
  } else if (state.status?.lastError) {
    statusBadge.className = "status-badge error";
    statusLabel.textContent = running ? `Error :${port}` : "Error";
  } else if (running) {
    statusBadge.className = "status-badge running";
    statusLabel.textContent = managed ? `:${port}` : `External :${port}`;
  } else {
    statusBadge.className = "status-badge";
    statusLabel.textContent = "Stopped";
  }

  btnStartStop.disabled = state.busy || (running && !managed);
  btnStartStop.textContent = running ? "Stop" : "Start";
  btnStartStop.title =
    running && !managed
      ? "Hugo was started outside this app and cannot be stopped here"
      : running
        ? "Stop Hugo server"
        : "Start Hugo server";

  // If server is stopped (and not currently starting), return to the main posts list
  if (!running && !state.busy) {
    state.selectedPostPath = null;
    state.viewMode = "preview";
  }

  const viewingPost = running && Boolean(state.selectedPostPath);

  // Show post-specific controls only when viewing a post
  runningBar.classList.toggle("hidden", !viewingPost);
  btnReload.classList.toggle("hidden", !viewingPost);
  btnReload.disabled = !viewingPost || state.busy;
  btnMobile.classList.toggle("hidden", !viewingPost);
  btnOpenBrowser.classList.toggle("hidden", !viewingPost || !state.canOpenLinks);
  btnOpenBrowser.disabled = !viewingPost || !state.canOpenLinks;

  const activePost = getActivePost();

  // View mode buttons
  btnModePreview.classList.toggle("active", state.viewMode === "preview");
  btnModeSplit.classList.toggle("active", state.viewMode === "split");
  btnModeSplit.disabled = !viewingPost || !activePost;

  const showEditor = viewingPost && Boolean(activePost) && state.viewMode === "split";

  editorPane.classList.toggle("hidden", !showEditor);
  editorFilename.textContent = activePost
    ? activePost.relPath
    : "Select a post to edit";
  editorStatus.textContent = state.editorStatusText;
  editorStatus.className = state.editorDirty
    ? "editor-status dirty"
    : state.editorStatusText.startsWith("Saved")
      ? "editor-status saved"
      : "editor-status";
  btnSaveMd.disabled = !state.editorFilePath || !state.editorDirty || state.editorSaving;
  chkAutosave.checked = state.autoSave;

  chkDrafts.checked = state.config.buildDrafts;
  chkFuture.checked = state.config.buildFuture;
  inputSiteDir.value = state.config.siteDir;
  inputPort.value = String(state.config.port);

  btnMobile.classList.toggle("active", state.mobile);
  iframeWrap.classList.toggle("mobile", state.mobile);
  btnLogs.classList.toggle("active", state.logsOpen);
  logsDrawer.classList.toggle("hidden", !state.logsOpen);
  btnSettings.classList.toggle("active", state.settingsOpen);
  settingsPanel.classList.toggle("hidden", !state.settingsOpen);

  iframeWrap.classList.toggle("hidden", !viewingPost);
  emptyState.classList.toggle("hidden", viewingPost);

  emptySubtitle.textContent = running
    ? `Server running on :${port} — click a post to preview`
    : `Click a post to start & preview, or click Start above (${state.config.siteDir})`;

  renderPosts();
  if (viewingPost) {
    loadIframe(false);
  }
}

function applyPayload(payload?: ToolPayload): void {
  if (!payload) return;
  if (payload.config) {
    state.config = { ...state.config, ...payload.config };
  }
  if (payload.status) {
    state.status = payload.status;
  }
  if (payload.posts) {
    state.posts = payload.posts;
  }
  if (payload.activePath && payload.activePath !== "/") {
    state.selectedPostPath = normalizePath(payload.activePath);
  }
  if (payload.postsError) {
    showBanner(`Could not list posts: ${payload.postsError}`, true);
  } else if (payload.status?.lastError) {
    showBanner(`Hugo build error: ${payload.status.lastError}`, true);
  } else {
    showBanner(null);
  }
  render();
}

async function callTool<T = ToolPayload>(
  name: string,
  args: Record<string, unknown> = {}
): Promise<T | null> {
  try {
    const res = await app.callServerTool({ name, arguments: args });
    if (res.isError) {
      const msg =
        res.content?.[0]?.type === "text"
          ? res.content[0].text
          : `Tool ${name} failed`;
      showBanner(msg, true);
      return null;
    }
    return (res.structuredContent as T) ?? null;
  } catch (err) {
    showBanner(err instanceof Error ? err.message : String(err), true);
    return null;
  }
}

async function startServer(): Promise<void> {
  state.busy = true;
  showBanner(null);
  render();
  const payload = await callTool("hugo_start", {
    siteDir: state.config.siteDir,
    port: state.config.port,
    buildDrafts: state.config.buildDrafts,
    buildFuture: state.config.buildFuture,
  });
  state.busy = false;
  if (payload) {
    applyPayload(payload);
    loadIframe(true);
    if (state.logsOpen) await refreshLogs();
  } else {
    render();
  }
}

async function stopServer(): Promise<void> {
  if (state.editorDirty && state.editorFilePath && state.autoSave) {
    await saveEditor();
  }
  state.busy = true;
  state.selectedPostPath = null;
  state.viewMode = "preview";
  lastSyncedHash = null;
  render();
  const payload = await callTool("hugo_stop", {});
  state.busy = false;
  if (payload) {
    applyPayload(payload);
    if (state.logsOpen) await refreshLogs();
  } else {
    render();
  }
}

async function refreshLogs(): Promise<void> {
  const data = await callTool<{ logs?: string[]; lastError?: string | null }>(
    "hugo_get_logs",
    {}
  );
  if (data?.logs) {
    logsOutput.textContent =
      data.logs.length > 0 ? data.logs.join("\n") : "No logs yet.";
    logsOutput.scrollTop = logsOutput.scrollHeight;
  }
}

async function refreshPosts(): Promise<void> {
  const data = await callTool<{ posts?: HugoPost[] }>("hugo_list_posts", {
    siteDir: state.config.siteDir,
    limit: 500,
  });
  if (data?.posts) {
    state.posts = data.posts;
    render();
  }
}

async function loadEditorForActivePost(force = false): Promise<void> {
  const post = getActivePost();
  if (!post) {
    state.editorFilePath = null;
    state.editorDirty = false;
    state.editorStatusText = "";
    mdEditor.value = "";
    render();
    return;
  }

  if (!force && state.editorFilePath === post.filePath) {
    render();
    return;
  }

  // Flush any pending unsaved edits on the previous file before switching
  if (state.editorDirty && state.editorFilePath && state.autoSave) {
    await saveEditor();
  }

  state.editorStatusText = "Loading...";
  render();
  const data = await callTool<{ filePath?: string; content?: string }>(
    "hugo_read_post",
    { filePath: post.filePath }
  );
  if (data && typeof data.content === "string") {
    state.editorFilePath = data.filePath || post.filePath;
    mdEditor.value = data.content;
    state.editorDirty = false;
    state.editorStatusText = "";
  } else {
    state.editorStatusText = "Load failed";
  }
  render();
}

async function saveEditor(): Promise<void> {
  if (!state.editorFilePath || state.editorSaving) return;
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  state.editorSaving = true;
  state.editorStatusText = "Saving...";
  render();

  const res = await callTool<{ savedAt?: string }>("hugo_write_post", {
    filePath: state.editorFilePath,
    content: mdEditor.value,
  });
  state.editorSaving = false;
  if (res) {
    state.editorDirty = false;
    const t = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    state.editorStatusText = `Saved ${t}`;
  } else {
    state.editorStatusText = "Save failed";
  }
  render();
}

async function setViewMode(mode: ViewMode): Promise<void> {
  if (mode !== "preview" && !getActivePost()) return;
  state.viewMode = mode;
  render();
  if (mode !== "preview") {
    await loadEditorForActivePost(false);
  }
}

// Event Listeners
btnStartStop.onclick = () => {
  if (state.status?.running) {
    void stopServer();
  } else {
    void startServer();
  }
};

btnReload.onclick = () => loadIframe(true);

const onFlagChange = async () => {
  state.config.buildDrafts = chkDrafts.checked;
  state.config.buildFuture = chkFuture.checked;
  if (state.status?.running && state.status.managed) {
    await startServer();
  } else {
    const payload = await callTool("hugo_save_config", {
      buildDrafts: state.config.buildDrafts,
      buildFuture: state.config.buildFuture,
    });
    if (payload) applyPayload(payload);
  }
};
chkDrafts.onchange = () => void onFlagChange();
chkFuture.onchange = () => void onFlagChange();

btnMobile.onclick = () => {
  state.mobile = !state.mobile;
  render();
};

btnOpenBrowser.onclick = async () => {
  const url = getPreviewUrl();
  if (url && state.canOpenLinks) {
    await app.openLink({ url });
  }
};

btnLogs.onclick = async () => {
  state.logsOpen = !state.logsOpen;
  render();
  if (state.logsOpen) {
    await refreshLogs();
  }
};

btnRefreshLogs.onclick = () => void refreshLogs();

btnSettings.onclick = () => {
  state.settingsOpen = !state.settingsOpen;
  render();
};

btnSaveSettings.onclick = async () => {
  const nextDir = inputSiteDir.value.trim();
  const nextPort = Math.min(1320, Math.max(1313, Number(inputPort.value) || 1313));
  state.config.siteDir = nextDir || state.config.siteDir;
  state.config.port = nextPort;
  state.settingsOpen = false;

  if (state.status?.running && state.status.managed) {
    await startServer();
  } else {
    const payload = await callTool("hugo_save_config", {
      siteDir: state.config.siteDir,
      port: state.config.port,
    });
    if (payload) applyPayload(payload);
  }
};

btnBackPosts.onclick = async () => {
  if (state.editorDirty && state.editorFilePath && state.autoSave) {
    await saveEditor();
  }
  state.selectedPostPath = null;
  state.viewMode = "preview";
  lastSyncedHash = null;
  render();
};

postSelect.onchange = () => {
  state.selectedPostPath = normalizePath(postSelect.value);
  lastSyncedHash = null;
  if (!getActivePost() && state.viewMode !== "preview") {
    state.viewMode = "preview";
  }
  render();
  if (state.status?.running) loadIframe(false);
  if (state.viewMode === "split") void loadEditorForActivePost(false);
};

btnRefreshPosts.onclick = () => void refreshPosts();
btnRefreshStopped.onclick = () => void refreshPosts();
postFilter.oninput = () => renderPosts();

btnModePreview.onclick = () => void setViewMode("preview");
btnModeSplit.onclick = () => void setViewMode("split");

btnSaveMd.onclick = () => void saveEditor();
chkAutosave.onchange = () => {
  state.autoSave = chkAutosave.checked;
  if (state.autoSave && state.editorDirty) {
    void saveEditor();
  }
};

mdEditor.oninput = () => {
  state.editorDirty = true;
  state.editorStatusText = "Unsaved";
  btnSaveMd.disabled = !state.editorFilePath || state.editorSaving;
  editorStatus.textContent = state.editorStatusText;
  editorStatus.className = "editor-status dirty";

  scheduleScrollSync("cursor");

  if (state.autoSave) {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = null;
      void saveEditor();
    }, 1000);
  }
};

mdEditor.onclick = () => scheduleScrollSync("cursor");
mdEditor.onkeyup = () => scheduleScrollSync("cursor");
mdEditor.onscroll = () => scheduleScrollSync("scroll");

mdEditor.onkeydown = (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    void saveEditor();
    return;
  }
  if (e.key === "Tab") {
    e.preventDefault();
    const start = mdEditor.selectionStart;
    const end = mdEditor.selectionEnd;
    mdEditor.setRangeText("  ", start, end, "end");
    mdEditor.dispatchEvent(new Event("input"));
  }
};

// Register MCP App handlers BEFORE connect()
app.ontoolinput = ({ arguments: args }) => {
  const a = args as { path?: string } | undefined;
  if (a?.path && a.path !== "/") {
    state.selectedPostPath = normalizePath(a.path);
  }
};

app.ontoolresult = (result) => {
  applyPayload(result.structuredContent as ToolPayload | undefined);
};

app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
};

async function init(): Promise<void> {
  await app.connect();
  const ctx = app.getHostContext();
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);

  const caps = app.getHostCapabilities();
  state.canUpdateContext = Boolean(caps?.updateModelContext);
  state.canOpenLinks = Boolean(caps?.openLinks);
  render();
}

init().catch((err) => {
  showBanner(`Failed to connect MCP App: ${err instanceof Error ? err.message : String(err)}`, true);
});
