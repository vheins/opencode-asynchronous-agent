// @bun
// src/tui.tsx
import { effect as _$effect } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { useTerminalDimensions } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";

// src/model.ts
function activityDetail(tool) {
  const input = tool.state.input;
  const clean = (value) => typeof value === "string" ? value.split("").map((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159 ? " " : char).join("").replace(/(?:Bearer\s+\S+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+)/gi, "[disamarkan]").replace(/\s+/g, " ").trim().slice(0, 120) : "";
  const labels = { read: "Membaca berkas", edit: "Mengubah berkas", write: "Menulis berkas", glob: "Mencari berkas", grep: "Menelusuri kode", search: "Mencari informasi", bash: "Menjalankan perintah", task: "Delegasi agent", subagent: "Delegasi agent" };
  const action = labels[tool.tool] ?? clean(tool.tool);
  const target = clean(input.description) || clean(input.filePath ?? input.file_path ?? input.path) || clean(input.title);
  const status = { pending: "Antre", running: "Berjalan", completed: "Selesai", error: "Gagal" }[tool.state.status];
  const background = tool.state.status === "completed" && tool.state.metadata.background === true;
  const duration = tool.state.status === "completed" || tool.state.status === "error" ? ` \xB7 ${Math.max(0, (tool.state.time.end - tool.state.time.start) / 1000).toFixed(1)} dtk` : "";
  const result = tool.state.status === "error" ? "Periksa detail kegagalan di percakapan." : background ? "Peluncuran selesai; status anak dipantau terpisah." : tool.state.status === "completed" ? `Tool selesai${duration}.` : "";
  return { action, target, status: background ? "Diluncurkan" : status, result };
}
function sessionMetrics(api, id) {
  const messages = api.state.session.messages(id);
  const latest = [...messages].reverse().find((message) => message.role === "assistant");
  const model = latest?.role === "assistant" ? latest.modelID : undefined;
  const provider = latest?.role === "assistant" ? latest.providerID : undefined;
  const reported = [...messages].reverse().find((message) => message.role === "assistant" && message.modelID === model && message.providerID === provider && [message.tokens.input, message.tokens.output, message.tokens.reasoning, message.tokens.cache.read, message.tokens.cache.write].some((value) => Number.isFinite(value) && value > 0));
  const tokens = reported?.role === "assistant" ? reported.tokens : undefined;
  const used = tokens ? [tokens.input, tokens.output, tokens.reasoning, tokens.cache.read, tokens.cache.write].reduce((sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 0), 0) : undefined;
  const limit = api.state.provider.find((item) => item.id === provider)?.models[model ?? ""]?.limit.context;
  return {
    model: model ?? "Menunggu respons",
    provider: provider ?? "Belum ada penggunaan",
    agent: latest?.role === "assistant" ? latest.agent : undefined,
    used,
    percent: used !== undefined && limit && limit > 0 ? Math.round(used / limit * 100) : undefined,
    cost: messages.reduce((total, message) => total + (message.role === "assistant" ? message.cost : 0), 0)
  };
}
function sidebarActivity(api, id) {
  const tools = api.state.session.messages(id).flatMap((message) => api.state.part(message.id).filter((part) => part.type === "tool"));
  const servers = [...api.state.mcp()].sort((a, b) => b.name.length - a.name.length);
  const active = tools.filter((tool) => tool.state.status === "running" || tool.state.status === "pending");
  const mcpName = (name) => servers.find((server) => {
    const key = server.name.replace(/[^a-zA-Z0-9_-]/g, "_");
    return [server.name, key].some((prefix) => name.startsWith(`${prefix}_`) || name.startsWith(`${prefix}-`));
  })?.name;
  const mcp = servers.flatMap((server) => {
    const calls = active.filter((tool) => mcpName(tool.tool) === server.name);
    return calls.length ? [{ name: server.name, calls }] : [];
  });
  const agents = tools.filter((tool) => tool.tool === "task" || tool.tool === "subagent").flatMap((tool) => {
    const metadata = tool.state.status === "pending" ? undefined : tool.state.metadata;
    const child = typeof metadata?.sessionId === "string" ? metadata.sessionId : undefined;
    const status = child ? api.state.session.status(child) : undefined;
    const waiting = child ? api.state.session.permission(child).length + api.state.session.question(child).length : 0;
    const running = status ? status.type !== "idle" : tool.state.status === "running" || tool.state.status === "pending";
    if (!running && !waiting)
      return [];
    return [{
      id: child ?? tool.callID,
      name: typeof tool.state.input.subagent_type === "string" ? tool.state.input.subagent_type : "subagent",
      label: waiting ? "Menunggu jawaban" : status?.type === "retry" ? "Mencoba ulang" : "Bekerja",
      target: activityDetail(tool).target
    }];
  }).filter((agent, index, list) => list.findIndex((item) => item.id === agent.id) === index);
  const todos = api.state.session.todo(id);
  return {
    mcp,
    latest: tools.at(-1),
    current: active.at(-1),
    agents,
    tools: active.filter((tool) => !mcpName(tool.tool) && tool.tool !== "task" && tool.tool !== "subagent"),
    todos: todos.filter((todo) => todo.status === "in_progress" || todo.status === "pending").sort((a, b) => Number(b.status === "in_progress") - Number(a.status === "in_progress")),
    completed: todos.filter((todo) => todo.status === "completed").length,
    total: todos.length,
    attention: api.state.session.permission(id).length + api.state.session.question(id).length,
    status: api.state.session.status(id)
  };
}

// src/subagent.ts
function subagentDetails(session, messages, todos) {
  const assistant = [...messages].reverse().find((entry) => entry.info.role === "assistant")?.info;
  const tools = messages.flatMap((entry) => entry.parts.filter((part) => part.type === "tool"));
  const current = [...tools].reverse().find((part) => part.state.status === "running" || part.state.status === "pending");
  const latest = current ?? tools.at(-1);
  return {
    model: assistant?.role === "assistant" ? `${assistant.providerID} / ${assistant.modelID}` : session?.model ? `${session.model.providerID} / ${session.model.id}` : "Model belum dilaporkan",
    started: session?.time.created,
    activity: latest ? activityDetail(latest) : undefined,
    current: Boolean(current),
    todos,
    completed: todos.filter((todo) => todo.status === "completed").length
  };
}
async function fetchSubagent(api, sessionID, signal) {
  const params = { sessionID, directory: api.state.path.directory };
  const [session, messages, todos] = await Promise.all([
    api.client.session.get(params, { signal }),
    api.client.session.messages({ ...params, limit: 30 }, { signal }),
    api.client.session.todo(params, { signal })
  ]);
  if (session.error || messages.error || todos.error)
    throw new Error("Detail subagent belum tersedia dari host");
  return subagentDetails(session.data, messages.data ?? [], todos.data ?? []);
}
function elapsedLabel(start, now) {
  if (start === undefined || !Number.isFinite(start) || start <= 0)
    return "Durasi belum tersedia";
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return hours ? `${hours}j ${minutes}m ${seconds % 60}d` : `${minutes}m ${seconds % 60}d`;
}

// src/workspace.ts
import { readdir } from "fs/promises";
import { join, relative } from "path";
var ignored = new Set(["node_modules", ".git", ".next", ".cache", "vendor", "dist", "build", ".venv", "Pods"]);
async function inspectWorkspace(root, signal) {
  const repos = [];
  const queue = [{ path: root, depth: 0 }];
  let visited = 0;
  let depthLimited = false;
  const errors = [];
  while (queue.length && visited < 300) {
    signal?.throwIfAborted();
    const current = queue.shift();
    visited++;
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      errors.push(`Tidak dapat membaca ${relative(root, current.path) || "."}`);
      continue;
    }
    if (entries.some((entry) => entry.name === ".git")) {
      const child = Bun.spawn(["git", "-C", current.path, "status", "--porcelain=v1", "-z", "--branch", "--untracked-files=normal"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
      const abort = () => {
        child.kill();
      };
      signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => child.kill(), 5000);
      try {
        const [output, , exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        const records = output.split("\x00");
        const branch = records.shift()?.replace(/^## /, "") ?? "";
        const files = [];
        for (let i = 0;i < records.length; i++) {
          const record = records[i];
          if (!record)
            continue;
          files.push({ status: record.slice(0, 2), path: record.slice(3) });
          if (/[RC]/.test(record.slice(0, 2)))
            i++;
        }
        repos.push({ path: relative(root, current.path) || ".", branch, files, ...exit !== 0 ? { error: "Git tidak tersedia, gagal, atau melewati batas waktu" } : {} });
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      }
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && !ignored.has(entry.name) && !entry.name.startsWith(".")) {
        if (current.depth < 4)
          queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
        else
          depthLimited = true;
      }
    }
  }
  return { repos, errors, limited: queue.length > 0 || depthLimited, visited };
}

// src/tui.tsx
function retainActivity(source, key, session, delay = 4000) {
  const [rows, setRows] = createSignal([]);
  let scope = session();
  createEffect(() => {
    const id = session();
    const items = source();
    const now = Date.now();
    const previous = id === scope ? untrack(rows) : [];
    scope = id;
    const keys = new Set(items.map(key));
    setRows([...items.map((item) => ({
      item
    })), ...previous.filter((row) => !keys.has(key(row.item))).map((row) => ({
      ...row,
      ended: row.ended ?? now
    })).filter((row) => now - row.ended < delay)]);
  });
  createEffect(() => {
    const deadlines = rows().flatMap((row) => row.ended === undefined ? [] : [row.ended + delay]);
    if (!deadlines.length)
      return;
    const timer = setTimeout(() => setRows((previous) => previous.filter((row) => row.ended === undefined || Date.now() < row.ended + delay)), Math.max(0, Math.min(...deadlines) - Date.now()));
    onCleanup(() => clearTimeout(timer));
  });
  return rows;
}
function compact(value) {
  if (!Number.isFinite(value) || value < 0)
    return "\u2014";
  return Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value);
}
function durationLabel(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return hours ? `${hours}j ${minutes}m ${seconds % 60}d` : `${minutes}m ${seconds % 60}d`;
}
function childTokens(api, childID) {
  const latest = [...api.state.session.messages(childID)].reverse().find((message) => message.role === "assistant");
  if (!latest || latest.role !== "assistant")
    return;
  const tokens = latest.tokens;
  const total = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write;
  return total > 0 ? total : undefined;
}
function asyncIdentity(api, id) {
  const now = Date.now();
  const tools = api.state.session.messages(id).flatMap((message) => api.state.part(message.id)).filter((part) => part.type === "tool").filter((part) => part.tool === "task" || part.tool === "subagent");
  const rows = tools.map((part) => {
    const state = part.state;
    const child = state.status === "pending" ? undefined : typeof state.metadata?.sessionId === "string" ? state.metadata.sessionId : undefined;
    const status = state.status === "completed" ? "done" : state.status === "error" ? "error" : "running";
    const started = state.status === "pending" ? undefined : state.time.start;
    const ended = state.status === "completed" || state.status === "error" ? state.time.end : undefined;
    const elapsedMs = started === undefined ? 0 : Math.max(0, (ended ?? now) - started);
    const tokens = child ? childTokens(api, child) : undefined;
    const seconds = elapsedMs / 1000;
    return {
      id: child ?? part.callID,
      label: activityDetail(part).target || part.tool,
      status,
      elapsedMs,
      tokens,
      tokensPerSecond: tokens !== undefined && seconds > 0 ? tokens / seconds : undefined
    };
  });
  return {
    rows,
    running: rows.filter((row) => row.status === "running").length,
    done: rows.filter((row) => row.status === "done").length,
    error: rows.filter((row) => row.status === "error").length,
    total: rows.length
  };
}
function subagentToasts(api) {
  const raw = String(process.env.OPENCODE_SUBAGENT_NOTIFY ?? "1").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no")
    return;
  if (!api?.ui?.toast)
    return;
  const previous = new Map;
  const off = api.event.on("message.part.updated", ({
    properties
  }) => {
    const part = properties.part;
    if (part.type !== "tool" || part.tool !== "task" && part.tool !== "subagent")
      return;
    const status = part.state.status;
    const last = previous.get(part.callID);
    previous.set(part.callID, status);
    if (last === undefined || last === status)
      return;
    if (status !== "completed" && status !== "error")
      return;
    const label = String(activityDetail(part).target || part.tool).replace(/\s+/g, " ").trim().slice(0, 60);
    const ok = status === "completed";
    try {
      api.ui.toast({
        variant: ok ? "success" : "error",
        title: ok ? "Subagent selesai" : "Subagent gagal",
        message: label,
        duration: ok ? 4000 : 6000
      });
    } catch {}
  });
  api.lifecycle.onDispose(() => {
    off();
    previous.clear();
  });
}
function InfoCard(props) {
  const [open, setOpen] = createSignal(props.api.kv.get(`studio.card.${props.name}`, props.initialOpen ?? false));
  const theme = () => props.api.theme.current;
  createEffect(() => props.onOpen?.(open()));
  const toggle = () => {
    const next = !open();
    setOpen(next);
    props.api.kv.set(`studio.card.${props.name}`, next);
  };
  const unregister = props.api.command?.register(() => [{
    title: `Studio: ${open() ? "tutup" : "buka"} ${props.title}`,
    value: `studio.card.${props.name}`,
    category: "Studio",
    slash: {
      name: `studio-${props.name}`
    },
    onSelect: (dialog) => {
      toggle();
      dialog?.clear();
    }
  }]);
  if (unregister)
    onCleanup(unregister);
  return (() => {
    var _el$ = _$createElement("box"), _el$2 = _$createElement("box"), _el$3 = _$createElement("text"), _el$4 = _$createElement("b"), _el$5 = _$createTextNode(` `), _el$6 = _$createElement("text");
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "paddingLeft", 1);
    _$setProp(_el$, "paddingRight", 1);
    _$insertNode(_el$2, _el$3);
    _$insertNode(_el$2, _el$6);
    _$setProp(_el$2, "onMouseDown", (event) => {
      if (event.button === 0) {
        event.stopPropagation();
        toggle();
      }
    });
    _$insertNode(_el$3, _el$4);
    _$insertNode(_el$4, _el$5);
    _$insert(_el$4, () => open() ? "\u25BE" : "\u25B8", _el$5);
    _$insert(_el$4, () => props.title, null);
    _$setProp(_el$6, "wrapMode", "word");
    _$insert(_el$6, () => props.summary);
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return open();
      },
      get children() {
        var _el$7 = _$createElement("box");
        _$setProp(_el$7, "paddingTop", 1);
        _$setProp(_el$7, "paddingBottom", 1);
        _$insert(_el$7, () => props.children);
        return _el$7;
      }
    }), null);
    _$effect((_p$) => {
      var _v$ = theme().backgroundElement, _v$2 = theme().primary, _v$3 = theme().textMuted;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$, "backgroundColor", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$3, "fg", _v$2, _p$.t));
      _v$3 !== _p$.a && (_p$.a = _$setProp(_el$6, "fg", _v$3, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$;
  })();
}
function SubagentCard(props) {
  const [data, setData] = createSignal();
  const [error, setError] = createSignal("");
  const [now, setNow] = createSignal(Date.now());
  const theme = () => props.api.theme.current;
  createEffect(() => {
    const id = props.agent.id;
    const ended = props.ended;
    const controller = new AbortController;
    let pending = false;
    setData(undefined);
    setError("");
    const refresh = async () => {
      if (pending)
        return;
      pending = true;
      try {
        const next = await fetchSubagent(props.api, id, controller.signal);
        if (!controller.signal.aborted) {
          setData(next);
          setError("");
        }
      } catch {
        if (!controller.signal.aborted)
          setError("Detail belum tersedia; mencoba lagi.");
      } finally {
        pending = false;
      }
    };
    refresh();
    const poll = ended ? undefined : setInterval(() => void refresh(), 5000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => {
      controller.abort();
      clearInterval(poll);
      clearInterval(clock);
    });
  });
  return _$createComponent(InfoCard, {
    get api() {
      return props.api;
    },
    get name() {
      return `agent-${props.agent.id}`;
    },
    get title() {
      return `${props.agent.name} \xB7 ${props.ended ? "Baru berakhir" : props.agent.label}`;
    },
    get summary() {
      return `${data()?.model ?? "Memuat model\u2026"}
${elapsedLabel(data()?.started, props.ended ?? now())} sejak sesi dibuat`;
    },
    get children() {
      return [_$createComponent(Show, {
        get when() {
          return props.agent.target;
        },
        get children() {
          var _el$8 = _$createElement("text");
          _$setProp(_el$8, "wrapMode", "word");
          _$insert(_el$8, () => props.agent.target);
          _$effect((_$p) => _$setProp(_el$8, "fg", theme().text, _$p));
          return _el$8;
        }
      }), _$createComponent(Show, {
        get when() {
          return error();
        },
        get children() {
          var _el$9 = _$createElement("text");
          _$insert(_el$9, error);
          _$effect((_$p) => _$setProp(_el$9, "fg", theme().warning, _$p));
          return _el$9;
        }
      }), _$createComponent(Show, {
        get when() {
          return data();
        },
        children: (detail) => (() => {
          var _el$0 = _$createElement("box"), _el$1 = _$createElement("text"), _el$11 = _$createElement("text");
          _$insertNode(_el$0, _el$1);
          _$insertNode(_el$0, _el$11);
          _$setProp(_el$0, "gap", 1);
          _$setProp(_el$1, "wrapMode", "word");
          _$insert(_el$1, (() => {
            var _c$ = _$memo(() => !!detail().activity);
            return () => _c$() ? `${detail().current ? "Sekarang" : "Terakhir"} \xB7 ${detail().activity.action} \xB7 ${detail().activity.status}` : "Aktivitas tool belum dilaporkan.";
          })());
          _$insert(_el$0, _$createComponent(Show, {
            get when() {
              return detail().activity?.target;
            },
            get children() {
              var _el$10 = _$createElement("text");
              _$setProp(_el$10, "wrapMode", "char");
              _$insert(_el$10, () => detail().activity?.target);
              _$effect((_$p) => _$setProp(_el$10, "fg", theme().textMuted, _$p));
              return _el$10;
            }
          }), _el$11);
          _$insert(_el$11, (() => {
            var _c$2 = _$memo(() => !!detail().todos.length);
            return () => _c$2() ? `${detail().completed}/${detail().todos.length} tugas selesai` : "Progres tugas belum dilaporkan.";
          })());
          _$insert(_el$0, _$createComponent(For, {
            get each() {
              return detail().todos;
            },
            children: (todo) => (() => {
              var _el$12 = _$createElement("text"), _el$13 = _$createTextNode(` `);
              _$insertNode(_el$12, _el$13);
              _$setProp(_el$12, "wrapMode", "word");
              _$insert(_el$12, (() => {
                var _c$3 = _$memo(() => todo.status === "completed");
                return () => _c$3() ? "\u2713" : todo.status === "in_progress" ? "\u203A" : "\xB7";
              })(), _el$13);
              _$insert(_el$12, () => todo.content, null);
              _$effect((_$p) => _$setProp(_el$12, "fg", todo.status === "in_progress" ? theme().text : theme().textMuted, _$p));
              return _el$12;
            })()
          }), null);
          _$effect((_p$) => {
            var _v$4 = theme().text, _v$5 = theme().textMuted;
            _v$4 !== _p$.e && (_p$.e = _$setProp(_el$1, "fg", _v$4, _p$.e));
            _v$5 !== _p$.t && (_p$.t = _$setProp(_el$11, "fg", _v$5, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$0;
        })()
      })];
    }
  });
}
function WorkspaceCard(props) {
  const [open, setOpen] = createSignal(false);
  const [data, setData] = createSignal();
  const [error, setError] = createSignal("");
  const theme = () => props.api.theme.current;
  createEffect(() => {
    const root = props.api.state.path.directory;
    setData(undefined);
    setError("");
    if (!open())
      return;
    const controller = new AbortController;
    let pending = false;
    const refresh = async () => {
      if (pending)
        return;
      pending = true;
      try {
        const next = await inspectWorkspace(root, controller.signal);
        if (!controller.signal.aborted) {
          setData(next);
          setError("");
        }
      } catch {
        if (!controller.signal.aborted)
          setError("Pemindaian Git gagal. Periksa akses folder dan instalasi Git.");
      } finally {
        pending = false;
      }
    };
    refresh();
    const timer = setInterval(() => void refresh(), 15000);
    onCleanup(() => {
      controller.abort();
      clearInterval(timer);
    });
  });
  return _$createComponent(InfoCard, {
    get api() {
      return props.api;
    },
    name: "files",
    title: "Ruang kerja & berkas",
    onOpen: setOpen,
    get summary() {
      return error() || (data() ? `${data().repos.length} repo Git \xB7 ${data().repos.reduce((n, repo) => n + repo.files.length, 0)} entri berubah` : open() ? "Memindai repositori\u2026" : "Buka untuk memindai repo root dan subfolder");
    },
    get children() {
      return [(() => {
        var _el$14 = _$createElement("text");
        _$setProp(_el$14, "wrapMode", "char");
        _$insert(_el$14, () => props.api.state.path.directory);
        _$effect((_$p) => _$setProp(_el$14, "fg", theme().textMuted, _$p));
        return _el$14;
      })(), (() => {
        var _el$15 = _$createElement("text");
        _$insertNode(_el$15, _$createTextNode(`Git lokal, bukan hanya perubahan sesi \xB7 refresh 15 dtk`));
        _$effect((_$p) => _$setProp(_el$15, "fg", theme().textMuted, _$p));
        return _el$15;
      })(), _$createComponent(Show, {
        get when() {
          return data();
        },
        children: (scan) => (() => {
          var _el$19 = _$createElement("box");
          _$setProp(_el$19, "gap", 1);
          _$insert(_el$19, _$createComponent(For, {
            get each() {
              return scan().repos;
            },
            get fallback() {
              return (() => {
                var _el$22 = _$createElement("text");
                _$insertNode(_el$22, _$createTextNode(`Tidak ditemukan repo Git dalam cakupan pemindaian.`));
                _$effect((_$p) => _$setProp(_el$22, "fg", theme().textMuted, _$p));
                return _el$22;
              })();
            },
            children: (repo) => (() => {
              var _el$24 = _$createElement("box"), _el$25 = _$createElement("text"), _el$26 = _$createElement("b"), _el$27 = _$createTextNode(` \xB7 `);
              _$insertNode(_el$24, _el$25);
              _$insertNode(_el$25, _el$26);
              _$insertNode(_el$25, _el$27);
              _$setProp(_el$25, "wrapMode", "char");
              _$insert(_el$26, () => repo.path);
              _$insert(_el$25, () => repo.branch, null);
              _$insert(_el$24, _$createComponent(Show, {
                get when() {
                  return repo.error;
                },
                get fallback() {
                  return (() => {
                    var _el$29 = _$createElement("text");
                    _$insert(_el$29, (() => {
                      var _c$4 = _$memo(() => !!repo.files.length);
                      return () => _c$4() ? `${repo.files.length} entri berubah` : "Working tree bersih";
                    })());
                    _$effect((_$p) => _$setProp(_el$29, "fg", theme().textMuted, _$p));
                    return _el$29;
                  })();
                },
                get children() {
                  var _el$28 = _$createElement("text");
                  _$insert(_el$28, () => repo.error);
                  _$effect((_$p) => _$setProp(_el$28, "fg", theme().warning, _$p));
                  return _el$28;
                }
              }), null);
              _$insert(_el$24, _$createComponent(For, {
                get each() {
                  return repo.files;
                },
                children: (file) => (() => {
                  var _el$30 = _$createElement("text"), _el$31 = _$createTextNode(` `);
                  _$insertNode(_el$30, _el$31);
                  _$setProp(_el$30, "wrapMode", "char");
                  _$insert(_el$30, () => file.status, _el$31);
                  _$insert(_el$30, () => file.path, null);
                  _$effect((_$p) => _$setProp(_el$30, "fg", theme().text, _$p));
                  return _el$30;
                })()
              }), null);
              _$effect((_$p) => _$setProp(_el$25, "fg", theme().primary, _$p));
              return _el$24;
            })()
          }), null);
          _$insert(_el$19, _$createComponent(For, {
            get each() {
              return scan().errors;
            },
            children: (message) => (() => {
              var _el$32 = _$createElement("text");
              _$insert(_el$32, message);
              _$effect((_$p) => _$setProp(_el$32, "fg", theme().warning, _$p));
              return _el$32;
            })()
          }), null);
          _$insert(_el$19, _$createComponent(Show, {
            get when() {
              return scan().limited;
            },
            get children() {
              var _el$20 = _$createElement("text");
              _$insertNode(_el$20, _$createTextNode(`Cakupan dibatasi 4 tingkat / 300 folder.`));
              _$effect((_$p) => _$setProp(_el$20, "fg", theme().warning, _$p));
              return _el$20;
            }
          }), null);
          return _el$19;
        })()
      }), (() => {
        var _el$17 = _$createElement("text"), _el$18 = _$createTextNode(` berkas tercatat terpisah oleh sesi OpenCode.`);
        _$insertNode(_el$17, _el$18);
        _$insert(_el$17, () => props.api.state.session.diff(props.id).length, _el$18);
        _$effect((_$p) => _$setProp(_el$17, "fg", theme().textMuted, _$p));
        return _el$17;
      })()];
    }
  });
}
function AsyncIdentity(props) {
  const theme = () => props.api.theme.current;
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  const data = createMemo(() => asyncIdentity(props.api, props.id));
  return (() => {
    var _el$33 = _$createElement("box"), _el$34 = _$createElement("text"), _el$35 = _$createElement("b"), _el$36 = _$createTextNode(`Subagents `), _el$37 = _$createElement("text"), _el$38 = _$createTextNode(`\u25CF `), _el$39 = _$createTextNode(` run \xB7 \u2713 `), _el$40 = _$createTextNode(` done \xB7 \u2715 `), _el$41 = _$createTextNode(` err \xB7 \u03A3 `);
    _$insertNode(_el$33, _el$34);
    _$insertNode(_el$33, _el$37);
    _$setProp(_el$33, "paddingLeft", 1);
    _$setProp(_el$33, "paddingRight", 1);
    _$insertNode(_el$34, _el$35);
    _$insertNode(_el$35, _el$36);
    _$insert(_el$35, () => data().total, null);
    _$insertNode(_el$37, _el$38);
    _$insertNode(_el$37, _el$39);
    _$insertNode(_el$37, _el$40);
    _$insertNode(_el$37, _el$41);
    _$insert(_el$37, () => data().running, _el$39);
    _$insert(_el$37, () => data().done, _el$40);
    _$insert(_el$37, () => data().error, _el$41);
    _$insert(_el$37, () => data().total, null);
    _$insert(_el$33, _$createComponent(Show, {
      get when() {
        return !props.compact;
      },
      get children() {
        return _$createComponent(For, {
          get each() {
            return data().rows.slice(0, 4);
          },
          children: (row) => (() => {
            var _el$45 = _$createElement("box"), _el$46 = _$createElement("text"), _el$47 = _$createTextNode(` `), _el$48 = _$createElement("text"), _el$49 = _$createTextNode(`\u21B3 `);
            _$insertNode(_el$45, _el$46);
            _$insertNode(_el$45, _el$48);
            _$insertNode(_el$46, _el$47);
            _$setProp(_el$46, "wrapMode", "word");
            _$insert(_el$46, (() => {
              var _c$5 = _$memo(() => row.status === "done");
              return () => _c$5() ? "\u2713" : row.status === "error" ? "\u2715" : "\u25CF";
            })(), _el$47);
            _$insert(_el$46, () => row.label, null);
            _$insertNode(_el$48, _el$49);
            _$insert(_el$48, () => durationLabel(row.elapsedMs), null);
            _$insert(_el$48, (() => {
              var _c$6 = _$memo(() => row.tokens === undefined);
              return () => _c$6() ? "" : ` \xB7 ${compact(row.tokens)} tok`;
            })(), null);
            _$insert(_el$48, (() => {
              var _c$7 = _$memo(() => row.tokensPerSecond === undefined);
              return () => _c$7() ? "" : ` \xB7 ${row.tokensPerSecond.toFixed(1)} t/s`;
            })(), null);
            _$effect((_p$) => {
              var _v$9 = row.status === "error" ? theme().error : row.status === "done" ? theme().success : theme().text, _v$0 = theme().textMuted;
              _v$9 !== _p$.e && (_p$.e = _$setProp(_el$46, "fg", _v$9, _p$.e));
              _v$0 !== _p$.t && (_p$.t = _$setProp(_el$48, "fg", _v$0, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$45;
          })()
        });
      }
    }), null);
    _$insert(_el$33, _$createComponent(Show, {
      get when() {
        return _$memo(() => !!!props.compact)() && data().total > 4;
      },
      get children() {
        var _el$42 = _$createElement("text"), _el$43 = _$createTextNode(`+`), _el$44 = _$createTextNode(` subagent lainnya`);
        _$insertNode(_el$42, _el$43);
        _$insertNode(_el$42, _el$44);
        _$insert(_el$42, () => data().total - 4, _el$44);
        _$effect((_$p) => _$setProp(_el$42, "fg", theme().textMuted, _$p));
        return _el$42;
      }
    }), null);
    _$effect((_p$) => {
      var _v$6 = theme().backgroundElement, _v$7 = theme().primary, _v$8 = theme().text;
      _v$6 !== _p$.e && (_p$.e = _$setProp(_el$33, "backgroundColor", _v$6, _p$.e));
      _v$7 !== _p$.t && (_p$.t = _$setProp(_el$34, "fg", _v$7, _p$.t));
      _v$8 !== _p$.a && (_p$.a = _$setProp(_el$37, "fg", _v$8, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$33;
  })();
}
function waitingReason(api, id, activity) {
  if (api.state.session.permission(id).length)
    return "Menunggu izin kamu";
  if (api.state.session.question(id).length)
    return "Menunggu pilihan / jawaban kamu";
  if (activity.status?.type === "retry")
    return "Menunggu percobaan ulang model";
  if (activity.current?.tool === "task" || activity.current?.tool === "subagent" || !activity.current && activity.agents.length)
    return "Menunggu hasil subagent";
  if (activity.current)
    return `${activity.current.state.status === "pending" ? "Mengantre" : "Menunggu hasil"} \xB7 ${activityDetail(activity.current).action}`;
  if (activity.status?.type === "busy")
    return "Menunggu respons model";
  return "";
}
function ObservedWait(props) {
  const [seconds, setSeconds] = createSignal(0);
  createEffect(() => {
    const reason = props.reason;
    const session = props.session;
    setSeconds(0);
    if (!reason || !session)
      return;
    const start = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    onCleanup(() => clearInterval(timer));
  });
  return _$createComponent(Show, {
    get when() {
      return props.reason;
    },
    get children() {
      var _el$50 = _$createElement("text"), _el$51 = _$createTextNode(` \xB7 `), _el$52 = _$createTextNode(` dtk teramati`);
      _$insertNode(_el$50, _el$51);
      _$insertNode(_el$50, _el$52);
      _$setProp(_el$50, "wrapMode", "word");
      _$insert(_el$50, () => props.reason, _el$51);
      _$insert(_el$50, seconds, _el$52);
      return _el$50;
    }
  });
}
function Overview(props) {
  const theme = () => props.api.theme.current;
  const data = createMemo(() => sessionMetrics(props.api, props.id));
  const activity = createMemo(() => sidebarActivity(props.api, props.id));
  const calls = createMemo(() => new Map(props.api.state.session.messages(props.id).flatMap((message) => props.api.state.part(message.id).filter((part) => part.type === "tool")).map((part) => [part.callID, part])));
  const detail = (tool) => activityDetail(calls().get(tool.callID) ?? tool);
  const mcp = retainActivity(() => activity().mcp, (server) => server.name, () => props.id);
  const agents = retainActivity(() => activity().agents, (agent) => agent.id, () => props.id);
  const tools = retainActivity(() => activity().tools, (tool) => tool.callID, () => props.id);
  const size = useTerminalDimensions();
  const limit = () => size().height < 35 ? 2 : 4;
  return (() => {
    var _el$53 = _$createElement("box"), _el$54 = _$createElement("box"), _el$55 = _$createElement("text"), _el$56 = _$createElement("b"), _el$57 = _$createElement("text"), _el$58 = _$createTextNode(` \xB7 `);
    _$insertNode(_el$53, _el$54);
    _$setProp(_el$53, "gap", 1);
    _$setProp(_el$53, "flexShrink", 0);
    _$insertNode(_el$54, _el$55);
    _$insertNode(_el$54, _el$57);
    _$insertNode(_el$55, _el$56);
    _$setProp(_el$55, "wrapMode", "char");
    _$insert(_el$56, () => data().model);
    _$insertNode(_el$57, _el$58);
    _$insert(_el$57, () => data().agent ?? "Sesi baru", _el$58);
    _$insert(_el$57, (() => {
      var _c$8 = _$memo(() => activity().status?.type === "busy");
      return () => _c$8() ? "Bekerja" : activity().status?.type === "retry" ? "Mencoba ulang" : "Siap";
    })(), null);
    _$insert(_el$53, _$createComponent(ObservedWait, {
      get reason() {
        return waitingReason(props.api, props.id, activity());
      },
      get session() {
        return props.id;
      }
    }), null);
    _$insert(_el$53, _$createComponent(AsyncIdentity, {
      get api() {
        return props.api;
      },
      get id() {
        return props.id;
      }
    }), null);
    _$insert(_el$53, _$createComponent(Show, {
      get when() {
        return activity().attention > 0;
      },
      get children() {
        var _el$59 = _$createElement("box"), _el$60 = _$createElement("text"), _el$61 = _$createElement("b"), _el$62 = _$createTextNode(`Butuh jawaban \xB7 `), _el$63 = _$createElement("text");
        _$insertNode(_el$59, _el$60);
        _$insertNode(_el$59, _el$63);
        _$insertNode(_el$60, _el$61);
        _$insertNode(_el$61, _el$62);
        _$insert(_el$61, () => activity().attention, null);
        _$insertNode(_el$63, _$createTextNode(`Periksa permintaan di percakapan.`));
        _$effect((_p$) => {
          var _v$1 = theme().warning, _v$10 = theme().textMuted;
          _v$1 !== _p$.e && (_p$.e = _$setProp(_el$60, "fg", _v$1, _p$.e));
          _v$10 !== _p$.t && (_p$.t = _$setProp(_el$63, "fg", _v$10, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$59;
      }
    }), null);
    _$insert(_el$53, _$createComponent(InfoCard, {
      get api() {
        return props.api;
      },
      name: "connections",
      title: "Koneksi MCP",
      initialOpen: true,
      get summary() {
        return `${props.api.state.mcp().filter((server) => server.status === "connected").length}/${props.api.state.mcp().length} terhubung \xB7 ${activity().mcp.length} sedang dipakai`;
      },
      get children() {
        return [_$createComponent(Show, {
          get when() {
            return mcp().length > 0;
          },
          get children() {
            var _el$65 = _$createElement("box"), _el$66 = _$createElement("text"), _el$67 = _$createElement("b");
            _$insertNode(_el$65, _el$66);
            _$insertNode(_el$66, _el$67);
            _$insertNode(_el$67, _$createTextNode(`MCP sedang dipakai / terakhir`));
            _$insert(_el$65, _$createComponent(For, {
              get each() {
                return mcp().slice(0, limit());
              },
              children: (row) => (() => {
                var _el$100 = _$createElement("box"), _el$101 = _$createElement("text"), _el$102 = _$createTextNode(` \xB7 `);
                _$insertNode(_el$100, _el$101);
                _$insertNode(_el$101, _el$102);
                _$setProp(_el$101, "wrapMode", "char");
                _$insert(_el$101, () => row.item.name, _el$102);
                _$insert(_el$101, (() => {
                  var _c$9 = _$memo(() => row.ended === undefined);
                  return () => _c$9() ? `${row.item.calls.length} panggilan` : "Baru berakhir";
                })(), null);
                _$insert(_el$100, _$createComponent(For, {
                  get each() {
                    return row.item.calls.slice(0, 2);
                  },
                  children: (call) => (() => {
                    var _el$103 = _$createElement("text"), _el$104 = _$createTextNode(` \xB7 `);
                    _$insertNode(_el$103, _el$104);
                    _$setProp(_el$103, "wrapMode", "word");
                    _$insert(_el$103, () => detail(call).status, _el$104);
                    _$insert(_el$103, () => detail(call).action, null);
                    _$insert(_el$103, (() => {
                      var _c$0 = _$memo(() => !!detail(call).target);
                      return () => _c$0() ? ` \xB7 ${detail(call).target}` : "";
                    })(), null);
                    _$effect((_$p) => _$setProp(_el$103, "fg", theme().textMuted, _$p));
                    return _el$103;
                  })()
                }), null);
                _$effect((_$p) => _$setProp(_el$101, "fg", theme().text, _$p));
                return _el$100;
              })()
            }), null);
            _$insert(_el$65, _$createComponent(Show, {
              get when() {
                return mcp().length > limit();
              },
              get children() {
                var _el$69 = _$createElement("text"), _el$70 = _$createTextNode(`+`), _el$71 = _$createTextNode(` MCP lainnya`);
                _$insertNode(_el$69, _el$70);
                _$insertNode(_el$69, _el$71);
                _$insert(_el$69, () => mcp().length - limit(), _el$71);
                _$effect((_$p) => _$setProp(_el$69, "fg", theme().textMuted, _$p));
                return _el$69;
              }
            }), null);
            _$effect((_$p) => _$setProp(_el$66, "fg", theme().primary, _$p));
            return _el$65;
          }
        }), _$createComponent(For, {
          get each() {
            return props.api.state.mcp().filter((server) => !mcp().some((row) => row.item.name === server.name));
          },
          children: (server) => (() => {
            var _el$105 = _$createElement("text"), _el$106 = _$createTextNode(` \xB7 `);
            _$insertNode(_el$105, _el$106);
            _$setProp(_el$105, "wrapMode", "char");
            _$insert(_el$105, () => server.name, _el$106);
            _$insert(_el$105, (() => {
              var _c$1 = _$memo(() => server.status === "connected");
              return () => _c$1() ? "Terhubung \xB7 tidak sedang dipakai" : server.status;
            })(), null);
            _$effect((_$p) => _$setProp(_el$105, "fg", server.status === "connected" ? theme().textMuted : theme().warning, _$p));
            return _el$105;
          })()
        }), _$createComponent(Show, {
          get when() {
            return !props.api.state.mcp().length;
          },
          get children() {
            var _el$72 = _$createElement("text");
            _$insertNode(_el$72, _$createTextNode(`Tidak ada server MCP.`));
            _$effect((_$p) => _$setProp(_el$72, "fg", theme().textMuted, _$p));
            return _el$72;
          }
        })];
      }
    }), null);
    _$insert(_el$53, _$createComponent(Show, {
      get when() {
        return agents().length > 0;
      },
      get children() {
        var _el$74 = _$createElement("box"), _el$75 = _$createElement("text"), _el$76 = _$createElement("b"), _el$77 = _$createTextNode(`Subagent \xB7 `);
        _$insertNode(_el$74, _el$75);
        _$insertNode(_el$75, _el$76);
        _$insertNode(_el$76, _el$77);
        _$insert(_el$76, () => agents().length, null);
        _$insert(_el$74, _$createComponent(For, {
          get each() {
            return agents().slice(0, limit());
          },
          children: (row) => _$createComponent(SubagentCard, {
            get api() {
              return props.api;
            },
            get agent() {
              return row.item;
            },
            get ended() {
              return row.ended;
            }
          })
        }), null);
        _$insert(_el$74, _$createComponent(Show, {
          get when() {
            return agents().length > limit();
          },
          get children() {
            var _el$78 = _$createElement("text"), _el$79 = _$createTextNode(`+`), _el$80 = _$createTextNode(` agent lainnya`);
            _$insertNode(_el$78, _el$79);
            _$insertNode(_el$78, _el$80);
            _$insert(_el$78, () => agents().length - limit(), _el$80);
            _$effect((_$p) => _$setProp(_el$78, "fg", theme().textMuted, _$p));
            return _el$78;
          }
        }), null);
        _$effect((_$p) => _$setProp(_el$75, "fg", theme().primary, _$p));
        return _el$74;
      }
    }), null);
    _$insert(_el$53, _$createComponent(InfoCard, {
      get api() {
        return props.api;
      },
      name: "result",
      title: "Aktivitas & hasil",
      initialOpen: true,
      get summary() {
        return _$memo(() => !!activity().current)() ? `${activityDetail(activity().current).action} \xB7 ${activityDetail(activity().current).status}` : _$memo(() => !!activity().latest)() ? `${activityDetail(activity().latest).action} \xB7 ${activityDetail(activity().latest).status}` : "Belum ada aktivitas tool";
      },
      get children() {
        return [_$createComponent(Show, {
          get when() {
            return tools().length > 0;
          },
          get children() {
            var _el$81 = _$createElement("box");
            _$insert(_el$81, _$createComponent(For, {
              get each() {
                return tools().slice(0, limit());
              },
              children: (row) => (() => {
                var _el$107 = _$createElement("box"), _el$108 = _$createElement("text"), _el$109 = _$createTextNode(` \xB7 `);
                _$insertNode(_el$107, _el$108);
                _$insertNode(_el$108, _el$109);
                _$setProp(_el$108, "wrapMode", "word");
                _$insert(_el$108, () => detail(row.item).action, _el$109);
                _$insert(_el$108, () => detail(row.item).status, null);
                _$insert(_el$108, (() => {
                  var _c$10 = _$memo(() => !!detail(row.item).target);
                  return () => _c$10() ? ` \xB7 ${detail(row.item).target}` : "";
                })(), null);
                _$insert(_el$107, _$createComponent(Show, {
                  get when() {
                    return detail(row.item).result;
                  },
                  get children() {
                    var _el$110 = _$createElement("text");
                    _$setProp(_el$110, "wrapMode", "word");
                    _$insert(_el$110, () => detail(row.item).result);
                    _$effect((_$p) => _$setProp(_el$110, "fg", theme().textMuted, _$p));
                    return _el$110;
                  }
                }), null);
                _$effect((_$p) => _$setProp(_el$108, "fg", theme().text, _$p));
                return _el$107;
              })()
            }), null);
            _$insert(_el$81, _$createComponent(Show, {
              get when() {
                return tools().length > limit();
              },
              get children() {
                var _el$82 = _$createElement("text"), _el$83 = _$createTextNode(`+`), _el$84 = _$createTextNode(` tool lainnya`);
                _$insertNode(_el$82, _el$83);
                _$insertNode(_el$82, _el$84);
                _$insert(_el$82, () => tools().length - limit(), _el$84);
                _$effect((_$p) => _$setProp(_el$82, "fg", theme().textMuted, _$p));
                return _el$82;
              }
            }), null);
            return _el$81;
          }
        }), _$createComponent(Show, {
          get when() {
            return _$memo(() => !!(activity().latest && !tools().slice(0, limit()).some((row) => row.item.callID === activity().latest?.callID) && !mcp().some((row) => row.item.calls.some((call) => call.callID === activity().latest?.callID)) && !["task", "subagent"].includes(activity().latest.tool)))() ? activity().latest : undefined;
          },
          children: (latest) => (() => {
            var _el$111 = _$createElement("box"), _el$112 = _$createElement("text"), _el$113 = _$createElement("text");
            _$insertNode(_el$111, _el$112);
            _$insertNode(_el$111, _el$113);
            _$setProp(_el$112, "wrapMode", "word");
            _$insert(_el$112, () => activityDetail(latest()).target || activityDetail(latest()).action);
            _$setProp(_el$113, "wrapMode", "word");
            _$insert(_el$113, () => activityDetail(latest()).result || "Masih diproses; belum ada hasil akhir.");
            _$effect((_p$) => {
              var _v$13 = theme().text, _v$14 = theme().textMuted;
              _v$13 !== _p$.e && (_p$.e = _$setProp(_el$112, "fg", _v$13, _p$.e));
              _v$14 !== _p$.t && (_p$.t = _$setProp(_el$113, "fg", _v$14, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$111;
          })()
        }), (() => {
          var _el$85 = _$createElement("text");
          _$insertNode(_el$85, _$createTextNode(`Hasil tes: lihat keluaran pengujian di percakapan; status tool bukan bukti tes lulus.`));
          _$setProp(_el$85, "wrapMode", "word");
          _$effect((_$p) => _$setProp(_el$85, "fg", theme().textMuted, _$p));
          return _el$85;
        })()];
      }
    }), null);
    _$insert(_el$53, _$createComponent(InfoCard, {
      get api() {
        return props.api;
      },
      name: "context",
      title: "Laporan token provider",
      get summary() {
        return _$memo(() => data().used === undefined)() ? "Token belum dilaporkan" : `${compact(data().used ?? NaN)} token \xB7 laporan terakhir`;
      },
      get children() {
        return [(() => {
          var _el$87 = _$createElement("text"), _el$88 = _$createTextNode(`Provider \xB7 `);
          _$insertNode(_el$87, _el$88);
          _$setProp(_el$87, "wrapMode", "char");
          _$insert(_el$87, () => data().provider, null);
          _$effect((_$p) => _$setProp(_el$87, "fg", theme().textMuted, _$p));
          return _el$87;
        })(), (() => {
          var _el$89 = _$createElement("text");
          _$insertNode(_el$89, _$createTextNode(`Konteks aktif DCP \xB7 belum diukur`));
          _$effect((_$p) => _$setProp(_el$89, "fg", theme().textMuted, _$p));
          return _el$89;
        })(), (() => {
          var _el$91 = _$createElement("text");
          _$insertNode(_el$91, _$createTextNode(`Laporan ini menjumlahkan input, output, reasoning, dan cache dari pesan model terakhir yang melaporkan penggunaan.`));
          _$setProp(_el$91, "wrapMode", "word");
          _$effect((_$p) => _$setProp(_el$91, "fg", theme().textMuted, _$p));
          return _el$91;
        })(), (() => {
          var _el$93 = _$createElement("text");
          _$insertNode(_el$93, _$createTextNode(`Periksa /dcp untuk statistik kompresi. Angka provider bukan ukuran pesan yang akan dikirim sesudah DCP.`));
          _$setProp(_el$93, "wrapMode", "word");
          _$effect((_$p) => _$setProp(_el$93, "fg", theme().textMuted, _$p));
          return _el$93;
        })(), (() => {
          var _el$95 = _$createElement("text"), _el$96 = _$createTextNode(`Biaya tercatat \xB7 $`);
          _$insertNode(_el$95, _el$96);
          _$insert(_el$95, () => data().cost.toFixed(4), null);
          _$effect((_$p) => _$setProp(_el$95, "fg", theme().textMuted, _$p));
          return _el$95;
        })()];
      }
    }), null);
    _$insert(_el$53, _$createComponent(InfoCard, {
      get api() {
        return props.api;
      },
      name: "progress",
      title: "Progres tugas",
      initialOpen: true,
      get summary() {
        return `${activity().completed}/${activity().total} selesai \xB7 ${activity().todos.length} tersisa`;
      },
      get children() {
        return _$createComponent(Show, {
          get when() {
            return activity().total > 0;
          },
          get fallback() {
            return (() => {
              var _el$114 = _$createElement("text");
              _$insertNode(_el$114, _$createTextNode(`Belum ada daftar tugas di sesi ini.`));
              _$effect((_$p) => _$setProp(_el$114, "fg", theme().textMuted, _$p));
              return _el$114;
            })();
          },
          get children() {
            return [(() => {
              var _el$97 = _$createElement("text"), _el$98 = _$createTextNode(` berjalan \xB7 `), _el$99 = _$createTextNode(` antre`);
              _$insertNode(_el$97, _el$98);
              _$insertNode(_el$97, _el$99);
              _$insert(_el$97, () => activity().todos.filter((todo) => todo.status === "in_progress").length, _el$98);
              _$insert(_el$97, () => activity().todos.filter((todo) => todo.status === "pending").length, _el$99);
              _$effect((_$p) => _$setProp(_el$97, "fg", theme().textMuted, _$p));
              return _el$97;
            })(), _$createComponent(For, {
              get each() {
                return [...props.api.state.session.todo(props.id)].sort((a, b) => ({
                  in_progress: 0,
                  pending: 1,
                  completed: 2
                }[a.status] ?? 3) - ({
                  in_progress: 0,
                  pending: 1,
                  completed: 2
                }[b.status] ?? 3));
              },
              children: (todo) => (() => {
                var _el$116 = _$createElement("box"), _el$117 = _$createElement("text"), _el$118 = _$createElement("text");
                _$insertNode(_el$116, _el$117);
                _$insertNode(_el$116, _el$118);
                _$setProp(_el$116, "marginTop", 1);
                _$insert(_el$117, (() => {
                  var _c$11 = _$memo(() => todo.status === "completed");
                  return () => _c$11() ? "\u2713 Selesai" : todo.status === "in_progress" ? "\u203A Sedang dikerjakan" : "\xB7 Menunggu";
                })());
                _$setProp(_el$118, "wrapMode", "word");
                _$insert(_el$118, () => todo.content);
                _$effect((_p$) => {
                  var _v$15 = todo.status === "in_progress" ? theme().primary : theme().textMuted, _v$16 = todo.status === "completed" ? theme().textMuted : theme().text;
                  _v$15 !== _p$.e && (_p$.e = _$setProp(_el$117, "fg", _v$15, _p$.e));
                  _v$16 !== _p$.t && (_p$.t = _$setProp(_el$118, "fg", _v$16, _p$.t));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined
                });
                return _el$116;
              })()
            })];
          }
        });
      }
    }), null);
    _$insert(_el$53, _$createComponent(WorkspaceCard, {
      get api() {
        return props.api;
      },
      get id() {
        return props.id;
      }
    }), null);
    _$effect((_p$) => {
      var _v$11 = theme().text, _v$12 = theme().textMuted;
      _v$11 !== _p$.e && (_p$.e = _$setProp(_el$55, "fg", _v$11, _p$.e));
      _v$12 !== _p$.t && (_p$.t = _$setProp(_el$57, "fg", _v$12, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$53;
  })();
}
function SidebarPresence(props) {
  onMount(() => props.visible(true));
  onCleanup(() => props.visible(false));
  return props.children;
}
function ResponsiveDock(props) {
  const size = useTerminalDimensions();
  const activity = createMemo(() => sidebarActivity(props.api, props.id));
  const data = createMemo(() => sessionMetrics(props.api, props.id));
  const identity = createMemo(() => asyncIdentity(props.api, props.id));
  const theme = () => props.api.theme.current;
  const open = () => props.api.ui.dialog.replace(() => _$createComponent(props.api.ui.Dialog, {
    onClose: () => props.api.ui.dialog.clear(),
    get children() {
      var _el$119 = _$createElement("box"), _el$120 = _$createElement("text"), _el$121 = _$createElement("b"), _el$123 = _$createTextNode(` \xB7 Esc tutup`), _el$124 = _$createElement("scrollbox");
      _$insertNode(_el$119, _el$120);
      _$insertNode(_el$119, _el$124);
      _$setProp(_el$119, "padding", 1);
      _$insertNode(_el$120, _el$121);
      _$insertNode(_el$120, _el$123);
      _$insertNode(_el$121, _$createTextNode(`Studio \xB7 Detail sesi`));
      _$insert(_el$124, _$createComponent(Overview, {
        get api() {
          return props.api;
        },
        get id() {
          return props.id;
        },
        mini: true
      }));
      _$effect((_p$) => {
        var _v$17 = theme().primary, _v$18 = Math.max(5, size().height - 10);
        _v$17 !== _p$.e && (_p$.e = _$setProp(_el$120, "fg", _v$17, _p$.e));
        _v$18 !== _p$.t && (_p$.t = _$setProp(_el$124, "height", _v$18, _p$.t));
        return _p$;
      }, {
        e: undefined,
        t: undefined
      });
      return _el$119;
    }
  }));
  const unregister = props.api.command?.register(() => [{
    title: "Studio: buka seluruh informasi sesi",
    value: "studio.panel",
    category: "Studio",
    slash: {
      name: "studio-panel"
    },
    onSelect: () => open()
  }]);
  if (unregister)
    onCleanup(unregister);
  return _$createComponent(Show, {
    get when() {
      return !props.sidebarVisible;
    },
    get children() {
      var _el$125 = _$createElement("box"), _el$126 = _$createElement("box"), _el$127 = _$createElement("text"), _el$128 = _$createElement("b"), _el$129 = _$createTextNode(`ASYNC \xB7 `), _el$130 = _$createElement("text"), _el$131 = _$createElement("text"), _el$132 = _$createElement("text"), _el$133 = _$createTextNode(`\u25CF `), _el$134 = _$createTextNode(` run \xB7 \u2713 `), _el$135 = _$createTextNode(` done \xB7 \u2715 `), _el$136 = _$createTextNode(` err \xB7 \u03A3 `), _el$137 = _$createElement("text"), _el$138 = _$createElement("text"), _el$139 = _$createElement("box"), _el$140 = _$createElement("text");
      _$insertNode(_el$125, _el$126);
      _$setProp(_el$125, "flexDirection", "row");
      _$setProp(_el$125, "width", "100%");
      _$setProp(_el$125, "height", 8);
      _$setProp(_el$125, "flexShrink", 0);
      _$setProp(_el$125, "gap", 1);
      _$setProp(_el$125, "paddingLeft", 1);
      _$setProp(_el$125, "paddingRight", 1);
      _$insertNode(_el$126, _el$127);
      _$insertNode(_el$126, _el$130);
      _$insertNode(_el$126, _el$131);
      _$insertNode(_el$126, _el$132);
      _$insertNode(_el$126, _el$137);
      _$insertNode(_el$126, _el$138);
      _$insertNode(_el$126, _el$139);
      _$setProp(_el$126, "flexGrow", 1);
      _$setProp(_el$126, "minWidth", 0);
      _$setProp(_el$126, "flexShrink", 1);
      _$insertNode(_el$127, _el$128);
      _$setProp(_el$127, "height", 1);
      _$insertNode(_el$128, _el$129);
      _$insert(_el$128, () => data().agent ?? "Sesi", null);
      _$setProp(_el$130, "height", 1);
      _$insert(_el$130, (() => {
        var _c$12 = _$memo(() => !!activity().attention);
        return () => _c$12() ? `${activity().attention} permintaan menunggu jawaban` : _$memo(() => identity().running > 0)() ? `${identity().running} subagent berjalan` : "Siap";
      })());
      _$setProp(_el$131, "height", 1);
      _$insert(_el$131, () => data().model, null);
      _$insert(_el$131, (() => {
        var _c$13 = _$memo(() => data().used === undefined);
        return () => _c$13() ? "" : ` \xB7 ${compact(data().used ?? NaN)} token (laporan)`;
      })(), null);
      _$insertNode(_el$132, _el$133);
      _$insertNode(_el$132, _el$134);
      _$insertNode(_el$132, _el$135);
      _$insertNode(_el$132, _el$136);
      _$setProp(_el$132, "height", 1);
      _$insert(_el$132, () => identity().running, _el$134);
      _$insert(_el$132, () => identity().done, _el$135);
      _$insert(_el$132, () => identity().error, _el$136);
      _$insert(_el$132, () => identity().total, null);
      _$setProp(_el$137, "height", 1);
      _$insert(_el$137, (() => {
        var _c$14 = _$memo(() => !!activity().latest);
        return () => _c$14() ? `${activityDetail(activity().latest).status} \xB7 ${activityDetail(activity().latest).action}` : "Belum ada aktivitas tool";
      })());
      _$setProp(_el$138, "height", 1);
      _$insert(_el$138, (() => {
        var _c$15 = _$memo(() => !!activity().latest);
        return () => _c$15() ? activityDetail(activity().latest).target : "";
      })());
      _$insertNode(_el$139, _el$140);
      _$setProp(_el$139, "onMouseDown", (event) => {
        if (event.button === 0) {
          event.stopPropagation();
          open();
        }
      });
      _$insertNode(_el$140, _$createTextNode(`/studio-panel \xB7 detail`));
      _$setProp(_el$140, "height", 1);
      _$effect((_p$) => {
        var _v$19 = theme().backgroundPanel, _v$20 = theme().primary, _v$21 = theme().text, _v$22 = theme().textMuted, _v$23 = theme().text, _v$24 = theme().text, _v$25 = theme().textMuted, _v$26 = theme().primary;
        _v$19 !== _p$.e && (_p$.e = _$setProp(_el$125, "backgroundColor", _v$19, _p$.e));
        _v$20 !== _p$.t && (_p$.t = _$setProp(_el$127, "fg", _v$20, _p$.t));
        _v$21 !== _p$.a && (_p$.a = _$setProp(_el$130, "fg", _v$21, _p$.a));
        _v$22 !== _p$.o && (_p$.o = _$setProp(_el$131, "fg", _v$22, _p$.o));
        _v$23 !== _p$.i && (_p$.i = _$setProp(_el$132, "fg", _v$23, _p$.i));
        _v$24 !== _p$.n && (_p$.n = _$setProp(_el$137, "fg", _v$24, _p$.n));
        _v$25 !== _p$.s && (_p$.s = _$setProp(_el$138, "fg", _v$25, _p$.s));
        _v$26 !== _p$.h && (_p$.h = _$setProp(_el$140, "fg", _v$26, _p$.h));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined,
        o: undefined,
        i: undefined,
        n: undefined,
        s: undefined,
        h: undefined
      });
      return _el$125;
    }
  });
}
function StatusBar(props) {
  const size = useTerminalDimensions();
  const theme = () => props.api.theme.current;
  const mcp = () => props.api.state.mcp();
  const plugins = () => props.api.plugins.list().filter((item) => item.source !== "internal");
  return (() => {
    var _el$142 = _$createElement("box"), _el$143 = _$createElement("text"), _el$144 = _$createElement("b"), _el$151 = _$createElement("text");
    _$insertNode(_el$142, _el$143);
    _$insertNode(_el$142, _el$151);
    _$setProp(_el$142, "flexDirection", "row");
    _$setProp(_el$142, "justifyContent", "space-between");
    _$setProp(_el$142, "paddingLeft", 1);
    _$setProp(_el$142, "paddingRight", 1);
    _$setProp(_el$142, "width", "100%");
    _$insertNode(_el$143, _el$144);
    _$insertNode(_el$144, _$createTextNode(`ASYNC`));
    _$insert(_el$142, _$createComponent(Show, {
      get when() {
        return size().width >= 65;
      },
      get children() {
        var _el$146 = _$createElement("text"), _el$147 = _$createTextNode(`/`), _el$148 = _$createTextNode(` MCP \xB7 `), _el$149 = _$createTextNode(`/`), _el$150 = _$createTextNode(` plugin TUI aktif`);
        _$insertNode(_el$146, _el$147);
        _$insertNode(_el$146, _el$148);
        _$insertNode(_el$146, _el$149);
        _$insertNode(_el$146, _el$150);
        _$insert(_el$146, () => mcp().filter((item) => item.status === "connected").length, _el$147);
        _$insert(_el$146, () => mcp().length, _el$148);
        _$insert(_el$146, () => plugins().filter((item) => item.active).length, _el$149);
        _$insert(_el$146, () => plugins().length, _el$150);
        _$effect((_$p) => _$setProp(_el$146, "fg", theme().textMuted, _$p));
        return _el$146;
      }
    }), _el$151);
    _$insert(_el$151, () => props.api.state.vcs?.branch ?? "lokal");
    _$effect((_p$) => {
      var _v$27 = theme().backgroundPanel, _v$28 = theme().primary, _v$29 = theme().textMuted;
      _v$27 !== _p$.e && (_p$.e = _$setProp(_el$142, "backgroundColor", _v$27, _p$.e));
      _v$28 !== _p$.t && (_p$.t = _$setProp(_el$143, "fg", _v$28, _p$.t));
      _v$29 !== _p$.a && (_p$.a = _$setProp(_el$151, "fg", _v$29, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$142;
  })();
}
var plugin = {
  id: "opencode-asynchronous-agent.tui",
  tui: async (api) => {
    subagentToasts(api);
    const [sidebarVisible, setSidebarVisible] = createSignal(false);
    const sessionID = () => {
      const route = api.route.current;
      return route.name === "session" && typeof route.params?.sessionID === "string" ? route.params.sessionID : undefined;
    };
    api.slots.register({
      order: 10,
      slots: {
        sidebar_title(_ctx, props) {
          return (() => {
            var _el$152 = _$createElement("box"), _el$153 = _$createElement("text"), _el$154 = _$createElement("b"), _el$156 = _$createElement("text"), _el$157 = _$createElement("b");
            _$insertNode(_el$152, _el$153);
            _$insertNode(_el$152, _el$156);
            _$setProp(_el$152, "gap", 1);
            _$setProp(_el$152, "paddingBottom", 1);
            _$insertNode(_el$153, _el$154);
            _$insertNode(_el$154, _$createTextNode(`ASYNC AGENT / SESI`));
            _$insertNode(_el$156, _el$157);
            _$setProp(_el$156, "wrapMode", "word");
            _$insert(_el$157, () => props.title);
            _$insert(_el$152, _$createComponent(Show, {
              get when() {
                return props.share_url;
              },
              get children() {
                var _el$158 = _$createElement("text");
                _$setProp(_el$158, "wrapMode", "char");
                _$insert(_el$158, () => props.share_url);
                _$effect((_$p) => _$setProp(_el$158, "fg", api.theme.current.textMuted, _$p));
                return _el$158;
              }
            }), null);
            _$effect((_p$) => {
              var _v$30 = api.theme.current.primary, _v$31 = api.theme.current.text;
              _v$30 !== _p$.e && (_p$.e = _$setProp(_el$153, "fg", _v$30, _p$.e));
              _v$31 !== _p$.t && (_p$.t = _$setProp(_el$156, "fg", _v$31, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$152;
          })();
        },
        sidebar_content(_ctx, props) {
          return _$createComponent(SidebarPresence, {
            visible: setSidebarVisible,
            get children() {
              return _$createComponent(Overview, {
                api,
                get id() {
                  return props.session_id;
                }
              });
            }
          });
        },
        sidebar_footer(_ctx, props) {
          return _$createComponent(AsyncIdentity, {
            api,
            get id() {
              return props.session_id;
            },
            compact: true
          });
        },
        home_footer() {
          return (() => {
            var _el$159 = _$createElement("text"), _el$160 = _$createTextNode(`OPENCODE ASYNC AGENT \xB7 v`);
            _$insertNode(_el$159, _el$160);
            _$insert(_el$159, () => api.app.version, null);
            _$effect((_$p) => _$setProp(_el$159, "fg", api.theme.current.textMuted, _$p));
            return _el$159;
          })();
        },
        app_bottom() {
          return (() => {
            var _el$161 = _$createElement("box");
            _$setProp(_el$161, "flexShrink", 0);
            _$insert(_el$161, _$createComponent(Show, {
              get when() {
                return sessionID();
              },
              children: (id) => _$createComponent(ResponsiveDock, {
                api,
                get id() {
                  return id();
                },
                get sidebarVisible() {
                  return sidebarVisible();
                }
              })
            }), null);
            _$insert(_el$161, _$createComponent(StatusBar, {
              api
            }), null);
            return _el$161;
          })();
        }
      }
    });
  }
};
var tui_default = plugin;
export {
  AsyncIdentity,
  InfoCard,
  ObservedWait,
  Overview,
  ResponsiveDock,
  SidebarPresence,
  SubagentCard,
  WorkspaceCard,
  tui_default as default,
  retainActivity,
  waitingReason
};
