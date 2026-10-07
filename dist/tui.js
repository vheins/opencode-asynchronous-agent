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
function navigateToSession(api, target) {
  if (!target || !target.startsWith("ses_"))
    return;
  api.route.navigate("session", {
    sessionID: target
  });
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
  const tools = api.state.session.messages(id).flatMap((message) => api.state.part(message.id)).filter((part) => part.type === "tool").filter((part) => part.tool === "task" || part.tool === "subagent");
  const statuses = tools.map((part) => part.state.status === "completed" ? "done" : part.state.status === "error" ? "error" : "running");
  return {
    running: statuses.filter((status) => status === "running").length,
    done: statuses.filter((status) => status === "done").length,
    error: statuses.filter((status) => status === "error").length,
    total: statuses.length
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
  const [hovered, setHovered] = createSignal(false);
  const theme = () => props.api.theme.current;
  const clickable = () => Boolean(props.onActivate);
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
  const header = (event) => {
    if (event.button !== 0)
      return;
    event.stopPropagation();
    if (props.onActivate)
      props.onActivate();
    else
      toggle();
  };
  return (() => {
    var _el$ = _$createElement("box"), _el$2 = _$createElement("box"), _el$3 = _$createElement("text"), _el$4 = _$createElement("b"), _el$5 = _$createElement("text"), _el$6 = _$createElement("b"), _el$7 = _$createTextNode(` `), _el$8 = _$createElement("text");
    _$insertNode(_el$, _el$2);
    _$insertNode(_el$, _el$8);
    _$setProp(_el$, "paddingLeft", 1);
    _$setProp(_el$, "paddingRight", 1);
    _$insertNode(_el$2, _el$3);
    _$insertNode(_el$2, _el$5);
    _$setProp(_el$2, "flexDirection", "row");
    _$setProp(_el$2, "onMouseDown", header);
    _$insertNode(_el$3, _el$4);
    _$setProp(_el$3, "onMouseDown", (event) => {
      if (event.button === 0) {
        event.stopPropagation();
        toggle();
      }
    });
    _$insert(_el$4, () => open() ? "\u25BE" : "\u25B8");
    _$insertNode(_el$5, _el$6);
    _$insertNode(_el$6, _el$7);
    _$insert(_el$6, () => props.title, null);
    _$insert(_el$6, () => clickable() ? " \u2192" : "", null);
    _$setProp(_el$8, "wrapMode", "word");
    _$setProp(_el$8, "onMouseDown", header);
    _$insert(_el$8, () => props.summary);
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return open();
      },
      get children() {
        var _el$9 = _$createElement("box");
        _$setProp(_el$9, "paddingTop", 1);
        _$setProp(_el$9, "paddingBottom", 1);
        _$insert(_el$9, () => props.children);
        return _el$9;
      }
    }), null);
    _$effect((_p$) => {
      var _v$ = hovered() ? theme().backgroundPanel : theme().backgroundElement, _v$2 = clickable() ? () => setHovered(true) : undefined, _v$3 = clickable() ? () => setHovered(false) : undefined, _v$4 = hovered() ? theme().accent : theme().primary, _v$5 = hovered() ? theme().accent : theme().primary, _v$6 = theme().textMuted;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$, "backgroundColor", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$, "onMouseOver", _v$2, _p$.t));
      _v$3 !== _p$.a && (_p$.a = _$setProp(_el$, "onMouseOut", _v$3, _p$.a));
      _v$4 !== _p$.o && (_p$.o = _$setProp(_el$3, "fg", _v$4, _p$.o));
      _v$5 !== _p$.i && (_p$.i = _$setProp(_el$5, "fg", _v$5, _p$.i));
      _v$6 !== _p$.n && (_p$.n = _$setProp(_el$8, "fg", _v$6, _p$.n));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined,
      n: undefined
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
  const elapsed = () => (data()?.started ?? 0) > 0 ? Math.max(0, (props.ended ?? now()) - data().started) : 0;
  const tokens = () => childTokens(props.api, props.agent.id);
  const rate = () => {
    const value = tokens();
    const seconds = elapsed() / 1000;
    return value !== undefined && seconds > 0 ? value / seconds : undefined;
  };
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
    onActivate: () => navigateToSession(props.api, props.agent.id),
    get summary() {
      return `${data()?.model ?? "Memuat model\u2026"}
${elapsedLabel(data()?.started, props.ended ?? now())}${tokens() === undefined ? "" : ` \xB7 ${compact(tokens())} tok`}${rate() === undefined ? "" : ` \xB7 ${rate().toFixed(1)} t/s`}`;
    },
    get children() {
      return [_$createComponent(Show, {
        get when() {
          return props.agent.target;
        },
        get children() {
          var _el$0 = _$createElement("text");
          _$setProp(_el$0, "wrapMode", "word");
          _$insert(_el$0, () => props.agent.target);
          _$effect((_$p) => _$setProp(_el$0, "fg", theme().text, _$p));
          return _el$0;
        }
      }), _$createComponent(Show, {
        get when() {
          return error();
        },
        get children() {
          var _el$1 = _$createElement("text");
          _$insert(_el$1, error);
          _$effect((_$p) => _$setProp(_el$1, "fg", theme().warning, _$p));
          return _el$1;
        }
      }), _$createComponent(Show, {
        get when() {
          return data();
        },
        children: (detail) => (() => {
          var _el$10 = _$createElement("box"), _el$11 = _$createElement("text"), _el$13 = _$createElement("text");
          _$insertNode(_el$10, _el$11);
          _$insertNode(_el$10, _el$13);
          _$setProp(_el$10, "gap", 1);
          _$setProp(_el$11, "wrapMode", "word");
          _$insert(_el$11, (() => {
            var _c$ = _$memo(() => !!detail().activity);
            return () => _c$() ? `${detail().current ? "Sekarang" : "Terakhir"} \xB7 ${detail().activity.action} \xB7 ${detail().activity.status}` : "Aktivitas tool belum dilaporkan.";
          })());
          _$insert(_el$10, _$createComponent(Show, {
            get when() {
              return detail().activity?.target;
            },
            get children() {
              var _el$12 = _$createElement("text");
              _$setProp(_el$12, "wrapMode", "char");
              _$insert(_el$12, () => detail().activity?.target);
              _$effect((_$p) => _$setProp(_el$12, "fg", theme().textMuted, _$p));
              return _el$12;
            }
          }), _el$13);
          _$insert(_el$13, (() => {
            var _c$2 = _$memo(() => !!detail().todos.length);
            return () => _c$2() ? `${detail().completed}/${detail().todos.length} tugas selesai` : "Progres tugas belum dilaporkan.";
          })());
          _$insert(_el$10, _$createComponent(For, {
            get each() {
              return detail().todos;
            },
            children: (todo) => (() => {
              var _el$14 = _$createElement("text"), _el$15 = _$createTextNode(` `);
              _$insertNode(_el$14, _el$15);
              _$setProp(_el$14, "wrapMode", "word");
              _$insert(_el$14, (() => {
                var _c$3 = _$memo(() => todo.status === "completed");
                return () => _c$3() ? "\u2713" : todo.status === "in_progress" ? "\u203A" : "\xB7";
              })(), _el$15);
              _$insert(_el$14, () => todo.content, null);
              _$effect((_$p) => _$setProp(_el$14, "fg", todo.status === "in_progress" ? theme().text : theme().textMuted, _$p));
              return _el$14;
            })()
          }), null);
          _$effect((_p$) => {
            var _v$7 = theme().text, _v$8 = theme().textMuted;
            _v$7 !== _p$.e && (_p$.e = _$setProp(_el$11, "fg", _v$7, _p$.e));
            _v$8 !== _p$.t && (_p$.t = _$setProp(_el$13, "fg", _v$8, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$10;
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
        var _el$16 = _$createElement("text");
        _$setProp(_el$16, "wrapMode", "char");
        _$insert(_el$16, () => props.api.state.path.directory);
        _$effect((_$p) => _$setProp(_el$16, "fg", theme().textMuted, _$p));
        return _el$16;
      })(), (() => {
        var _el$17 = _$createElement("text");
        _$insertNode(_el$17, _$createTextNode(`Git lokal, bukan hanya perubahan sesi \xB7 refresh 15 dtk`));
        _$effect((_$p) => _$setProp(_el$17, "fg", theme().textMuted, _$p));
        return _el$17;
      })(), _$createComponent(Show, {
        get when() {
          return data();
        },
        children: (scan) => (() => {
          var _el$21 = _$createElement("box");
          _$setProp(_el$21, "gap", 1);
          _$insert(_el$21, _$createComponent(For, {
            get each() {
              return scan().repos;
            },
            get fallback() {
              return (() => {
                var _el$24 = _$createElement("text");
                _$insertNode(_el$24, _$createTextNode(`Tidak ditemukan repo Git dalam cakupan pemindaian.`));
                _$effect((_$p) => _$setProp(_el$24, "fg", theme().textMuted, _$p));
                return _el$24;
              })();
            },
            children: (repo) => (() => {
              var _el$26 = _$createElement("box"), _el$27 = _$createElement("text"), _el$28 = _$createElement("b"), _el$29 = _$createTextNode(` \xB7 `);
              _$insertNode(_el$26, _el$27);
              _$insertNode(_el$27, _el$28);
              _$insertNode(_el$27, _el$29);
              _$setProp(_el$27, "wrapMode", "char");
              _$insert(_el$28, () => repo.path);
              _$insert(_el$27, () => repo.branch, null);
              _$insert(_el$26, _$createComponent(Show, {
                get when() {
                  return repo.error;
                },
                get fallback() {
                  return (() => {
                    var _el$31 = _$createElement("text");
                    _$insert(_el$31, (() => {
                      var _c$4 = _$memo(() => !!repo.files.length);
                      return () => _c$4() ? `${repo.files.length} entri berubah` : "Working tree bersih";
                    })());
                    _$effect((_$p) => _$setProp(_el$31, "fg", theme().textMuted, _$p));
                    return _el$31;
                  })();
                },
                get children() {
                  var _el$30 = _$createElement("text");
                  _$insert(_el$30, () => repo.error);
                  _$effect((_$p) => _$setProp(_el$30, "fg", theme().warning, _$p));
                  return _el$30;
                }
              }), null);
              _$insert(_el$26, _$createComponent(For, {
                get each() {
                  return repo.files;
                },
                children: (file) => (() => {
                  var _el$32 = _$createElement("text"), _el$33 = _$createTextNode(` `);
                  _$insertNode(_el$32, _el$33);
                  _$setProp(_el$32, "wrapMode", "char");
                  _$insert(_el$32, () => file.status, _el$33);
                  _$insert(_el$32, () => file.path, null);
                  _$effect((_$p) => _$setProp(_el$32, "fg", theme().text, _$p));
                  return _el$32;
                })()
              }), null);
              _$effect((_$p) => _$setProp(_el$27, "fg", theme().primary, _$p));
              return _el$26;
            })()
          }), null);
          _$insert(_el$21, _$createComponent(For, {
            get each() {
              return scan().errors;
            },
            children: (message) => (() => {
              var _el$34 = _$createElement("text");
              _$insert(_el$34, message);
              _$effect((_$p) => _$setProp(_el$34, "fg", theme().warning, _$p));
              return _el$34;
            })()
          }), null);
          _$insert(_el$21, _$createComponent(Show, {
            get when() {
              return scan().limited;
            },
            get children() {
              var _el$22 = _$createElement("text");
              _$insertNode(_el$22, _$createTextNode(`Cakupan dibatasi 4 tingkat / 300 folder.`));
              _$effect((_$p) => _$setProp(_el$22, "fg", theme().warning, _$p));
              return _el$22;
            }
          }), null);
          return _el$21;
        })()
      }), (() => {
        var _el$19 = _$createElement("text"), _el$20 = _$createTextNode(` berkas tercatat terpisah oleh sesi OpenCode.`);
        _$insertNode(_el$19, _el$20);
        _$insert(_el$19, () => props.api.state.session.diff(props.id).length, _el$20);
        _$effect((_$p) => _$setProp(_el$19, "fg", theme().textMuted, _$p));
        return _el$19;
      })()];
    }
  });
}
function AsyncIdentity(props) {
  const theme = () => props.api.theme.current;
  const data = createMemo(() => asyncIdentity(props.api, props.id));
  return (() => {
    var _el$35 = _$createElement("box"), _el$36 = _$createElement("text"), _el$37 = _$createElement("b"), _el$38 = _$createTextNode(`Subagents `), _el$39 = _$createElement("text"), _el$40 = _$createTextNode(`\u25CF `), _el$41 = _$createTextNode(` run \xB7 \u2713 `), _el$42 = _$createTextNode(` done \xB7 \u2715 `), _el$43 = _$createTextNode(` err \xB7 \u03A3 `);
    _$insertNode(_el$35, _el$36);
    _$insertNode(_el$35, _el$39);
    _$setProp(_el$35, "paddingLeft", 1);
    _$setProp(_el$35, "paddingRight", 1);
    _$insertNode(_el$36, _el$37);
    _$insertNode(_el$37, _el$38);
    _$insert(_el$37, () => data().total, null);
    _$insertNode(_el$39, _el$40);
    _$insertNode(_el$39, _el$41);
    _$insertNode(_el$39, _el$42);
    _$insertNode(_el$39, _el$43);
    _$insert(_el$39, () => data().running, _el$41);
    _$insert(_el$39, () => data().done, _el$42);
    _$insert(_el$39, () => data().error, _el$43);
    _$insert(_el$39, () => data().total, null);
    _$effect((_p$) => {
      var _v$9 = theme().backgroundElement, _v$0 = theme().primary, _v$1 = theme().text;
      _v$9 !== _p$.e && (_p$.e = _$setProp(_el$35, "backgroundColor", _v$9, _p$.e));
      _v$0 !== _p$.t && (_p$.t = _$setProp(_el$36, "fg", _v$0, _p$.t));
      _v$1 !== _p$.a && (_p$.a = _$setProp(_el$39, "fg", _v$1, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$35;
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
      var _el$44 = _$createElement("text"), _el$45 = _$createTextNode(` \xB7 `), _el$46 = _$createTextNode(` dtk teramati`);
      _$insertNode(_el$44, _el$45);
      _$insertNode(_el$44, _el$46);
      _$setProp(_el$44, "wrapMode", "word");
      _$insert(_el$44, () => props.reason, _el$45);
      _$insert(_el$44, seconds, _el$46);
      return _el$44;
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
    var _el$47 = _$createElement("box"), _el$48 = _$createElement("box"), _el$49 = _$createElement("text"), _el$50 = _$createElement("b"), _el$51 = _$createElement("text"), _el$52 = _$createTextNode(` \xB7 `), _el$53 = _$createElement("box");
    _$insertNode(_el$47, _el$48);
    _$insertNode(_el$47, _el$53);
    _$setProp(_el$47, "gap", 1);
    _$setProp(_el$47, "flexShrink", 0);
    _$insertNode(_el$48, _el$49);
    _$insertNode(_el$48, _el$51);
    _$insertNode(_el$49, _el$50);
    _$setProp(_el$49, "wrapMode", "char");
    _$insert(_el$50, () => data().model);
    _$insertNode(_el$51, _el$52);
    _$insert(_el$51, () => data().agent ?? "Sesi baru", _el$52);
    _$insert(_el$51, (() => {
      var _c$5 = _$memo(() => activity().status?.type === "busy");
      return () => _c$5() ? "Bekerja" : activity().status?.type === "retry" ? "Mencoba ulang" : "Siap";
    })(), null);
    _$insert(_el$47, _$createComponent(ObservedWait, {
      get reason() {
        return waitingReason(props.api, props.id, activity());
      },
      get session() {
        return props.id;
      }
    }), _el$53);
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
        return agents().length > 0;
      },
      get children() {
        return [_$createComponent(For, {
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
        }), _$createComponent(Show, {
          get when() {
            return agents().length > limit();
          },
          get children() {
            var _el$54 = _$createElement("text"), _el$55 = _$createTextNode(`+`), _el$56 = _$createTextNode(` agent lainnya`);
            _$insertNode(_el$54, _el$55);
            _$insertNode(_el$54, _el$56);
            _$insert(_el$54, () => agents().length - limit(), _el$56);
            _$effect((_$p) => _$setProp(_el$54, "fg", theme().textMuted, _$p));
            return _el$54;
          }
        })];
      }
    }), null);
    _$insert(_el$47, _$createComponent(Show, {
      get when() {
        return activity().attention > 0;
      },
      get children() {
        var _el$57 = _$createElement("box"), _el$58 = _$createElement("text"), _el$59 = _$createElement("b"), _el$60 = _$createTextNode(`Butuh jawaban \xB7 `), _el$61 = _$createElement("text");
        _$insertNode(_el$57, _el$58);
        _$insertNode(_el$57, _el$61);
        _$insertNode(_el$58, _el$59);
        _$insertNode(_el$59, _el$60);
        _$insert(_el$59, () => activity().attention, null);
        _$insertNode(_el$61, _$createTextNode(`Periksa permintaan di percakapan.`));
        _$effect((_p$) => {
          var _v$10 = theme().warning, _v$11 = theme().textMuted;
          _v$10 !== _p$.e && (_p$.e = _$setProp(_el$58, "fg", _v$10, _p$.e));
          _v$11 !== _p$.t && (_p$.t = _$setProp(_el$61, "fg", _v$11, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$57;
      }
    }), null);
    _$insert(_el$47, _$createComponent(InfoCard, {
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
            var _el$63 = _$createElement("box"), _el$64 = _$createElement("text"), _el$65 = _$createElement("b");
            _$insertNode(_el$63, _el$64);
            _$insertNode(_el$64, _el$65);
            _$insertNode(_el$65, _$createTextNode(`MCP sedang dipakai / terakhir`));
            _$insert(_el$63, _$createComponent(For, {
              get each() {
                return mcp().slice(0, limit());
              },
              children: (row) => (() => {
                var _el$85 = _$createElement("box"), _el$86 = _$createElement("text"), _el$87 = _$createTextNode(` \xB7 `);
                _$insertNode(_el$85, _el$86);
                _$insertNode(_el$86, _el$87);
                _$setProp(_el$86, "wrapMode", "char");
                _$insert(_el$86, () => row.item.name, _el$87);
                _$insert(_el$86, (() => {
                  var _c$8 = _$memo(() => row.ended === undefined);
                  return () => _c$8() ? `${row.item.calls.length} panggilan` : "Baru berakhir";
                })(), null);
                _$insert(_el$85, _$createComponent(For, {
                  get each() {
                    return row.item.calls.slice(0, 2);
                  },
                  children: (call) => (() => {
                    var _el$88 = _$createElement("text"), _el$89 = _$createTextNode(` \xB7 `);
                    _$insertNode(_el$88, _el$89);
                    _$setProp(_el$88, "wrapMode", "word");
                    _$insert(_el$88, () => detail(call).status, _el$89);
                    _$insert(_el$88, () => detail(call).action, null);
                    _$insert(_el$88, (() => {
                      var _c$9 = _$memo(() => !!detail(call).target);
                      return () => _c$9() ? ` \xB7 ${detail(call).target}` : "";
                    })(), null);
                    _$effect((_$p) => _$setProp(_el$88, "fg", theme().textMuted, _$p));
                    return _el$88;
                  })()
                }), null);
                _$effect((_$p) => _$setProp(_el$86, "fg", theme().text, _$p));
                return _el$85;
              })()
            }), null);
            _$insert(_el$63, _$createComponent(Show, {
              get when() {
                return mcp().length > limit();
              },
              get children() {
                var _el$67 = _$createElement("text"), _el$68 = _$createTextNode(`+`), _el$69 = _$createTextNode(` MCP lainnya`);
                _$insertNode(_el$67, _el$68);
                _$insertNode(_el$67, _el$69);
                _$insert(_el$67, () => mcp().length - limit(), _el$69);
                _$effect((_$p) => _$setProp(_el$67, "fg", theme().textMuted, _$p));
                return _el$67;
              }
            }), null);
            _$effect((_$p) => _$setProp(_el$64, "fg", theme().primary, _$p));
            return _el$63;
          }
        }), _$createComponent(For, {
          get each() {
            return props.api.state.mcp().filter((server) => !mcp().some((row) => row.item.name === server.name));
          },
          children: (server) => (() => {
            var _el$90 = _$createElement("text"), _el$91 = _$createTextNode(` \xB7 `);
            _$insertNode(_el$90, _el$91);
            _$setProp(_el$90, "wrapMode", "char");
            _$insert(_el$90, () => server.name, _el$91);
            _$insert(_el$90, (() => {
              var _c$0 = _$memo(() => server.status === "connected");
              return () => _c$0() ? "Terhubung \xB7 tidak sedang dipakai" : server.status;
            })(), null);
            _$effect((_$p) => _$setProp(_el$90, "fg", server.status === "connected" ? theme().textMuted : theme().warning, _$p));
            return _el$90;
          })()
        }), _$createComponent(Show, {
          get when() {
            return !props.api.state.mcp().length;
          },
          get children() {
            var _el$70 = _$createElement("text");
            _$insertNode(_el$70, _$createTextNode(`Tidak ada server MCP.`));
            _$effect((_$p) => _$setProp(_el$70, "fg", theme().textMuted, _$p));
            return _el$70;
          }
        })];
      }
    }), null);
    _$insert(_el$47, _$createComponent(InfoCard, {
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
            var _el$72 = _$createElement("box");
            _$insert(_el$72, _$createComponent(For, {
              get each() {
                return tools().slice(0, limit());
              },
              children: (row) => (() => {
                var _el$92 = _$createElement("box"), _el$93 = _$createElement("text"), _el$94 = _$createTextNode(` \xB7 `);
                _$insertNode(_el$92, _el$93);
                _$insertNode(_el$93, _el$94);
                _$setProp(_el$93, "wrapMode", "word");
                _$insert(_el$93, () => detail(row.item).action, _el$94);
                _$insert(_el$93, () => detail(row.item).status, null);
                _$insert(_el$93, (() => {
                  var _c$1 = _$memo(() => !!detail(row.item).target);
                  return () => _c$1() ? ` \xB7 ${detail(row.item).target}` : "";
                })(), null);
                _$insert(_el$92, _$createComponent(Show, {
                  get when() {
                    return detail(row.item).result;
                  },
                  get children() {
                    var _el$95 = _$createElement("text");
                    _$setProp(_el$95, "wrapMode", "word");
                    _$insert(_el$95, () => detail(row.item).result);
                    _$effect((_$p) => _$setProp(_el$95, "fg", theme().textMuted, _$p));
                    return _el$95;
                  }
                }), null);
                _$effect((_$p) => _$setProp(_el$93, "fg", theme().text, _$p));
                return _el$92;
              })()
            }), null);
            _$insert(_el$72, _$createComponent(Show, {
              get when() {
                return tools().length > limit();
              },
              get children() {
                var _el$73 = _$createElement("text"), _el$74 = _$createTextNode(`+`), _el$75 = _$createTextNode(` tool lainnya`);
                _$insertNode(_el$73, _el$74);
                _$insertNode(_el$73, _el$75);
                _$insert(_el$73, () => tools().length - limit(), _el$75);
                _$effect((_$p) => _$setProp(_el$73, "fg", theme().textMuted, _$p));
                return _el$73;
              }
            }), null);
            return _el$72;
          }
        }), _$createComponent(Show, {
          get when() {
            return _$memo(() => !!(activity().latest && !tools().slice(0, limit()).some((row) => row.item.callID === activity().latest?.callID) && !mcp().some((row) => row.item.calls.some((call) => call.callID === activity().latest?.callID)) && !["task", "subagent"].includes(activity().latest.tool)))() ? activity().latest : undefined;
          },
          children: (latest) => (() => {
            var _el$96 = _$createElement("box"), _el$97 = _$createElement("text"), _el$98 = _$createElement("text");
            _$insertNode(_el$96, _el$97);
            _$insertNode(_el$96, _el$98);
            _$setProp(_el$97, "wrapMode", "word");
            _$insert(_el$97, () => activityDetail(latest()).target || activityDetail(latest()).action);
            _$setProp(_el$98, "wrapMode", "word");
            _$insert(_el$98, () => activityDetail(latest()).result || "Masih diproses; belum ada hasil akhir.");
            _$effect((_p$) => {
              var _v$14 = theme().text, _v$15 = theme().textMuted;
              _v$14 !== _p$.e && (_p$.e = _$setProp(_el$97, "fg", _v$14, _p$.e));
              _v$15 !== _p$.t && (_p$.t = _$setProp(_el$98, "fg", _v$15, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$96;
          })()
        }), (() => {
          var _el$76 = _$createElement("text");
          _$insertNode(_el$76, _$createTextNode(`Hasil tes: lihat keluaran pengujian di percakapan; status tool bukan bukti tes lulus.`));
          _$setProp(_el$76, "wrapMode", "word");
          _$effect((_$p) => _$setProp(_el$76, "fg", theme().textMuted, _$p));
          return _el$76;
        })()];
      }
    }), null);
    _$insert(_el$47, _$createComponent(InfoCard, {
      get api() {
        return props.api;
      },
      name: "context",
      title: "Laporan token provider",
      get summary() {
        return _$memo(() => data().used === undefined)() ? "Token belum dilaporkan" : `${compact(data().used ?? NaN)} token \xB7 ${data().percent === undefined ? "konteks \u2014" : `${data().percent}% konteks`} \xB7 $${data().cost.toFixed(4)}`;
      },
      get children() {
        var _el$78 = _$createElement("text"), _el$79 = _$createTextNode(` \xB7 `), _el$80 = _$createTextNode(` \xB7 `), _el$81 = _$createTextNode(` \xB7 $`);
        _$insertNode(_el$78, _el$79);
        _$insertNode(_el$78, _el$80);
        _$insertNode(_el$78, _el$81);
        _$setProp(_el$78, "wrapMode", "char");
        _$insert(_el$78, () => data().provider, _el$79);
        _$insert(_el$78, (() => {
          var _c$6 = _$memo(() => data().used === undefined);
          return () => _c$6() ? "\u2014 token" : `${compact(data().used ?? NaN)} token`;
        })(), _el$80);
        _$insert(_el$78, (() => {
          var _c$7 = _$memo(() => data().percent === undefined);
          return () => _c$7() ? "konteks belum diukur" : `${data().percent}% konteks`;
        })(), _el$81);
        _$insert(_el$78, () => data().cost.toFixed(4), null);
        _$effect((_$p) => _$setProp(_el$78, "fg", theme().textMuted, _$p));
        return _el$78;
      }
    }), null);
    _$insert(_el$47, _$createComponent(InfoCard, {
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
              var _el$99 = _$createElement("text");
              _$insertNode(_el$99, _$createTextNode(`Belum ada daftar tugas di sesi ini.`));
              _$effect((_$p) => _$setProp(_el$99, "fg", theme().textMuted, _$p));
              return _el$99;
            })();
          },
          get children() {
            return [(() => {
              var _el$82 = _$createElement("text"), _el$83 = _$createTextNode(` berjalan \xB7 `), _el$84 = _$createTextNode(` antre`);
              _$insertNode(_el$82, _el$83);
              _$insertNode(_el$82, _el$84);
              _$insert(_el$82, () => activity().todos.filter((todo) => todo.status === "in_progress").length, _el$83);
              _$insert(_el$82, () => activity().todos.filter((todo) => todo.status === "pending").length, _el$84);
              _$effect((_$p) => _$setProp(_el$82, "fg", theme().textMuted, _$p));
              return _el$82;
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
                var _el$101 = _$createElement("box"), _el$102 = _$createElement("text"), _el$103 = _$createElement("text");
                _$insertNode(_el$101, _el$102);
                _$insertNode(_el$101, _el$103);
                _$setProp(_el$101, "marginTop", 1);
                _$insert(_el$102, (() => {
                  var _c$10 = _$memo(() => todo.status === "completed");
                  return () => _c$10() ? "\u2713 Selesai" : todo.status === "in_progress" ? "\u203A Sedang dikerjakan" : "\xB7 Menunggu";
                })());
                _$setProp(_el$103, "wrapMode", "word");
                _$insert(_el$103, () => todo.content);
                _$effect((_p$) => {
                  var _v$16 = todo.status === "in_progress" ? theme().primary : theme().textMuted, _v$17 = todo.status === "completed" ? theme().textMuted : theme().text;
                  _v$16 !== _p$.e && (_p$.e = _$setProp(_el$102, "fg", _v$16, _p$.e));
                  _v$17 !== _p$.t && (_p$.t = _$setProp(_el$103, "fg", _v$17, _p$.t));
                  return _p$;
                }, {
                  e: undefined,
                  t: undefined
                });
                return _el$101;
              })()
            })];
          }
        });
      }
    }), null);
    _$insert(_el$47, _$createComponent(WorkspaceCard, {
      get api() {
        return props.api;
      },
      get id() {
        return props.id;
      }
    }), null);
    _$effect((_p$) => {
      var _v$12 = theme().text, _v$13 = theme().textMuted;
      _v$12 !== _p$.e && (_p$.e = _$setProp(_el$49, "fg", _v$12, _p$.e));
      _v$13 !== _p$.t && (_p$.t = _$setProp(_el$51, "fg", _v$13, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$47;
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
      var _el$104 = _$createElement("box"), _el$105 = _$createElement("text"), _el$106 = _$createElement("b"), _el$108 = _$createTextNode(` \xB7 Esc tutup`), _el$109 = _$createElement("scrollbox");
      _$insertNode(_el$104, _el$105);
      _$insertNode(_el$104, _el$109);
      _$setProp(_el$104, "padding", 1);
      _$insertNode(_el$105, _el$106);
      _$insertNode(_el$105, _el$108);
      _$insertNode(_el$106, _$createTextNode(`Studio \xB7 Detail sesi`));
      _$insert(_el$109, _$createComponent(Overview, {
        get api() {
          return props.api;
        },
        get id() {
          return props.id;
        },
        mini: true
      }));
      _$effect((_p$) => {
        var _v$18 = theme().primary, _v$19 = Math.max(5, size().height - 10);
        _v$18 !== _p$.e && (_p$.e = _$setProp(_el$105, "fg", _v$18, _p$.e));
        _v$19 !== _p$.t && (_p$.t = _$setProp(_el$109, "height", _v$19, _p$.t));
        return _p$;
      }, {
        e: undefined,
        t: undefined
      });
      return _el$104;
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
      var _el$110 = _$createElement("box"), _el$111 = _$createElement("box"), _el$112 = _$createElement("text"), _el$113 = _$createElement("b"), _el$114 = _$createTextNode(`ASYNC \xB7 `), _el$115 = _$createElement("text"), _el$116 = _$createElement("text"), _el$117 = _$createElement("text"), _el$118 = _$createTextNode(`\u25CF `), _el$119 = _$createTextNode(` run \xB7 \u2713 `), _el$120 = _$createTextNode(` done \xB7 \u2715 `), _el$121 = _$createTextNode(` err \xB7 \u03A3 `), _el$122 = _$createElement("text"), _el$123 = _$createElement("text"), _el$124 = _$createElement("box"), _el$125 = _$createElement("text");
      _$insertNode(_el$110, _el$111);
      _$setProp(_el$110, "flexDirection", "row");
      _$setProp(_el$110, "width", "100%");
      _$setProp(_el$110, "height", 8);
      _$setProp(_el$110, "flexShrink", 0);
      _$setProp(_el$110, "gap", 1);
      _$setProp(_el$110, "paddingLeft", 1);
      _$setProp(_el$110, "paddingRight", 1);
      _$insertNode(_el$111, _el$112);
      _$insertNode(_el$111, _el$115);
      _$insertNode(_el$111, _el$116);
      _$insertNode(_el$111, _el$117);
      _$insertNode(_el$111, _el$122);
      _$insertNode(_el$111, _el$123);
      _$insertNode(_el$111, _el$124);
      _$setProp(_el$111, "flexGrow", 1);
      _$setProp(_el$111, "minWidth", 0);
      _$setProp(_el$111, "flexShrink", 1);
      _$insertNode(_el$112, _el$113);
      _$setProp(_el$112, "height", 1);
      _$insertNode(_el$113, _el$114);
      _$insert(_el$113, () => data().agent ?? "Sesi", null);
      _$setProp(_el$115, "height", 1);
      _$insert(_el$115, (() => {
        var _c$11 = _$memo(() => !!activity().attention);
        return () => _c$11() ? `${activity().attention} permintaan menunggu jawaban` : _$memo(() => identity().running > 0)() ? `${identity().running} subagent berjalan` : "Siap";
      })());
      _$setProp(_el$116, "height", 1);
      _$insert(_el$116, () => data().model, null);
      _$insert(_el$116, (() => {
        var _c$12 = _$memo(() => data().used === undefined);
        return () => _c$12() ? "" : ` \xB7 ${compact(data().used ?? NaN)} token (laporan)`;
      })(), null);
      _$insertNode(_el$117, _el$118);
      _$insertNode(_el$117, _el$119);
      _$insertNode(_el$117, _el$120);
      _$insertNode(_el$117, _el$121);
      _$setProp(_el$117, "height", 1);
      _$insert(_el$117, () => identity().running, _el$119);
      _$insert(_el$117, () => identity().done, _el$120);
      _$insert(_el$117, () => identity().error, _el$121);
      _$insert(_el$117, () => identity().total, null);
      _$setProp(_el$122, "height", 1);
      _$insert(_el$122, (() => {
        var _c$13 = _$memo(() => !!activity().latest);
        return () => _c$13() ? `${activityDetail(activity().latest).status} \xB7 ${activityDetail(activity().latest).action}` : "Belum ada aktivitas tool";
      })());
      _$setProp(_el$123, "height", 1);
      _$insert(_el$123, (() => {
        var _c$14 = _$memo(() => !!activity().latest);
        return () => _c$14() ? activityDetail(activity().latest).target : "";
      })());
      _$insertNode(_el$124, _el$125);
      _$setProp(_el$124, "onMouseDown", (event) => {
        if (event.button === 0) {
          event.stopPropagation();
          open();
        }
      });
      _$insertNode(_el$125, _$createTextNode(`/studio-panel \xB7 detail`));
      _$setProp(_el$125, "height", 1);
      _$effect((_p$) => {
        var _v$20 = theme().backgroundPanel, _v$21 = theme().primary, _v$22 = theme().text, _v$23 = theme().textMuted, _v$24 = theme().text, _v$25 = theme().text, _v$26 = theme().textMuted, _v$27 = theme().primary;
        _v$20 !== _p$.e && (_p$.e = _$setProp(_el$110, "backgroundColor", _v$20, _p$.e));
        _v$21 !== _p$.t && (_p$.t = _$setProp(_el$112, "fg", _v$21, _p$.t));
        _v$22 !== _p$.a && (_p$.a = _$setProp(_el$115, "fg", _v$22, _p$.a));
        _v$23 !== _p$.o && (_p$.o = _$setProp(_el$116, "fg", _v$23, _p$.o));
        _v$24 !== _p$.i && (_p$.i = _$setProp(_el$117, "fg", _v$24, _p$.i));
        _v$25 !== _p$.n && (_p$.n = _$setProp(_el$122, "fg", _v$25, _p$.n));
        _v$26 !== _p$.s && (_p$.s = _$setProp(_el$123, "fg", _v$26, _p$.s));
        _v$27 !== _p$.h && (_p$.h = _$setProp(_el$125, "fg", _v$27, _p$.h));
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
      return _el$110;
    }
  });
}
function StatusBar(props) {
  const size = useTerminalDimensions();
  const theme = () => props.api.theme.current;
  const mcp = () => props.api.state.mcp();
  const plugins = () => props.api.plugins.list().filter((item) => item.source !== "internal");
  return (() => {
    var _el$127 = _$createElement("box"), _el$128 = _$createElement("text"), _el$129 = _$createElement("b"), _el$136 = _$createElement("text");
    _$insertNode(_el$127, _el$128);
    _$insertNode(_el$127, _el$136);
    _$setProp(_el$127, "flexDirection", "row");
    _$setProp(_el$127, "justifyContent", "space-between");
    _$setProp(_el$127, "paddingLeft", 1);
    _$setProp(_el$127, "paddingRight", 1);
    _$setProp(_el$127, "width", "100%");
    _$insertNode(_el$128, _el$129);
    _$insertNode(_el$129, _$createTextNode(`ASYNC`));
    _$insert(_el$127, _$createComponent(Show, {
      get when() {
        return size().width >= 65;
      },
      get children() {
        var _el$131 = _$createElement("text"), _el$132 = _$createTextNode(`/`), _el$133 = _$createTextNode(` MCP \xB7 `), _el$134 = _$createTextNode(`/`), _el$135 = _$createTextNode(` plugin TUI aktif`);
        _$insertNode(_el$131, _el$132);
        _$insertNode(_el$131, _el$133);
        _$insertNode(_el$131, _el$134);
        _$insertNode(_el$131, _el$135);
        _$insert(_el$131, () => mcp().filter((item) => item.status === "connected").length, _el$132);
        _$insert(_el$131, () => mcp().length, _el$133);
        _$insert(_el$131, () => plugins().filter((item) => item.active).length, _el$134);
        _$insert(_el$131, () => plugins().length, _el$135);
        _$effect((_$p) => _$setProp(_el$131, "fg", theme().textMuted, _$p));
        return _el$131;
      }
    }), _el$136);
    _$insert(_el$136, () => props.api.state.vcs?.branch ?? "lokal");
    _$effect((_p$) => {
      var _v$28 = theme().backgroundPanel, _v$29 = theme().primary, _v$30 = theme().textMuted;
      _v$28 !== _p$.e && (_p$.e = _$setProp(_el$127, "backgroundColor", _v$28, _p$.e));
      _v$29 !== _p$.t && (_p$.t = _$setProp(_el$128, "fg", _v$29, _p$.t));
      _v$30 !== _p$.a && (_p$.a = _$setProp(_el$136, "fg", _v$30, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$127;
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
            var _el$137 = _$createElement("box"), _el$138 = _$createElement("text"), _el$139 = _$createElement("b"), _el$141 = _$createElement("text"), _el$142 = _$createElement("b");
            _$insertNode(_el$137, _el$138);
            _$insertNode(_el$137, _el$141);
            _$setProp(_el$137, "gap", 1);
            _$setProp(_el$137, "paddingBottom", 1);
            _$insertNode(_el$138, _el$139);
            _$insertNode(_el$139, _$createTextNode(`ASYNC AGENT / SESI`));
            _$insertNode(_el$141, _el$142);
            _$setProp(_el$141, "wrapMode", "word");
            _$insert(_el$142, () => props.title);
            _$insert(_el$137, _$createComponent(Show, {
              get when() {
                return props.share_url;
              },
              get children() {
                var _el$143 = _$createElement("text");
                _$setProp(_el$143, "wrapMode", "char");
                _$insert(_el$143, () => props.share_url);
                _$effect((_$p) => _$setProp(_el$143, "fg", api.theme.current.textMuted, _$p));
                return _el$143;
              }
            }), null);
            _$effect((_p$) => {
              var _v$31 = api.theme.current.primary, _v$32 = api.theme.current.text;
              _v$31 !== _p$.e && (_p$.e = _$setProp(_el$138, "fg", _v$31, _p$.e));
              _v$32 !== _p$.t && (_p$.t = _$setProp(_el$141, "fg", _v$32, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$137;
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
        home_footer() {
          return (() => {
            var _el$144 = _$createElement("text"), _el$145 = _$createTextNode(`OPENCODE ASYNC AGENT \xB7 v`);
            _$insertNode(_el$144, _el$145);
            _$insert(_el$144, () => api.app.version, null);
            _$effect((_$p) => _$setProp(_el$144, "fg", api.theme.current.textMuted, _$p));
            return _el$144;
          })();
        },
        app_bottom() {
          return (() => {
            var _el$146 = _$createElement("box");
            _$setProp(_el$146, "flexShrink", 0);
            _$insert(_el$146, _$createComponent(Show, {
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
            _$insert(_el$146, _$createComponent(StatusBar, {
              api
            }), null);
            return _el$146;
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
