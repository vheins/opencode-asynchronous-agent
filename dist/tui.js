// @bun
// src/tui.tsx
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
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
  const clean = (value) => typeof value === "string" ? value.split("").map((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159 ? " " : char).join("").replace(/(?:Bearer\s+\S+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+)/gi, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 120) : "";
  const labels = { read: "Reading file", edit: "Editing file", write: "Writing file", glob: "Finding files", grep: "Searching code", search: "Searching information", bash: "Running command", task: "Delegating agent", subagent: "Delegating agent" };
  const action = labels[tool.tool] ?? clean(tool.tool);
  const target = clean(input.description) || clean(input.filePath ?? input.file_path ?? input.path) || clean(input.title);
  const status = { pending: "Queued", running: "Running", completed: "Done", error: "Failed" }[tool.state.status];
  const background = tool.state.status === "completed" && tool.state.metadata.background === true;
  const duration = tool.state.status === "completed" || tool.state.status === "error" ? ` \xB7 ${Math.max(0, (tool.state.time.end - tool.state.time.start) / 1000).toFixed(1)}s` : "";
  const result = tool.state.status === "error" ? "Check the failure details in the conversation." : background ? "Launched; child status is tracked separately." : tool.state.status === "completed" ? `Tool finished${duration}.` : "";
  return { action, target, status: background ? "Launched" : status, result };
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
    model: model ?? "Waiting for response",
    provider: provider ?? "No usage yet",
    agent: latest?.role === "assistant" ? latest.agent : undefined,
    count: messages.length,
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
    const launching = tool.state.status === "running" || tool.state.status === "pending";
    const active2 = waiting > 0 || (status ? status.type !== "idle" : launching);
    const label = waiting ? "Waiting for answer" : status?.type === "retry" ? "Retrying" : status?.type === "busy" ? "Working" : launching ? "Working" : "Done";
    const childTodos = child ? api.state.session.todo(child) : [];
    const progress = {
      completed: childTodos.filter((todo) => todo.status === "completed").length,
      inProgress: childTodos.filter((todo) => todo.status === "in_progress").length,
      total: childTodos.length
    };
    return [{
      key: child ?? tool.callID,
      id: child ?? tool.callID,
      name: typeof tool.state.input.subagent_type === "string" ? tool.state.input.subagent_type : "subagent",
      label,
      active: active2,
      progress,
      target: activityDetail(tool).target
    }];
  }).filter((agent, index, list) => list.findIndex((item) => item.key === agent.key) === index).sort((a, b) => Number(b.active) - Number(a.active));
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
function renderBar(fraction, width, frame = 0) {
  const cells = Math.max(1, Math.floor(width));
  const ratio = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  const filled = Math.round(ratio * cells);
  if (filled <= 0)
    return "\u2591".repeat(cells);
  const window = Math.max(1, Math.round(cells / 4));
  const span = filled + window - 1;
  const head = (Math.floor(Number.isFinite(frame) ? frame : 0) % span + span) % span - window + 1;
  let bar = "";
  for (let index = 0;index < cells; index++) {
    if (index >= filled)
      bar += "\u2591";
    else if (index >= head && index < head + window)
      bar += "\u2588";
    else
      bar += "\u2593";
  }
  return bar;
}
function mainTodoProgress(todos) {
  const total = todos.length;
  const completed = todos.filter((todo) => todo.status === "completed").length;
  return { completed, total, fraction: total > 0 ? completed / total : 0 };
}
function subagentTodoProgress(agents) {
  let running = 0;
  let completed = 0;
  let total = 0;
  for (const agent of agents) {
    running += agent.progress?.inProgress ?? 0;
    completed += agent.progress?.completed ?? 0;
    total += agent.progress?.total ?? 0;
  }
  return { running, completed, total, fraction: total > 0 ? completed / total : 0 };
}

// src/subagent.ts
function latestAssistant(messages) {
  return [...messages].reverse().find((message) => message.role === "assistant");
}
function subagentModel(session, messages) {
  const assistant = latestAssistant(messages);
  const providerID = assistant?.providerID ?? session?.model?.providerID;
  const modelID = assistant?.modelID ?? session?.model?.id;
  return { providerID, modelID };
}
function latestReportedTokens(messages) {
  for (let index = messages.length - 1;index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant")
      continue;
    const { input, output, reasoning, cache } = message.tokens;
    if ([input, output, reasoning, cache.read, cache.write].some((value) => Number.isFinite(value) && value > 0))
      return message.tokens;
  }
  return;
}
function subagentDetails(session, messages, todos, limit) {
  const infos = messages.map((entry) => entry.info);
  const assistant = latestAssistant(infos);
  const tools = messages.flatMap((entry) => entry.parts.filter((part) => part.type === "tool"));
  const current = [...tools].reverse().find((part) => part.state.status === "running" || part.state.status === "pending");
  const latest = current ?? tools.at(-1);
  const usage = latestReportedTokens(infos);
  const used = usage ? [usage.input, usage.output, usage.reasoning, usage.cache.read, usage.cache.write].reduce((sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 0), 0) : 0;
  const { providerID, modelID } = subagentModel(session, infos);
  return {
    title: session?.title ?? "Title not reported yet",
    model: providerID && modelID ? `${providerID} / ${modelID}` : "Model not reported yet",
    started: session?.time.created,
    activity: latest ? activityDetail(latest) : undefined,
    current: Boolean(current),
    todos,
    completed: todos.filter((todo) => todo.status === "completed").length,
    toolCount: tools.length,
    used: used > 0 ? used : undefined,
    output: usage && usage.output > 0 ? usage.output : undefined,
    limit,
    percent: used > 0 && limit !== undefined && limit > 0 ? Math.round(used / limit * 100) : undefined
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
    throw new Error("Subagent details not available from host");
  const list = messages.data ?? [];
  const { providerID, modelID } = subagentModel(session.data, list.map((entry) => entry.info));
  const limit = providerID && modelID ? api.state.provider.find((item) => item.id === providerID)?.models[modelID]?.limit.context : undefined;
  return subagentDetails(session.data, list, todos.data ?? [], limit);
}
function elapsedLabel(start, now) {
  if (start === undefined || !Number.isFinite(start) || start <= 0)
    return "Duration not available yet";
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return hours ? `${hours}h ${minutes}m ${seconds % 60}s` : `${minutes}m ${seconds % 60}s`;
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
      errors.push(`Unable to read ${relative(root, current.path) || "."}`);
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
        repos.push({ path: relative(root, current.path) || ".", branch, files, ...exit !== 0 ? { error: "Git unavailable, failed, or timed out" } : {} });
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
function basename(path) {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
function isVowel(char) {
  return "AEIOU".includes(char);
}
function middleLetter(segment, avoid) {
  const inner = segment.slice(1, -1).split("");
  const consonants = inner.filter((char) => !isVowel(char));
  return consonants.find((char) => char !== avoid) ?? consonants[0] ?? inner[0] ?? segment[0] ?? "";
}
function abbreviateAgentName(name) {
  const segments = name.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  const letters = segments.join("");
  if (!letters)
    return "?";
  if (letters.length <= 3)
    return letters;
  if (segments.length === 1)
    return letters.slice(0, 3);
  const first = segments[0][0];
  const middle = middleLetter(segments[segments.length - 1], first);
  const end = letters[letters.length - 1];
  return `${first}${middle}${end}`.slice(0, 4);
}
function mcpPluginLabel(api) {
  const mcp = api.state.mcp();
  const plugins = api.plugins.list().filter((item) => item.source !== "internal");
  return `${mcp.filter((item) => item.status === "connected").length}/${mcp.length} MCP | ${plugins.filter((item) => item.active).length}/${plugins.length} plugin`;
}
function fitStatus(segments, budget) {
  const kept = segments.map((segment) => ({
    ...segment
  }));
  const total = () => kept.reduce((sum, segment) => sum + segment.text.length, 0);
  for (const segment of [...kept].sort((a, b) => b.priority - a.priority)) {
    if (total() <= budget)
      break;
    if (segment.priority === 0)
      continue;
    const index = kept.indexOf(segment);
    if (index >= 0)
      kept.splice(index, 1);
  }
  const last = kept[kept.length - 1];
  if (last && total() > budget)
    last.text = `${last.text.slice(0, Math.max(1, last.text.length - (total() - budget) - 1))}\u2026`;
  return kept;
}
function createClock(interval = 1000) {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), interval);
  onCleanup(() => clearInterval(timer));
  return now;
}
function clockLabel(time) {
  const date = new Date(time);
  const day = date.toLocaleDateString("en", {
    weekday: "short"
  });
  const rest = date.toLocaleDateString("en", {
    day: "2-digit",
    month: "short"
  });
  const clock = date.toLocaleTimeString("en", {
    hour12: false
  });
  return `${day} ${rest} \xB7 ${clock}`;
}
function navigateToSession(api, target) {
  if (!target || !target.startsWith("ses_"))
    return;
  api.route.navigate("session", {
    sessionID: target
  });
}
var creatureGrowthCap = 200;
var creatureStages = [{
  name: "Egg",
  frames: [[" .--.", "(    )", " '--'"], [" .--.", "( .. )", " '--'"]]
}, {
  name: "Hatchling",
  frames: [["  __", " (oo)", " /||\\"], ["  __", " (--)", " /||\\"]]
}, {
  name: "Child",
  frames: [[" .----.", "( ^  ^ )", " \\ -- /"], [" .----.", "( ^  ^ )", " \\ oo /"]]
}, {
  name: "Teen",
  frames: [["  .---.", " ( ^ ^ )", " <|   |>"], ["  .---.", " ( ^ ^ )", " <| o |>"]]
}, {
  name: "Adult",
  frames: [["  ___", " /^ ^\\", " | - |", " <| |>"], ["  ___", " /^ ^\\", " | o |", " <| |>"]]
}, {
  name: "Elder",
  frames: [["  /\\_/\\", " ( o o )", "  \\ - /", " /|   |\\"], ["  /\\_/\\", " ( ^ ^ )", "  \\ o /", " /|   |\\"]]
}, {
  name: "Ancient",
  frames: [["  _/\\_", " / o o \\", " |  ^  |", " <|/ \\|>"], ["  _/\\_", " / - - \\", " |  o  |", " <|/ \\|>"]]
}, {
  name: "Mythic",
  frames: [[" \\_|_|_/", "  (o)(o)", " /| ^ |\\", "  ^   ^"], [" \\_|_|_/", "  (-)(-)", " /| o |\\", "  ^   ^"]]
}, {
  name: "Legendary",
  frames: [[" /\\___/\\", "( o  o )", " \\  ^  /", " <|/ \\|>"], [" /\\___/\\", "( ^  ^ )", " \\  o  /", " <|/ \\|>"]]
}, {
  name: "Divine",
  frames: [[" \\|/^\\|/", "  (o o)", " <| ^ |>", "  ^/ \\^"], [" \\|/^\\|/", "  (^ ^)", " <| o |>", "  ^/ \\^"]]
}];
var peakMessages = new Map;
function messagePeak(key, count) {
  const peak = Math.max(peakMessages.get(key) ?? 0, Math.max(0, count));
  peakMessages.set(key, peak);
  return peak;
}
var creaturePeak = new Map;
function growthStage(key, count) {
  const capped = Math.max(0, Math.min(creatureGrowthCap, count));
  const peak = Math.max(creaturePeak.get(key) ?? 0, capped);
  creaturePeak.set(key, peak);
  return creatureStages[Math.min(creatureStages.length - 1, Math.floor(peak / (creatureGrowthCap / creatureStages.length)))];
}
var [creatureFrame, setCreatureFrame] = createSignal(0);
var creatureTimer;
var creatureSubscribers = 0;
function useCreatureAnimation(working) {
  createEffect(() => {
    if (!working())
      return;
    creatureSubscribers++;
    if (!creatureTimer)
      creatureTimer = setInterval(() => setCreatureFrame((frame) => frame + 1), 200);
    onCleanup(() => {
      creatureSubscribers = Math.max(0, creatureSubscribers - 1);
      if (creatureSubscribers === 0 && creatureTimer) {
        clearInterval(creatureTimer);
        creatureTimer = undefined;
      }
    });
  });
}
function statusColor(theme, kind) {
  if (kind === "run")
    return theme.accent;
  if (kind === "done")
    return theme.success;
  if (kind === "err")
    return theme.error;
  return theme.textMuted;
}
function activityKind(status) {
  if (status === "Running" || status === "Queued" || status === "Launched")
    return "run";
  if (status === "Done")
    return "done";
  if (status === "Failed")
    return "err";
  return;
}
function asyncIdentity(api, id) {
  const tools = api.state.session.messages(id).flatMap((message) => api.state.part(message.id)).filter((part) => part.type === "tool").filter((part) => part.tool === "task" || part.tool === "subagent");
  const live = new Set(sidebarActivity(api, id).agents.filter((agent) => agent.active).map((agent) => agent.id));
  const rows = tools.map((part) => {
    const child = part.state.status === "pending" ? undefined : typeof part.state.metadata?.sessionId === "string" ? part.state.metadata.sessionId : undefined;
    const key = child ?? part.callID;
    const status = live.has(key) || part.state.status === "running" || part.state.status === "pending" ? "running" : part.state.status === "error" ? "error" : "done";
    return {
      id: key,
      status
    };
  });
  for (const agent of live)
    if (!rows.some((row) => row.id === agent))
      rows.push({
        id: agent,
        status: "running"
      });
  return {
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
        title: ok ? "Subagent finished" : "Subagent failed",
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
function taskProgressVisible() {
  const raw = String(process.env.OPENCODE_SUBAGENT_TASK_PROGRESS ?? "").trim().toLowerCase();
  return !(raw === "" || raw === "0" || raw === "false" || raw === "off" || raw === "no");
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
    title: `Studio: ${open() ? "close" : "open"} ${props.title}`,
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
    var _el$ = _$createElement("box"), _el$2 = _$createElement("box"), _el$3 = _$createElement("text"), _el$4 = _$createElement("b"), _el$5 = _$createElement("text"), _el$6 = _$createElement("b"), _el$7 = _$createTextNode(` `), _el$9 = _$createElement("text");
    _$insertNode(_el$, _el$2);
    _$insertNode(_el$, _el$9);
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
    _$setProp(_el$5, "wrapMode", "none");
    _$setProp(_el$5, "truncate", true);
    _$setProp(_el$5, "flexShrink", 1);
    _$insertNode(_el$6, _el$7);
    _$insert(_el$6, () => props.title, null);
    _$insert(_el$6, () => clickable() ? " \u2192" : "", null);
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return props.summaryTitle;
      },
      get children() {
        var _el$8 = _$createElement("text");
        _$setProp(_el$8, "wrapMode", "none");
        _$setProp(_el$8, "truncate", true);
        _$setProp(_el$8, "onMouseDown", header);
        _$insert(_el$8, () => props.summaryTitle);
        _$effect((_$p) => _$setProp(_el$8, "fg", theme().textMuted, _$p));
        return _el$8;
      }
    }), _el$9);
    _$setProp(_el$9, "wrapMode", "word");
    _$setProp(_el$9, "onMouseDown", header);
    _$insert(_el$9, () => props.summary);
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return open();
      },
      get children() {
        var _el$0 = _$createElement("box");
        _$setProp(_el$0, "paddingTop", 1);
        _$setProp(_el$0, "paddingBottom", 1);
        _$insert(_el$0, () => props.children);
        return _el$0;
      }
    }), null);
    _$effect((_p$) => {
      var _v$ = hovered() ? theme().backgroundPanel : theme().backgroundElement, _v$2 = clickable() ? () => setHovered(true) : undefined, _v$3 = clickable() ? () => setHovered(false) : undefined, _v$4 = hovered() ? theme().accent : theme().primary, _v$5 = hovered() ? theme().accent : theme().primary, _v$6 = theme().textMuted;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$, "backgroundColor", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$, "onMouseOver", _v$2, _p$.t));
      _v$3 !== _p$.a && (_p$.a = _$setProp(_el$, "onMouseOut", _v$3, _p$.a));
      _v$4 !== _p$.o && (_p$.o = _$setProp(_el$3, "fg", _v$4, _p$.o));
      _v$5 !== _p$.i && (_p$.i = _$setProp(_el$5, "fg", _v$5, _p$.i));
      _v$6 !== _p$.n && (_p$.n = _$setProp(_el$9, "fg", _v$6, _p$.n));
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
  const now = createClock();
  const theme = () => props.api.theme.current;
  createEffect(() => {
    const id = props.agent.id;
    const ended2 = props.ended;
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
          setError("Details not available yet; retrying.");
      } finally {
        pending = false;
      }
    };
    refresh();
    const poll = ended2 || !props.agent.active ? undefined : setInterval(() => void refresh(), 5000);
    onCleanup(() => {
      controller.abort();
      clearInterval(poll);
    });
  });
  const session = () => props.api.state.session.get(props.agent.id);
  const started = () => session()?.time.created ?? data()?.started;
  const ended = () => props.ended ?? (props.agent.active ? undefined : session()?.time.updated);
  const elapsed = () => {
    const start = started();
    const end = ended() ?? now();
    return start !== undefined && Number.isFinite(start) && start > 0 ? Math.max(0, end - start) : 0;
  };
  const summaryTitle = () => data()?.title ?? "Loading title\u2026";
  const summary = () => {
    const detail = data();
    const seconds = elapsed() / 1000;
    return [detail ? `${detail.toolCount} Tools` : "\u2026 Tools", elapsedLabel(started(), ended() ?? now()), detail?.used !== undefined ? `${compact(detail.used)} (${detail.percent ?? 0}%)` : undefined, detail?.output !== undefined && seconds > 0 ? `${Math.round(detail.output / seconds)} Tok/s` : undefined].filter((part) => Boolean(part)).join(" \xB7 ");
  };
  const progress = () => props.agent.progress?.total ? ` \xB7 ${props.agent.progress.completed}/${props.agent.progress.total}` : "";
  return _$createComponent(InfoCard, {
    get api() {
      return props.api;
    },
    get name() {
      return `agent-${props.agent.id}`;
    },
    get title() {
      return `${props.agent.name} \xB7 ${props.ended ? "Just ended" : props.agent.label}${progress()}`;
    },
    onActivate: () => navigateToSession(props.api, props.agent.id),
    get summaryTitle() {
      return summaryTitle();
    },
    get summary() {
      return summary();
    },
    get children() {
      return [_$createComponent(Show, {
        get when() {
          return props.agent.target;
        },
        get children() {
          var _el$1 = _$createElement("text");
          _$setProp(_el$1, "wrapMode", "word");
          _$insert(_el$1, () => props.agent.target);
          _$effect((_$p) => _$setProp(_el$1, "fg", theme().text, _$p));
          return _el$1;
        }
      }), _$createComponent(Show, {
        get when() {
          return error();
        },
        get children() {
          var _el$10 = _$createElement("text");
          _$insert(_el$10, error);
          _$effect((_$p) => _$setProp(_el$10, "fg", theme().warning, _$p));
          return _el$10;
        }
      }), _$createComponent(Show, {
        get when() {
          return data();
        },
        children: (detail) => (() => {
          var _el$11 = _$createElement("box"), _el$12 = _$createElement("text"), _el$14 = _$createElement("text");
          _$insertNode(_el$11, _el$12);
          _$insertNode(_el$11, _el$14);
          _$setProp(_el$11, "gap", 1);
          _$setProp(_el$12, "wrapMode", "word");
          _$insert(_el$12, (() => {
            var _c$ = _$memo(() => !!detail().activity);
            return () => _c$() ? `${detail().current ? "Now" : "Last"} \xB7 ${detail().activity.action} \xB7 ` : "Tool activity not reported yet.";
          })(), null);
          _$insert(_el$12, _$createComponent(Show, {
            get when() {
              return detail().activity;
            },
            children: (activity) => (() => {
              var _el$15 = _$createElement("span");
              _$insert(_el$15, () => activity().status);
              _$effect((_$p) => _$setProp(_el$15, "style", {
                fg: statusColor(theme(), activityKind(activity().status) ?? "total")
              }, _$p));
              return _el$15;
            })()
          }), null);
          _$insert(_el$11, _$createComponent(Show, {
            get when() {
              return detail().activity?.target;
            },
            get children() {
              var _el$13 = _$createElement("text");
              _$setProp(_el$13, "wrapMode", "char");
              _$insert(_el$13, () => detail().activity?.target);
              _$effect((_$p) => _$setProp(_el$13, "fg", theme().textMuted, _$p));
              return _el$13;
            }
          }), _el$14);
          _$insert(_el$14, (() => {
            var _c$2 = _$memo(() => !!detail().todos.length);
            return () => _c$2() ? `${detail().completed}/${detail().todos.length} tasks done` : "Task progress not reported yet.";
          })());
          _$insert(_el$11, _$createComponent(For, {
            get each() {
              return detail().todos;
            },
            children: (todo) => (() => {
              var _el$16 = _$createElement("text"), _el$17 = _$createTextNode(` `);
              _$insertNode(_el$16, _el$17);
              _$setProp(_el$16, "wrapMode", "word");
              _$insert(_el$16, (() => {
                var _c$3 = _$memo(() => todo.status === "completed");
                return () => _c$3() ? "\u2713" : todo.status === "in_progress" ? "\u203A" : "\xB7";
              })(), _el$17);
              _$insert(_el$16, () => todo.content, null);
              _$effect((_$p) => _$setProp(_el$16, "fg", todo.status === "in_progress" ? theme().text : theme().textMuted, _$p));
              return _el$16;
            })()
          }), null);
          _$effect((_p$) => {
            var _v$7 = theme().text, _v$8 = theme().textMuted;
            _v$7 !== _p$.e && (_p$.e = _$setProp(_el$12, "fg", _v$7, _p$.e));
            _v$8 !== _p$.t && (_p$.t = _$setProp(_el$14, "fg", _v$8, _p$.t));
            return _p$;
          }, {
            e: undefined,
            t: undefined
          });
          return _el$11;
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
          setError("Git scan failed. Check folder access and Git installation.");
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
    title: "Workspace & files",
    onOpen: setOpen,
    get summary() {
      return error() || (data() ? `${data().repos.length} Git repos \xB7 ${data().repos.reduce((n, repo) => n + repo.files.length, 0)} changed entries` : open() ? "Scanning repositories\u2026" : "Open to scan the repo root and subfolders");
    },
    get children() {
      return [(() => {
        var _el$18 = _$createElement("text");
        _$setProp(_el$18, "wrapMode", "char");
        _$insert(_el$18, () => props.api.state.path.directory);
        _$effect((_$p) => _$setProp(_el$18, "fg", theme().textMuted, _$p));
        return _el$18;
      })(), (() => {
        var _el$19 = _$createElement("text");
        _$insertNode(_el$19, _$createTextNode(`Local Git, not just session changes \xB7 refresh 15s`));
        _$effect((_$p) => _$setProp(_el$19, "fg", theme().textMuted, _$p));
        return _el$19;
      })(), _$createComponent(Show, {
        get when() {
          return data();
        },
        children: (scan) => (() => {
          var _el$23 = _$createElement("box");
          _$setProp(_el$23, "gap", 1);
          _$insert(_el$23, _$createComponent(For, {
            get each() {
              return scan().repos;
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
                  var _el$31 = _$createElement("text"), _el$32 = _$createTextNode(` `);
                  _$insertNode(_el$31, _el$32);
                  _$setProp(_el$31, "wrapMode", "char");
                  _$insert(_el$31, () => file.status, _el$32);
                  _$insert(_el$31, () => basename(file.path), null);
                  _$effect((_$p) => _$setProp(_el$31, "fg", theme().text, _$p));
                  return _el$31;
                })()
              }), null);
              _$effect((_$p) => _$setProp(_el$27, "fg", theme().primary, _$p));
              return _el$26;
            })()
          }), null);
          _$insert(_el$23, _$createComponent(For, {
            get each() {
              return scan().errors;
            },
            children: (message) => (() => {
              var _el$33 = _$createElement("text");
              _$insert(_el$33, message);
              _$effect((_$p) => _$setProp(_el$33, "fg", theme().warning, _$p));
              return _el$33;
            })()
          }), null);
          _$insert(_el$23, _$createComponent(Show, {
            get when() {
              return scan().limited;
            },
            get children() {
              var _el$24 = _$createElement("text");
              _$insertNode(_el$24, _$createTextNode(`Scope limited to 4 levels / 300 folders.`));
              _$effect((_$p) => _$setProp(_el$24, "fg", theme().warning, _$p));
              return _el$24;
            }
          }), null);
          return _el$23;
        })()
      }), (() => {
        var _el$21 = _$createElement("text"), _el$22 = _$createTextNode(` files tracked separately by the OpenCode session.`);
        _$insertNode(_el$21, _el$22);
        _$insert(_el$21, () => props.api.state.session.diff(props.id).length, _el$22);
        _$effect((_$p) => _$setProp(_el$21, "fg", theme().textMuted, _$p));
        return _el$21;
      })()];
    }
  });
}
function Creature(props) {
  const theme = () => props.api.theme.current;
  useCreatureAnimation(() => props.working);
  const peak = createMemo(() => messagePeak(props.growthKey, props.count));
  const stage = createMemo(() => growthStage(props.growthKey, peak()));
  const frame = () => stage().frames[props.working ? creatureFrame() % 2 : 0];
  const label = createMemo(() => abbreviateAgentName(props.name));
  return (() => {
    var _el$34 = _$createElement("box"), _el$35 = _$createElement("text");
    _$insertNode(_el$34, _el$35);
    _$setProp(_el$34, "flexDirection", "column");
    _$setProp(_el$34, "width", 10);
    _$insert(_el$34, _$createComponent(For, {
      get each() {
        return frame();
      },
      children: (line) => (() => {
        var _el$36 = _$createElement("text");
        _$setProp(_el$36, "wrapMode", "none");
        _$insert(_el$36, line);
        _$effect((_$p) => _$setProp(_el$36, "fg", props.working ? theme().accent : theme().textMuted, _$p));
        return _el$36;
      })()
    }), _el$35);
    _$setProp(_el$35, "wrapMode", "none");
    _$insert(_el$35, label);
    _$effect((_$p) => _$setProp(_el$35, "fg", props.working ? theme().accent : theme().textMuted, _$p));
    return _el$34;
  })();
}
var creatureColumns = 3;
function CreatureCard(props) {
  const activity = createMemo(() => sidebarActivity(props.api, props.id));
  const main = createMemo(() => sessionMetrics(props.api, props.id));
  const mainWorking = () => activity().status?.type === "busy" || activity().status?.type === "retry";
  const seen = new Map;
  const [agents, setAgents] = createSignal([]);
  createEffect(() => {
    let changed = false;
    for (const agent of activity().agents) {
      const previous = seen.get(agent.name);
      if (!previous || previous.session !== agent.id) {
        seen.set(agent.name, {
          session: agent.id
        });
        changed = true;
      }
    }
    if (changed)
      setAgents([...seen].map(([name, value]) => ({
        name,
        session: value.session
      })));
  });
  const cells = createMemo(() => {
    const live = new Set(activity().agents.filter((agent) => agent.active).map((agent) => agent.name));
    return [{
      key: `main:${props.id}`,
      name: main().agent ?? "Main",
      count: main().count,
      working: mainWorking()
    }, ...agents().map((agent) => ({
      key: `agent:${agent.name}`,
      name: agent.name,
      count: sessionMetrics(props.api, agent.session).count,
      working: live.has(agent.name)
    }))];
  });
  const rows = createMemo(() => {
    const list = cells();
    return Array.from({
      length: Math.ceil(list.length / creatureColumns)
    }, (_, index) => list.slice(index * creatureColumns, index * creatureColumns + creatureColumns));
  });
  return _$createComponent(InfoCard, {
    get api() {
      return props.api;
    },
    name: "creatures",
    title: "Creatures",
    initialOpen: true,
    get summary() {
      return `${cells().length} creatures \xB7 grow with messages`;
    },
    get children() {
      return _$createComponent(For, {
        get each() {
          return rows();
        },
        children: (row) => (() => {
          var _el$37 = _$createElement("box");
          _$setProp(_el$37, "flexDirection", "row");
          _$setProp(_el$37, "gap", 1);
          _$insert(_el$37, _$createComponent(For, {
            each: row,
            children: (cell) => _$createComponent(Creature, {
              get api() {
                return props.api;
              },
              get growthKey() {
                return cell.key;
              },
              get name() {
                return cell.name;
              },
              get count() {
                return cell.count;
              },
              get working() {
                return cell.working;
              }
            })
          }));
          return _el$37;
        })()
      });
    }
  });
}
function AsyncIdentity(props) {
  const theme = () => props.api.theme.current;
  const data = createMemo(() => asyncIdentity(props.api, props.id));
  return (() => {
    var _el$38 = _$createElement("box"), _el$39 = _$createElement("text"), _el$40 = _$createElement("b"), _el$41 = _$createTextNode(`Subagents \xB7 `), _el$42 = _$createTextNode(` runs`), _el$43 = _$createElement("text"), _el$44 = _$createElement("span"), _el$45 = _$createTextNode(`\u25CF `), _el$46 = _$createTextNode(` run`), _el$47 = _$createElement("span"), _el$49 = _$createElement("span"), _el$50 = _$createTextNode(`\u2713 `), _el$51 = _$createTextNode(` done`), _el$52 = _$createElement("span"), _el$54 = _$createElement("span"), _el$55 = _$createTextNode(`\u2715 `), _el$56 = _$createTextNode(` err`), _el$57 = _$createElement("span"), _el$59 = _$createElement("span"), _el$60 = _$createTextNode(`\u03A3 `);
    _$insertNode(_el$38, _el$39);
    _$insertNode(_el$38, _el$43);
    _$setProp(_el$38, "paddingLeft", 1);
    _$setProp(_el$38, "paddingRight", 1);
    _$insertNode(_el$39, _el$40);
    _$insertNode(_el$40, _el$41);
    _$insertNode(_el$40, _el$42);
    _$insert(_el$40, () => data().total, _el$42);
    _$insertNode(_el$43, _el$44);
    _$insertNode(_el$43, _el$47);
    _$insertNode(_el$43, _el$49);
    _$insertNode(_el$43, _el$52);
    _$insertNode(_el$43, _el$54);
    _$insertNode(_el$43, _el$57);
    _$insertNode(_el$43, _el$59);
    _$setProp(_el$43, "wrapMode", "none");
    _$insertNode(_el$44, _el$45);
    _$insertNode(_el$44, _el$46);
    _$insert(_el$44, () => data().running, _el$46);
    _$insertNode(_el$47, _$createTextNode(` \xB7 `));
    _$insertNode(_el$49, _el$50);
    _$insertNode(_el$49, _el$51);
    _$insert(_el$49, () => data().done, _el$51);
    _$insertNode(_el$52, _$createTextNode(` \xB7 `));
    _$insertNode(_el$54, _el$55);
    _$insertNode(_el$54, _el$56);
    _$insert(_el$54, () => data().error, _el$56);
    _$insertNode(_el$57, _$createTextNode(` \xB7 `));
    _$insertNode(_el$59, _el$60);
    _$insert(_el$59, () => data().total, null);
    _$effect((_p$) => {
      var _v$9 = theme().backgroundElement, _v$0 = theme().primary, _v$1 = {
        fg: statusColor(theme(), "run")
      }, _v$10 = {
        fg: theme().textMuted
      }, _v$11 = {
        fg: statusColor(theme(), "done")
      }, _v$12 = {
        fg: theme().textMuted
      }, _v$13 = {
        fg: statusColor(theme(), "err")
      }, _v$14 = {
        fg: theme().textMuted
      }, _v$15 = {
        fg: statusColor(theme(), "total")
      };
      _v$9 !== _p$.e && (_p$.e = _$setProp(_el$38, "backgroundColor", _v$9, _p$.e));
      _v$0 !== _p$.t && (_p$.t = _$setProp(_el$39, "fg", _v$0, _p$.t));
      _v$1 !== _p$.a && (_p$.a = _$setProp(_el$44, "style", _v$1, _p$.a));
      _v$10 !== _p$.o && (_p$.o = _$setProp(_el$47, "style", _v$10, _p$.o));
      _v$11 !== _p$.i && (_p$.i = _$setProp(_el$49, "style", _v$11, _p$.i));
      _v$12 !== _p$.n && (_p$.n = _$setProp(_el$52, "style", _v$12, _p$.n));
      _v$13 !== _p$.s && (_p$.s = _$setProp(_el$54, "style", _v$13, _p$.s));
      _v$14 !== _p$.h && (_p$.h = _$setProp(_el$57, "style", _v$14, _p$.h));
      _v$15 !== _p$.r && (_p$.r = _$setProp(_el$59, "style", _v$15, _p$.r));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined,
      i: undefined,
      n: undefined,
      s: undefined,
      h: undefined,
      r: undefined
    });
    return _el$38;
  })();
}
function waitingReason(api, id, activity) {
  if (api.state.session.permission(id).length)
    return "Waiting for your permission";
  if (api.state.session.question(id).length)
    return "Waiting for your choice / answer";
  if (activity.status?.type === "retry")
    return "Waiting for model retry";
  if (activity.current?.tool === "task" || activity.current?.tool === "subagent" || !activity.current && activity.agents.some((agent) => agent.active))
    return "Waiting for subagent results";
  if (activity.current)
    return `${activity.current.state.status === "pending" ? "Queued" : "Waiting for result"} \xB7 ${activityDetail(activity.current).action}`;
  if (activity.status?.type === "busy")
    return "Waiting for model response";
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
      var _el$61 = _$createElement("text"), _el$62 = _$createTextNode(` \xB7 `), _el$63 = _$createTextNode(`s observed`);
      _$insertNode(_el$61, _el$62);
      _$insertNode(_el$61, _el$63);
      _$setProp(_el$61, "wrapMode", "word");
      _$insert(_el$61, () => props.reason, _el$62);
      _$insert(_el$61, seconds, _el$63);
      return _el$61;
    }
  });
}
function ProgressBars(props) {
  const theme = () => props.api.theme.current;
  const size = useTerminalDimensions();
  const width = () => Math.max(6, Math.min(30, (size().width || 40) - 8));
  const frame = createClock(80);
  const main = createMemo(() => mainTodoProgress(props.api.state.session.todo(props.id)));
  const subs = createMemo(() => subagentTodoProgress(sidebarActivity(props.api, props.id).agents));
  return (() => {
    var _el$64 = _$createElement("box"), _el$65 = _$createElement("box"), _el$66 = _$createElement("text"), _el$67 = _$createElement("text"), _el$68 = _$createElement("box"), _el$69 = _$createElement("text"), _el$70 = _$createElement("text");
    _$insertNode(_el$64, _el$65);
    _$insertNode(_el$64, _el$68);
    _$insertNode(_el$65, _el$66);
    _$insertNode(_el$65, _el$67);
    _$setProp(_el$65, "flexDirection", "row");
    _$setProp(_el$66, "wrapMode", "none");
    _$insert(_el$66, () => renderBar(main().fraction, width(), frame()));
    _$setProp(_el$67, "wrapMode", "none");
    _$insert(_el$67, () => `  ${main().completed}/${main().total}`);
    _$insertNode(_el$68, _el$69);
    _$insertNode(_el$68, _el$70);
    _$setProp(_el$68, "flexDirection", "row");
    _$setProp(_el$69, "wrapMode", "none");
    _$insert(_el$69, () => renderBar(subs().fraction, width(), frame()));
    _$setProp(_el$70, "wrapMode", "none");
    _$insert(_el$70, () => `  ${subs().completed}/${subs().total}`);
    _$effect((_p$) => {
      var _v$16 = theme().primary, _v$17 = theme().textMuted, _v$18 = theme().accent, _v$19 = theme().textMuted;
      _v$16 !== _p$.e && (_p$.e = _$setProp(_el$66, "fg", _v$16, _p$.e));
      _v$17 !== _p$.t && (_p$.t = _$setProp(_el$67, "fg", _v$17, _p$.t));
      _v$18 !== _p$.a && (_p$.a = _$setProp(_el$69, "fg", _v$18, _p$.a));
      _v$19 !== _p$.o && (_p$.o = _$setProp(_el$70, "fg", _v$19, _p$.o));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined,
      o: undefined
    });
    return _el$64;
  })();
}
function Overview(props) {
  const theme = () => props.api.theme.current;
  const data = createMemo(() => sessionMetrics(props.api, props.id));
  const activity = createMemo(() => sidebarActivity(props.api, props.id));
  const agents = retainActivity(() => activity().agents, (agent) => agent.key, () => props.id);
  const size = useTerminalDimensions();
  const limit = () => size().height < 35 ? 2 : 4;
  return (() => {
    var _el$71 = _$createElement("box"), _el$72 = _$createElement("box"), _el$73 = _$createElement("text"), _el$74 = _$createElement("b"), _el$75 = _$createElement("text"), _el$76 = _$createTextNode(` \xB7 `), _el$77 = _$createElement("box");
    _$insertNode(_el$71, _el$72);
    _$insertNode(_el$71, _el$77);
    _$setProp(_el$71, "gap", 1);
    _$setProp(_el$71, "flexShrink", 0);
    _$insertNode(_el$72, _el$73);
    _$insertNode(_el$72, _el$75);
    _$insertNode(_el$73, _el$74);
    _$setProp(_el$73, "wrapMode", "char");
    _$insert(_el$74, () => data().model);
    _$insertNode(_el$75, _el$76);
    _$insert(_el$75, () => data().agent ?? "New session", _el$76);
    _$insert(_el$75, (() => {
      var _c$4 = _$memo(() => activity().status?.type === "busy");
      return () => _c$4() ? "Working" : activity().status?.type === "retry" ? "Retrying" : "Ready";
    })(), null);
    _$insert(_el$71, _$createComponent(ProgressBars, {
      get api() {
        return props.api;
      },
      get id() {
        return props.id;
      }
    }), _el$77);
    _$insert(_el$71, _$createComponent(CreatureCard, {
      get api() {
        return props.api;
      },
      get id() {
        return props.id;
      }
    }), _el$77);
    _$insert(_el$71, _$createComponent(ObservedWait, {
      get reason() {
        return waitingReason(props.api, props.id, activity());
      },
      get session() {
        return props.id;
      }
    }), _el$77);
    _$insert(_el$77, _$createComponent(AsyncIdentity, {
      get api() {
        return props.api;
      },
      get id() {
        return props.id;
      }
    }), null);
    _$insert(_el$77, _$createComponent(Show, {
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
            var _el$78 = _$createElement("text"), _el$79 = _$createTextNode(`+`), _el$80 = _$createTextNode(` more agents`);
            _$insertNode(_el$78, _el$79);
            _$insertNode(_el$78, _el$80);
            _$insert(_el$78, () => agents().length - limit(), _el$80);
            _$effect((_$p) => _$setProp(_el$78, "fg", theme().textMuted, _$p));
            return _el$78;
          }
        })];
      }
    }), null);
    _$insert(_el$71, _$createComponent(Show, {
      get when() {
        return activity().attention > 0;
      },
      get children() {
        var _el$81 = _$createElement("box"), _el$82 = _$createElement("text"), _el$83 = _$createElement("b"), _el$84 = _$createTextNode(`Needs answer \xB7 `), _el$85 = _$createElement("text");
        _$insertNode(_el$81, _el$82);
        _$insertNode(_el$81, _el$85);
        _$insertNode(_el$82, _el$83);
        _$insertNode(_el$83, _el$84);
        _$insert(_el$83, () => activity().attention, null);
        _$insertNode(_el$85, _$createTextNode(`Check the request in the conversation.`));
        _$effect((_p$) => {
          var _v$20 = theme().warning, _v$21 = theme().textMuted;
          _v$20 !== _p$.e && (_p$.e = _$setProp(_el$82, "fg", _v$20, _p$.e));
          _v$21 !== _p$.t && (_p$.t = _$setProp(_el$85, "fg", _v$21, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$81;
      }
    }), null);
    _$insert(_el$71, _$createComponent(InfoCard, {
      get api() {
        return props.api;
      },
      name: "context",
      title: "Provider token report",
      get summary() {
        return _$memo(() => data().used === undefined)() ? "Tokens not reported yet" : `${compact(data().used ?? NaN)} token \xB7 ${data().percent === undefined ? "context \u2014" : `${data().percent}% context`} \xB7 $${data().cost.toFixed(4)}`;
      },
      get children() {
        var _el$87 = _$createElement("text"), _el$88 = _$createTextNode(`Provider \xB7 `);
        _$insertNode(_el$87, _el$88);
        _$setProp(_el$87, "wrapMode", "char");
        _$insert(_el$87, () => data().provider, null);
        _$effect((_$p) => _$setProp(_el$87, "fg", theme().textMuted, _$p));
        return _el$87;
      }
    }), null);
    _$insert(_el$71, _$createComponent(Show, {
      get when() {
        return taskProgressVisible();
      },
      get children() {
        return _$createComponent(InfoCard, {
          get api() {
            return props.api;
          },
          name: "progress",
          title: "Task progress",
          initialOpen: true,
          get summary() {
            return _$memo(() => activity().total === 0)() ? "No task list yet" : `${activity().completed}/${activity().total} done \xB7 ${activity().todos.length} remaining`;
          },
          get children() {
            return _$createComponent(Show, {
              get when() {
                return activity().total > 0;
              },
              get children() {
                return [(() => {
                  var _el$89 = _$createElement("text"), _el$90 = _$createTextNode(` running \xB7 `), _el$91 = _$createTextNode(` queued`);
                  _$insertNode(_el$89, _el$90);
                  _$insertNode(_el$89, _el$91);
                  _$insert(_el$89, () => activity().todos.filter((todo) => todo.status === "in_progress").length, _el$90);
                  _$insert(_el$89, () => activity().todos.filter((todo) => todo.status === "pending").length, _el$91);
                  _$effect((_$p) => _$setProp(_el$89, "fg", theme().textMuted, _$p));
                  return _el$89;
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
                    var _el$92 = _$createElement("box"), _el$93 = _$createElement("text"), _el$94 = _$createElement("text");
                    _$insertNode(_el$92, _el$93);
                    _$insertNode(_el$92, _el$94);
                    _$setProp(_el$92, "marginTop", 1);
                    _$insert(_el$93, (() => {
                      var _c$5 = _$memo(() => todo.status === "completed");
                      return () => _c$5() ? "\u2713 Done" : todo.status === "in_progress" ? "\u203A In progress" : "\xB7 Pending";
                    })());
                    _$setProp(_el$94, "wrapMode", "word");
                    _$insert(_el$94, () => todo.content);
                    _$effect((_p$) => {
                      var _v$24 = todo.status === "in_progress" ? theme().primary : theme().textMuted, _v$25 = todo.status === "completed" ? theme().textMuted : theme().text;
                      _v$24 !== _p$.e && (_p$.e = _$setProp(_el$93, "fg", _v$24, _p$.e));
                      _v$25 !== _p$.t && (_p$.t = _$setProp(_el$94, "fg", _v$25, _p$.t));
                      return _p$;
                    }, {
                      e: undefined,
                      t: undefined
                    });
                    return _el$92;
                  })()
                })];
              }
            });
          }
        });
      }
    }), null);
    _$insert(_el$71, _$createComponent(WorkspaceCard, {
      get api() {
        return props.api;
      },
      get id() {
        return props.id;
      }
    }), null);
    _$effect((_p$) => {
      var _v$22 = theme().text, _v$23 = theme().textMuted;
      _v$22 !== _p$.e && (_p$.e = _$setProp(_el$73, "fg", _v$22, _p$.e));
      _v$23 !== _p$.t && (_p$.t = _$setProp(_el$75, "fg", _v$23, _p$.t));
      return _p$;
    }, {
      e: undefined,
      t: undefined
    });
    return _el$71;
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
  const identity = createMemo(() => asyncIdentity(props.api, props.id));
  const theme = () => props.api.theme.current;
  const now = createClock();
  const width = () => Math.max(1, (size().width || 80) - 2);
  const segments = () => {
    const list = [{
      text: "ASYNC",
      tone: "primary",
      priority: 0
    }, {
      text: ` | \u25CF ${identity().running} run \xB7 \u2713 ${identity().done} done \xB7 \u2715 ${identity().error} err \xB7 \u03A3 ${identity().total}`,
      tone: "muted",
      priority: 0
    }, {
      text: ` | ${mcpPluginLabel(props.api)}`,
      tone: "muted",
      priority: 1
    }];
    if (activity().latest) {
      const detail = activityDetail(activity().latest);
      list.push({
        text: ` | ${detail.status} \xB7 ${detail.action}`,
        tone: "muted",
        priority: 2
      });
      const target = detail.target ?? "";
      if (target)
        list.push({
          text: ` \xB7 ${basename(target)}`,
          tone: "muted",
          priority: 3
        });
    }
    list.push({
      text: " | /studio-panel \xB7 detail",
      tone: "accent",
      priority: 4
    });
    list.push({
      text: ` | ${props.api.state.vcs?.branch ?? "local"}`,
      tone: "muted",
      priority: 5
    });
    list.push({
      text: ` | ${clockLabel(now())}`,
      tone: "muted",
      priority: 6
    });
    return fitStatus(list, width());
  };
  const open = () => props.api.ui.dialog.replace(() => _$createComponent(props.api.ui.Dialog, {
    onClose: () => props.api.ui.dialog.clear(),
    get children() {
      var _el$95 = _$createElement("box"), _el$96 = _$createElement("text"), _el$97 = _$createElement("b"), _el$99 = _$createTextNode(` \xB7 Esc to close`), _el$100 = _$createElement("scrollbox");
      _$insertNode(_el$95, _el$96);
      _$insertNode(_el$95, _el$100);
      _$setProp(_el$95, "padding", 1);
      _$insertNode(_el$96, _el$97);
      _$insertNode(_el$96, _el$99);
      _$insertNode(_el$97, _$createTextNode(`Studio \xB7 Session detail`));
      _$insert(_el$100, _$createComponent(Overview, {
        get api() {
          return props.api;
        },
        get id() {
          return props.id;
        },
        mini: true
      }));
      _$effect((_p$) => {
        var _v$26 = theme().primary, _v$27 = Math.max(5, size().height - 10);
        _v$26 !== _p$.e && (_p$.e = _$setProp(_el$96, "fg", _v$26, _p$.e));
        _v$27 !== _p$.t && (_p$.t = _$setProp(_el$100, "height", _v$27, _p$.t));
        return _p$;
      }, {
        e: undefined,
        t: undefined
      });
      return _el$95;
    }
  }));
  const unregister = props.api.command?.register(() => [{
    title: "Studio: open all session information",
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
      var _el$101 = _$createElement("box"), _el$102 = _$createElement("text");
      _$insertNode(_el$101, _el$102);
      _$setProp(_el$101, "width", "100%");
      _$setProp(_el$101, "flexShrink", 0);
      _$setProp(_el$101, "paddingLeft", 1);
      _$setProp(_el$101, "paddingRight", 1);
      _$setProp(_el$101, "onMouseDown", (event) => {
        if (event.button === 0) {
          event.stopPropagation();
          open();
        }
      });
      _$setProp(_el$102, "wrapMode", "none");
      _$setProp(_el$102, "truncate", true);
      _$insert(_el$102, _$createComponent(For, {
        get each() {
          return segments();
        },
        children: (segment, index) => (() => {
          var _el$103 = _$createElement("span");
          _$insert(_el$103, (() => {
            var _c$6 = _$memo(() => !!(segment.tone === "primary" && index() === 0));
            return () => _c$6() ? (() => {
              var _el$104 = _$createElement("b");
              _$insert(_el$104, () => segment.text);
              return _el$104;
            })() : segment.text;
          })());
          _$effect((_$p) => _$setProp(_el$103, "style", {
            fg: segment.tone === "primary" ? theme().primary : segment.tone === "accent" ? theme().primary : theme().textMuted
          }, _$p));
          return _el$103;
        })()
      }));
      _$effect((_$p) => _$setProp(_el$101, "backgroundColor", theme().backgroundPanel, _$p));
      return _el$101;
    }
  });
}
function StatusBar(props) {
  const size = useTerminalDimensions();
  const theme = () => props.api.theme.current;
  const now = createClock();
  return (() => {
    var _el$105 = _$createElement("box"), _el$106 = _$createElement("text"), _el$107 = _$createElement("b"), _el$111 = _$createElement("text");
    _$insertNode(_el$105, _el$106);
    _$insertNode(_el$105, _el$111);
    _$setProp(_el$105, "flexDirection", "row");
    _$setProp(_el$105, "justifyContent", "space-between");
    _$setProp(_el$105, "paddingLeft", 1);
    _$setProp(_el$105, "paddingRight", 1);
    _$setProp(_el$105, "width", "100%");
    _$setProp(_el$105, "height", 1);
    _$setProp(_el$105, "flexShrink", 0);
    _$insertNode(_el$106, _el$107);
    _$insertNode(_el$107, _$createTextNode(`ASYNC`));
    _$insert(_el$105, _$createComponent(Show, {
      get when() {
        return size().width >= 65;
      },
      get children() {
        var _el$109 = _$createElement("text");
        _$insert(_el$109, () => mcpPluginLabel(props.api));
        _$effect((_$p) => _$setProp(_el$109, "fg", theme().textMuted, _$p));
        return _el$109;
      }
    }), _el$111);
    _$insert(_el$105, _$createComponent(Show, {
      get when() {
        return size().width >= 95;
      },
      get children() {
        var _el$110 = _$createElement("text");
        _$insert(_el$110, () => clockLabel(now()));
        _$effect((_$p) => _$setProp(_el$110, "fg", theme().textMuted, _$p));
        return _el$110;
      }
    }), _el$111);
    _$insert(_el$111, () => props.api.state.vcs?.branch ?? "local");
    _$effect((_p$) => {
      var _v$28 = theme().backgroundPanel, _v$29 = theme().primary, _v$30 = theme().textMuted;
      _v$28 !== _p$.e && (_p$.e = _$setProp(_el$105, "backgroundColor", _v$28, _p$.e));
      _v$29 !== _p$.t && (_p$.t = _$setProp(_el$106, "fg", _v$29, _p$.t));
      _v$30 !== _p$.a && (_p$.a = _$setProp(_el$111, "fg", _v$30, _p$.a));
      return _p$;
    }, {
      e: undefined,
      t: undefined,
      a: undefined
    });
    return _el$105;
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
            var _el$112 = _$createElement("box"), _el$113 = _$createElement("text"), _el$114 = _$createElement("b"), _el$116 = _$createElement("text"), _el$117 = _$createElement("b");
            _$insertNode(_el$112, _el$113);
            _$insertNode(_el$112, _el$116);
            _$setProp(_el$112, "gap", 1);
            _$setProp(_el$112, "paddingBottom", 1);
            _$insertNode(_el$113, _el$114);
            _$insertNode(_el$114, _$createTextNode(`ASYNC AGENT / SESSION`));
            _$insertNode(_el$116, _el$117);
            _$setProp(_el$116, "wrapMode", "word");
            _$insert(_el$117, () => props.title);
            _$insert(_el$112, _$createComponent(Show, {
              get when() {
                return props.share_url;
              },
              get children() {
                var _el$118 = _$createElement("text");
                _$setProp(_el$118, "wrapMode", "char");
                _$insert(_el$118, () => props.share_url);
                _$effect((_$p) => _$setProp(_el$118, "fg", api.theme.current.textMuted, _$p));
                return _el$118;
              }
            }), null);
            _$effect((_p$) => {
              var _v$31 = api.theme.current.primary, _v$32 = api.theme.current.text;
              _v$31 !== _p$.e && (_p$.e = _$setProp(_el$113, "fg", _v$31, _p$.e));
              _v$32 !== _p$.t && (_p$.t = _$setProp(_el$116, "fg", _v$32, _p$.t));
              return _p$;
            }, {
              e: undefined,
              t: undefined
            });
            return _el$112;
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
            var _el$119 = _$createElement("text"), _el$120 = _$createTextNode(`OPENCODE ASYNC AGENT \xB7 v`);
            _$insertNode(_el$119, _el$120);
            _$insert(_el$119, () => api.app.version, null);
            _$effect((_$p) => _$setProp(_el$119, "fg", api.theme.current.textMuted, _$p));
            return _el$119;
          })();
        },
        app_bottom() {
          return (() => {
            var _el$121 = _$createElement("box");
            _$setProp(_el$121, "flexShrink", 0);
            _$insert(_el$121, _$createComponent(Show, {
              get when() {
                return _$memo(() => !!sessionID())() && !sidebarVisible();
              },
              get fallback() {
                return _$createComponent(StatusBar, {
                  api
                });
              },
              get children() {
                return _$createComponent(ResponsiveDock, {
                  api,
                  get id() {
                    return sessionID();
                  },
                  get sidebarVisible() {
                    return sidebarVisible();
                  }
                });
              }
            }));
            return _el$121;
          })();
        }
      }
    });
  }
};
var tui_default = plugin;
export {
  AsyncIdentity,
  Creature,
  CreatureCard,
  InfoCard,
  ObservedWait,
  Overview,
  ProgressBars,
  ResponsiveDock,
  SidebarPresence,
  SubagentCard,
  WorkspaceCard,
  abbreviateAgentName,
  clockLabel,
  tui_default as default,
  retainActivity,
  waitingReason
};
