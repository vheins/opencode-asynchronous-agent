import type { TuiPluginApi, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack, type Accessor, type JSX } from "solid-js"
import { humanBytes, readDbSizeBytes } from "./dbsize"
import { activityDetail, mainTodoProgress, progressLabel, progressLevel, renderBar, sessionMetrics, sidebarActivity, subagentTodoProgress } from "./model"
import { elapsedLabel, fetchSubagent } from "./subagent"
import { inspectWorkspace } from "./workspace"

/** Plugin's own version, injected at build time by `build.ts` (`define`). */
declare const __PLUGIN_VERSION__: string

/**
 * Keeps recently-removed items visible for a short grace period.
 * Re-seeds when the session scope changes so stale rows never leak across sessions.
 */
export function retainActivity<T>(source: Accessor<T[]>, key: (item: T) => string, session: Accessor<string>, delay = 4000) {
  const [rows, setRows] = createSignal<{ item: T; ended?: number }[]>([])
  let scope = session()
  createEffect(() => {
    const id = session()
    const items = source()
    const now = Date.now()
    const previous = id === scope ? untrack(rows) : []
    scope = id
    const keys = new Set(items.map(key))
    setRows([
      ...items.map((item) => ({ item })),
      ...previous.filter((row) => !keys.has(key(row.item)))
        .map((row) => ({ ...row, ended: row.ended ?? now }))
        .filter((row) => now - row.ended < delay),
    ])
  })
  createEffect(() => {
    const deadlines = rows().flatMap((row) => row.ended === undefined ? [] : [row.ended + delay])
    if (!deadlines.length) return
    const timer = setTimeout(() => setRows((previous) => previous.filter((row) => row.ended === undefined || Date.now() < row.ended + delay)), Math.max(0, Math.min(...deadlines) - Date.now()))
    onCleanup(() => clearTimeout(timer))
  })
  return rows
}

/** Formats a token count with a compact suffix (e.g. 48k). */
function compact(value: number) {
  if (!Number.isFinite(value) || value < 0) return "—"
  return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value)
}

/** Last path segment only, so file displays never show the full path. */
function basename(path: string) {
  const parts = path.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** True for A/E/I/O/U, so abbreviation picks consonants before vowels. */
function isVowel(char: string) {
  return "AEIOU".includes(char)
}

/**
 * Picks a middle letter from a segment: the first non-edge consonant that
 * differs from `avoid`, else any non-edge consonant, else the segment's 2nd char.
 */
function middleLetter(segment: string, avoid: string) {
  const inner = segment.slice(1, -1).split("")
  const consonants = inner.filter((char) => !isVowel(char))
  return consonants.find((char) => char !== avoid) ?? consonants[0] ?? inner[0] ?? segment[0] ?? ""
}

/**
 * Abbreviates an agent name into a short uppercase code built from its start,
 * middle and end (e.g. code-reviewer -> CVR, orchestrator -> ORC) so the
 * creature label never truncates inside the narrow grid cell. Pure and
 * deterministic; only the rendered label changes, keying stays on the full name.
 */
export function abbreviateAgentName(name: string): string {
  const segments = name.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean)
  const letters = segments.join("")
  if (!letters) return "?"
  if (letters.length <= 3) return letters
  if (segments.length === 1) return letters.slice(0, 3)
  const first = segments[0][0]
  const middle = middleLetter(segments[segments.length - 1], first)
  const end = letters[letters.length - 1]
  return `${first}${middle}${end}`.slice(0, 4)
}

/** "{connected}/{total} MCP | {active}/{total} plugin" summary. */
function mcpPluginLabel(api: TuiPluginApi) {
  const mcp = api.state.mcp()
  const plugins = api.plugins.list().filter((item) => item.source !== "internal")
  return `${mcp.filter((item) => item.status === "connected").length}/${mcp.length} MCP | ${plugins.filter((item) => item.active).length}/${plugins.length} plugin`
}

type StatusSegment = { text: string; tone: "primary" | "muted" | "accent"; priority: number }

/**
 * Fits status segments into a character budget, dropping the lowest-value
 * optional segments first (higher priority number = dropped earlier). Priority 0
 * segments are never dropped; if they still overflow, the last one is ellipsized.
 */
function fitStatus(segments: StatusSegment[], budget: number): StatusSegment[] {
  const kept = segments.map((segment) => ({ ...segment }))
  const total = () => kept.reduce((sum, segment) => sum + segment.text.length, 0)
  for (const segment of [...kept].sort((a, b) => b.priority - a.priority)) {
    if (total() <= budget) break
    if (segment.priority === 0) continue
    const index = kept.indexOf(segment)
    if (index >= 0) kept.splice(index, 1)
  }
  const last = kept[kept.length - 1]
  if (last && total() > budget) last.text = `${last.text.slice(0, Math.max(1, last.text.length - (total() - budget) - 1))}…`
  return kept
}

/**
 * A stable 1s clock owned by the calling component. Returned accessor is reactive,
 * so elapsed labels recompute every second even if child rows are recreated.
 */
function createClock(interval = 1000) {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), interval)
  onCleanup(() => clearInterval(timer))
  return now
}

/** Formats a timestamp as a compact `Mon 08 Oct · 14:05:32` clock label. */
export function clockLabel(time: number) {
  const date = new Date(time)
  const day = date.toLocaleDateString("en", { weekday: "short" })
  const rest = date.toLocaleDateString("en", { day: "2-digit", month: "short" })
  const clock = date.toLocaleTimeString("en", { hour12: false })
  return `${day} ${rest} · ${clock}`
}

/** Navigates the host to a real subagent session, ignoring synthetic row ids. */
function navigateToSession(api: TuiPluginApi, target: string | undefined) {
  if (!target || !target.startsWith("ses_")) return
  api.route.navigate("session", { sessionID: target })
}

type CreatureStage = { name: string; frames: [string[], string[]] }

/**
 * Growth cap in messages: stage = min(9, floor(peak / 20)). Thresholds
 * 0/20/40/.../200 map to stages 0..9 (Egg/Hatchling/Child/Teen/Adult/Elder/
 * Ancient/Mythic/Legendary/Divine).
 */
const creatureGrowthCap = 200

/** Cell width for the 3-column creature grid; sprite lines stay within it. */
const creatureCellWidth = 10

/** Ten growth stages, selected by total message count. Each frame is 3-4 compact lines. */
const creatureStages: CreatureStage[] = [
  { name: "Egg", frames: [[
    " .--.",
    "(    )",
    " '--'",
  ], [
    " .--.",
    "( .. )",
    " '--'",
  ]] },
  { name: "Hatchling", frames: [[
    "  __",
    " (oo)",
    " /||\\",
  ], [
    "  __",
    " (--)",
    " /||\\",
  ]] },
  { name: "Child", frames: [[
    " .----.",
    "( ^  ^ )",
    " \\ -- /",
  ], [
    " .----.",
    "( ^  ^ )",
    " \\ oo /",
  ]] },
  { name: "Teen", frames: [[
    "  .---.",
    " ( ^ ^ )",
    " <|   |>",
  ], [
    "  .---.",
    " ( ^ ^ )",
    " <| o |>",
  ]] },
  { name: "Adult", frames: [[
    "  ___",
    " /^ ^\\",
    " | - |",
    " <| |>",
  ], [
    "  ___",
    " /^ ^\\",
    " | o |",
    " <| |>",
  ]] },
  { name: "Elder", frames: [[
    "  /\\_/\\",
    " ( o o )",
    "  \\ - /",
    " /|   |\\",
  ], [
    "  /\\_/\\",
    " ( ^ ^ )",
    "  \\ o /",
    " /|   |\\",
  ]] },
  { name: "Ancient", frames: [[
    "  _/\\_",
    " / o o \\",
    " |  ^  |",
    " <|/ \\|>",
  ], [
    "  _/\\_",
    " / - - \\",
    " |  o  |",
    " <|/ \\|>",
  ]] },
  { name: "Mythic", frames: [[
    " \\_|_|_/",
    "  (o)(o)",
    " /| ^ |\\",
    "  ^   ^",
  ], [
    " \\_|_|_/",
    "  (-)(-)",
    " /| o |\\",
    "  ^   ^",
  ]] },
  { name: "Legendary", frames: [[
    " /\\___/\\",
    "( o  o )",
    " \\  ^  /",
    " <|/ \\|>",
  ], [
    " /\\___/\\",
    "( ^  ^ )",
    " \\  o  /",
    " <|/ \\|>",
  ]] },
  { name: "Divine", frames: [[
    " \\|/^\\|/",
    "  (o o)",
    " <| ^ |>",
    "  ^/ \\^",
  ], [
    " \\|/^\\|/",
    "  (^ ^)",
    " <| o |>",
    "  ^/ \\^",
  ]] },
]

/**
 * Running high-water mark of message count per creature key. Auto-compress
 * collapses older messages into a summary, so the raw count can rise then fall;
 * growth and the displayed stat must read this monotonic peak instead.
 */
const peakMessages = new Map<string, number>()

/** Returns the monotonic peak message count for a creature key (never shrinks). */
function messagePeak(key: string, count: number) {
  const peak = Math.max(peakMessages.get(key) ?? 0, Math.max(0, count))
  peakMessages.set(key, peak)
  return peak
}

/** Stage-level high-water mark, so a stage never regresses even if the peak is re-clamped. */
const creaturePeak = new Map<string, number>()

/** Maps a peak message count to a monotonic growth stage for a creature key. */
function growthStage(key: string, count: number) {
  const capped = Math.max(0, Math.min(creatureGrowthCap, count))
  const peak = Math.max(creaturePeak.get(key) ?? 0, capped)
  creaturePeak.set(key, peak)
  return creatureStages[Math.min(creatureStages.length - 1, Math.floor(peak / (creatureGrowthCap / creatureStages.length)))]
}

const [creatureFrame, setCreatureFrame] = createSignal(0)
let creatureTimer: ReturnType<typeof setInterval> | undefined
let creatureSubscribers = 0

/**
 * Reference-counted 200ms animation tick shared by every creature. The single
 * interval starts when the first working creature subscribes and stops when the
 * last one goes idle, so no timer runs while all agents are idle.
 */
function useCreatureAnimation(working: Accessor<boolean>) {
  createEffect(() => {
    if (!working()) return
    creatureSubscribers++
    if (!creatureTimer) creatureTimer = setInterval(() => setCreatureFrame((frame) => frame + 1), 200)
    onCleanup(() => {
      creatureSubscribers = Math.max(0, creatureSubscribers - 1)
      if (creatureSubscribers === 0 && creatureTimer) { clearInterval(creatureTimer); creatureTimer = undefined }
    })
  })
}

const [barFrame, setBarFrame] = createSignal(0)
let barTimer: ReturnType<typeof setInterval> | undefined
let barSubscribers = 0

/**
 * Reference-counted 260ms tick for the progress bars, gated to active bars. The
 * single interval starts when the first bar has unfinished work to animate and
 * stops when every bar goes idle, so no timer runs at rest; callers render at
 * `frame=0` when inactive.
 */
function useBarAnimation(active: Accessor<boolean>) {
  createEffect(() => {
    if (!active()) return
    barSubscribers++
    if (!barTimer) barTimer = setInterval(() => setBarFrame((frame) => frame + 1), 260)
    onCleanup(() => {
      barSubscribers = Math.max(0, barSubscribers - 1)
      if (barSubscribers === 0 && barTimer) { clearInterval(barTimer); barTimer = undefined }
    })
  })
}

const [dbSize, setDbSize] = createSignal<string | undefined>(undefined)
let dbSizeTimer: ReturnType<typeof setInterval> | undefined
let dbSizeSubscribers = 0

/**
 * Reference-counted slow poll for the in-use database size. The single 10s
 * interval starts when the first consumer mounts and stops when the last
 * unmounts, so exactly one stat runs per tick and none while the line is hidden.
 */
function useDbSizePoll() {
  createEffect(() => {
    dbSizeSubscribers++
    if (!dbSizeTimer) {
      const refresh = () => setDbSize(humanBytes(readDbSizeBytes()))
      refresh()
      dbSizeTimer = setInterval(refresh, 10_000)
    }
    onCleanup(() => {
      dbSizeSubscribers = Math.max(0, dbSizeSubscribers - 1)
      if (dbSizeSubscribers === 0 && dbSizeTimer) { clearInterval(dbSizeTimer); dbSizeTimer = undefined }
    })
  })
}

type SubagentStatus = "running" | "done" | "error"
/** Async status kinds sharing one theme-driven color mapping (aggregate line + rows). */
type StatusKind = "run" | "done" | "err" | "total"

/** Resolves a status kind to an active-theme token; never a literal color. */
function statusColor(theme: TuiThemeCurrent, kind: StatusKind) {
  if (kind === "run") return theme.accent
  if (kind === "done") return theme.success
  if (kind === "err") return theme.error
  return theme.textMuted
}

/**
 * Ramps a progress bar's color from the same status tokens the aggregate uses:
 * muted while below half, accent from half up, success once complete. The bar's
 * identity (main vs subagent) is carried by the fill glyphs and label, not the
 * color, so the two rows stay distinguishable on the shared ramp.
 */
function progressColor(theme: TuiThemeCurrent, completed: number, total: number) {
  const level = progressLevel(completed, total)
  return level === "done" ? statusColor(theme, "done") : level === "mid" ? statusColor(theme, "run") : theme.textMuted
}

/** Maps an activity status label to its status kind, if it is one. */
function activityKind(status: string | undefined): StatusKind | undefined {
  if (status === "Running" || status === "Queued" || status === "Launched") return "run"
  if (status === "Done") return "done"
  if (status === "Failed") return "err"
  return undefined
}

/**
 * Derives the async-agent aggregate (running/done/error/total). Reconciles the
 * parent session's task/subagent tool parts with the live sidebarActivity agents:
 * a backgrounded subagent's launcher tool completes immediately while its child
 * session keeps working, so it must still count as running. Invariant:
 * running + done + error === total.
 */
function asyncIdentity(api: TuiPluginApi, id: string) {
  const tools = api.state.session.messages(id)
    .flatMap((message) => api.state.part(message.id))
    .filter((part): part is ToolPart => part.type === "tool")
    .filter((part) => part.tool === "task" || part.tool === "subagent")
  const live = new Set(sidebarActivity(api, id).agents.filter((agent) => agent.active).map((agent) => agent.id))
  const rows: { id: string; status: SubagentStatus }[] = tools.map((part) => {
    const child = part.state.status === "pending" ? undefined : typeof part.state.metadata?.sessionId === "string" ? part.state.metadata.sessionId : undefined
    const key = child ?? part.callID
    const status: SubagentStatus = live.has(key) || part.state.status === "running" || part.state.status === "pending"
      ? "running"
      : part.state.status === "error" ? "error" : "done"
    return { id: key, status }
  })
  for (const agent of live) if (!rows.some((row) => row.id === agent)) rows.push({ id: agent, status: "running" })
  return {
    running: rows.filter((row) => row.status === "running").length,
    done: rows.filter((row) => row.status === "done").length,
    error: rows.filter((row) => row.status === "error").length,
    total: rows.length,
  }
}

/** Registers the done/error toast for background subagents, gated by env. */
function subagentToasts(api: TuiPluginApi) {
  const raw = String(process.env.OPENCODE_SUBAGENT_NOTIFY ?? "1").trim().toLowerCase()
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return
  if (!api?.ui?.toast) return
  const previous = new Map<string, string>()
  const off = api.event.on("message.part.updated", ({ properties }) => {
    const part = properties.part
    if (part.type !== "tool" || (part.tool !== "task" && part.tool !== "subagent")) return
    const status = part.state.status
    const last = previous.get(part.callID)
    previous.set(part.callID, status)
    if (last === undefined || last === status) return
    if (status !== "completed" && status !== "error") return
    const label = String(activityDetail(part).target || part.tool).replace(/\s+/g, " ").trim().slice(0, 60)
    const ok = status === "completed"
    try {
      api.ui.toast({
        variant: ok ? "success" : "error",
        title: ok ? "Subagent finished" : "Subagent failed",
        message: label,
        duration: ok ? 4000 : 6000,
      })
    } catch {
      // Toast is best-effort; never break the event loop.
    }
  })
  api.lifecycle.onDispose(() => { off(); previous.clear() })
}

/** Whether the sidebar renders the "Task progress" card. Off unless explicitly enabled. */
function taskProgressVisible() {
  const raw = String(process.env.OPENCODE_SUBAGENT_TASK_PROGRESS ?? "").trim().toLowerCase()
  return !(raw === "" || raw === "0" || raw === "false" || raw === "off" || raw === "no")
}

export function InfoCard(props: { api: TuiPluginApi; name: string; title: string; summary: string; summaryTitle?: string; children: JSX.Element; initialOpen?: boolean; onOpen?: (open: boolean) => void; onActivate?: () => void }) {
  const [open, setOpen] = createSignal(props.api.kv.get<boolean>(`studio.card.${props.name}`, props.initialOpen ?? false))
  const [hovered, setHovered] = createSignal(false)
  const theme = () => props.api.theme.current
  const clickable = () => Boolean(props.onActivate)
  createEffect(() => props.onOpen?.(open()))
  const toggle = () => {
    const next = !open()
    setOpen(next)
    props.api.kv.set(`studio.card.${props.name}`, next)
  }
  const unregister = props.api.command?.register(() => [{
    title: `Studio: ${open() ? "close" : "open"} ${props.title}`,
    value: `studio.card.${props.name}`,
    category: "Studio",
    slash: { name: `studio-${props.name}` },
    onSelect: (dialog) => { toggle(); dialog?.clear() },
  }])
  if (unregister) onCleanup(unregister)
  const header = (event: { button: number; stopPropagation: () => void }) => {
    if (event.button !== 0) return
    event.stopPropagation()
    if (props.onActivate) props.onActivate()
    else toggle()
  }
  return <box
    backgroundColor={hovered() ? theme().backgroundPanel : theme().backgroundElement}
    paddingLeft={1} paddingRight={1}
    onMouseOver={clickable() ? () => setHovered(true) : undefined}
    onMouseOut={clickable() ? () => setHovered(false) : undefined}>
    <box flexDirection="row" onMouseDown={header}>
      <text fg={hovered() ? theme().accent : theme().primary} onMouseDown={(event) => { if (event.button === 0) { event.stopPropagation(); toggle() } }}><b>{open() ? "▾" : "▸"}</b></text>
      <text fg={hovered() ? theme().accent : theme().primary} wrapMode="none" truncate flexShrink={1}><b> {props.title}{clickable() ? " →" : ""}</b></text>
    </box>
    <Show when={props.summaryTitle}><text fg={theme().textMuted} wrapMode="none" truncate onMouseDown={header}>{props.summaryTitle}</text></Show>
    <text fg={theme().textMuted} wrapMode="word" onMouseDown={header}>{props.summary}</text>
    <Show when={open()}><box paddingTop={1} paddingBottom={1}>{props.children}</box></Show>
  </box>
}

export function SubagentCard(props: { api: TuiPluginApi; agent: ReturnType<typeof sidebarActivity>["agents"][number]; ended?: number }) {
  const [data, setData] = createSignal<Awaited<ReturnType<typeof fetchSubagent>>>()
  const [error, setError] = createSignal("")
  const now = createClock()
  const theme = () => props.api.theme.current
  createEffect(() => {
    const id = props.agent.id
    const ended = props.ended
    const controller = new AbortController()
    let pending = false
    setData(undefined); setError("")
    const refresh = async () => {
      if (pending) return
      pending = true
      try { const next = await fetchSubagent(props.api, id, controller.signal); if (!controller.signal.aborted) { setData(next); setError("") } }
      catch { if (!controller.signal.aborted) setError("Details not available yet; retrying.") }
      finally { pending = false }
    }
    void refresh()
    // Poll only while the child is live; an idle child's snapshot is stable, and
    // the effect re-runs (restarting the poll) when it becomes active again.
    const poll = ended || !props.agent.active ? undefined : setInterval(() => void refresh(), 5000)
    onCleanup(() => { controller.abort(); clearInterval(poll) })
  })
  // Prefer the live session start; fall back to the fetched snapshot. Real start
  // is what lets the label tick from the child's true session creation time.
  const session = () => props.api.state.session.get(props.agent.id)
  const started = () => session()?.time.created ?? data()?.started
  // A finished agent stays in the list (labelled "Done"), so `props.ended` is not
  // set for it. Freeze the clock at the child's last activity time instead of
  // letting it tick forever; only a live agent keeps advancing with `now()`.
  const ended = () => props.ended ?? (props.agent.active ? undefined : session()?.time.updated)
  const elapsed = () => {
    const start = started()
    const end = ended() ?? now()
    return start !== undefined && Number.isFinite(start) && start > 0 ? Math.max(0, end - start) : 0
  }
  // Session title replaces the provider/model line and is clipped to one line;
  // the stat line leads with Tools, then elapsed, then context used with percent
  // of the model limit.
  const summaryTitle = () => data()?.title ?? "Loading title…"
  const summary = () => {
    const detail = data()
    return [
      detail ? `${detail.toolCount} Tools` : "… Tools",
      elapsedLabel(started(), ended() ?? now()),
      detail?.used !== undefined ? `${compact(detail.used)} (${detail.percent ?? 0}%)` : undefined,
    ].filter((part): part is string => Boolean(part)).join(" · ")
  }
  const progress = () => props.agent.progress?.total ? ` · ${props.agent.progress.completed}/${props.agent.progress.total}` : ""
  return <InfoCard api={props.api} name={`agent-${props.agent.id}`} title={`${props.agent.name} · ${props.ended ? "Just ended" : props.agent.label}${progress()}`} onActivate={() => navigateToSession(props.api, props.agent.id)} summaryTitle={summaryTitle()} summary={summary()}>
    <Show when={props.agent.target}><text fg={theme().text} wrapMode="word">{props.agent.target}</text></Show>
    <Show when={error()}><text fg={theme().warning}>{error()}</text></Show>
    <Show when={data()}>{(detail) => <box gap={1}>
      <text fg={theme().text} wrapMode="word">{detail().activity ? `${detail().current ? "Now" : "Last"} · ${detail().activity!.action} · ` : "Tool activity not reported yet."}<Show when={detail().activity}>{(activity) => <span style={{ fg: statusColor(theme(), activityKind(activity().status) ?? "total") }}>{activity().status}</span>}</Show></text>
      <Show when={detail().activity?.target}><text fg={theme().textMuted} wrapMode="char">{detail().activity?.target}</text></Show>
      <text fg={theme().textMuted}>{detail().todos.length ? `${detail().completed}/${detail().todos.length} tasks done` : "Task progress not reported yet."}</text>
      <For each={detail().todos}>{(todo) => <text fg={todo.status === "in_progress" ? theme().text : theme().textMuted} wrapMode="word">{todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "›" : "·"} {todo.content}</text>}</For>
    </box>}</Show>
  </InfoCard>
}

export function WorkspaceCard(props: { api: TuiPluginApi; id: string }) {
  const [open, setOpen] = createSignal(false)
  const [data, setData] = createSignal<Awaited<ReturnType<typeof inspectWorkspace>>>()
  const [error, setError] = createSignal("")
  const theme = () => props.api.theme.current
  createEffect(() => {
    const root = props.api.state.path.directory
    setData(undefined); setError("")
    if (!open()) return
    const controller = new AbortController()
    let pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      try { const next = await inspectWorkspace(root, controller.signal); if (!controller.signal.aborted) { setData(next); setError("") } }
      catch { if (!controller.signal.aborted) setError("Git scan failed. Check folder access and Git installation.") }
      finally { pending = false }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 15000)
    onCleanup(() => { controller.abort(); clearInterval(timer) })
  })
  return <InfoCard api={props.api} name="files" title="Workspace & files" onOpen={setOpen} summary={error() || (data() ? `${data()!.repos.length} Git repos · ${data()!.repos.reduce((n, repo) => n + repo.files.length, 0)} changed entries` : open() ? "Scanning repositories…" : "Open to scan the repo root and subfolders")}>
    <text fg={theme().textMuted} wrapMode="char">{props.api.state.path.directory}</text>
    <text fg={theme().textMuted}>Local Git, not just session changes · refresh 15s</text>
    <Show when={data()}>{(scan) => <box gap={1}>
      <For each={scan().repos}>{(repo) => <box>
        <text fg={theme().primary} wrapMode="char"><b>{repo.path}</b> · {repo.branch}</text>
        <Show when={repo.error}><text fg={theme().warning}>{repo.error}</text></Show>
        <For each={repo.files}>{(file) => <text fg={theme().text} wrapMode="char">{file.status} {basename(file.path)}</text>}</For>
      </box>}</For>
      <For each={scan().errors}>{(message) => <text fg={theme().warning}>{message}</text>}</For>
      <Show when={scan().limited}><text fg={theme().warning}>Scope limited to 4 levels / 300 folders.</text></Show>
    </box>}</Show>
    <text fg={theme().textMuted}>{props.api.state.session.diff(props.id).length} files tracked separately by the OpenCode session.</text>
  </InfoCard>
}

/**
 * A single growth-reactive creature: compact ASCII frames cycled by the shared
 * tick while working, static frame when idle. The sprite sits above a name-only
 * label; growth reads the monotonic message high-water mark. Sized to one cell
 * of the 3-column grid.
 */
export function Creature(props: { api: TuiPluginApi; name: string; count: number; working: boolean; growthKey: string }) {
  const theme = () => props.api.theme.current
  useCreatureAnimation(() => props.working)
  const peak = createMemo(() => messagePeak(props.growthKey, props.count))
  const stage = createMemo(() => growthStage(props.growthKey, peak()))
  const frame = () => stage().frames[props.working ? creatureFrame() % 2 : 0]
  const label = createMemo(() => abbreviateAgentName(props.name))
  return <box flexDirection="column" width={creatureCellWidth}>
    <For each={frame()}>{(line) => <text fg={props.working ? theme().accent : theme().textMuted} wrapMode="none">{line}</text>}</For>
    <text fg={props.working ? theme().accent : theme().textMuted} wrapMode="none">{label()}</text>
  </box>
}

type CreatureCell = { key: string; name: string; count: number; working: boolean }
type SeenAgent = { name: string; session: string }

/** Number of creature cells per grid row. */
const creatureColumns = 3

/** Sidebar card: a wrapping grid of growth-reactive creatures, main session first. */
export function CreatureCard(props: { api: TuiPluginApi; id: string }) {
  const activity = createMemo(() => sidebarActivity(props.api, props.id))
  const main = createMemo(() => sessionMetrics(props.api, props.id))
  const mainWorking = () => activity().status?.type === "busy" || activity().status?.type === "retry"
  // Accumulate every unique agent ever seen this session, keyed by the agent NAME
  // (subagent_type) so re-invocations of the same agent collapse into one creature;
  // a later invocation updates the stored session in place. Ended agents stay until
  // the card unmounts (i.e. the main session ends), so no unique agent is dropped.
  const seen = new Map<string, { session: string }>()
  const [agents, setAgents] = createSignal<SeenAgent[]>([])
  createEffect(() => {
    let changed = false
    for (const agent of activity().agents) {
      const previous = seen.get(agent.name)
      if (!previous || previous.session !== agent.id) {
        seen.set(agent.name, { session: agent.id })
        changed = true
      }
    }
    if (changed) setAgents([...seen].map(([name, value]) => ({ name, session: value.session })))
  })
  const cells = createMemo<CreatureCell[]>(() => {
    const live = new Set(activity().agents.filter((agent) => agent.active).map((agent) => agent.name))
    return [
      { key: `main:${props.id}`, name: main().agent ?? "Main", count: main().count, working: mainWorking() },
      ...agents().map((agent) => ({ key: `agent:${agent.name}`, name: agent.name, count: sessionMetrics(props.api, agent.session).count, working: live.has(agent.name) })),
    ]
  })
  const rows = createMemo(() => {
    const list = cells()
    return Array.from({ length: Math.ceil(list.length / creatureColumns) }, (_, index) => list.slice(index * creatureColumns, index * creatureColumns + creatureColumns))
  })
  return <InfoCard api={props.api} name="creatures" title="Creatures" initialOpen summary={`${cells().length} creatures · grow with messages`}>
    <For each={rows()}>{(row) => <box flexDirection="row" gap={1}>
      <For each={row}>{(cell) => <Creature api={props.api} growthKey={cell.key} name={cell.name} count={cell.count} working={cell.working} />}</For>
    </box>}</For>
  </InfoCard>
}

/** Async-agent aggregate: running/done/err/total. Per-subagent detail lives in SubagentCard. */
export function AsyncIdentity(props: { api: TuiPluginApi; id: string; compact?: boolean }) {
  const theme = () => props.api.theme.current
  const data = createMemo(() => asyncIdentity(props.api, props.id))
  return <box backgroundColor={theme().backgroundElement} paddingLeft={1} paddingRight={1}>
    <text fg={theme().primary}><b>Subagents · {data().total} runs</b></text>
    <text wrapMode="none">
      <span style={{ fg: statusColor(theme(), "run") }}>● {data().running} run</span>
      <span style={{ fg: theme().textMuted }}> · </span>
      <span style={{ fg: statusColor(theme(), "done") }}>✓ {data().done} done</span>
      <span style={{ fg: theme().textMuted }}> · </span>
      <span style={{ fg: statusColor(theme(), "err") }}>✕ {data().error} err</span>
      <span style={{ fg: theme().textMuted }}> · </span>
      <span style={{ fg: statusColor(theme(), "total") }}>Σ {data().total}</span>
    </text>
  </box>
}

/** Describes why the parent is waiting, if it is. */
export function waitingReason(api: TuiPluginApi, id: string, activity: ReturnType<typeof sidebarActivity>) {
  if (api.state.session.permission(id).length) return "Waiting for your permission"
  if (api.state.session.question(id).length) return "Waiting for your choice / answer"
  if (activity.status?.type === "retry") return "Waiting for model retry"
  if (activity.current?.tool === "task" || activity.current?.tool === "subagent" || (!activity.current && activity.agents.some((agent) => agent.active))) return "Waiting for subagent results"
  if (activity.current) return `${activity.current.state.status === "pending" ? "Queued" : "Waiting for result"} · ${activityDetail(activity.current).action}`
  if (activity.status?.type === "busy") return "Waiting for model response"
  return ""
}

export function ObservedWait(props: { reason: string; session: string }) {
  const [seconds, setSeconds] = createSignal(0)
  createEffect(() => {
    const reason = props.reason
    const session = props.session
    setSeconds(0)
    if (!reason || !session) return
    const start = Date.now()
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000)
    onCleanup(() => clearInterval(timer))
  })
  return <Show when={props.reason}><text wrapMode="word">{props.reason} · {seconds()}s observed</text></Show>
}

/**
 * Two progress bars shown above the Creatures card: the main agent's own todo
 * completion and the cumulative completed/total across every subagent. Both are
 * driven by the same reactive todo store the cards read, so they update live.
 * A shared clock, gated to bars that still have work to animate, drives the
 * sweep; the fill boundary always tracks the real completed/total, so motion
 * never distorts the level. Rows with nothing to report collapse away.
 */
export function ProgressBars(props: { api: TuiPluginApi; id: string }) {
  const theme = () => props.api.theme.current
  const size = useTerminalDimensions()
  const width = () => Math.max(6, Math.min(40, (size().width || 40) - 8))
  const main = createMemo(() => mainTodoProgress(props.api.state.session.todo(props.id)))
  const subs = createMemo(() => subagentTodoProgress(sidebarActivity(props.api, props.id).agents))
  const showMain = () => main().total > 0
  const showSubs = () => subs().total > 0
  // Animate only while a shown bar has work left (or is empty but shimmering);
  // hidden rows never start the clock, and it stops once every bar is done.
  const animating = () => (showMain() && main().fraction < 1) || (showSubs() && subs().fraction < 1)
  useBarAnimation(animating)
  const frame = () => (animating() ? barFrame() : 0)
  const row = (completed: number, total: number) =>
    <box flexDirection="row">
      <text fg={progressColor(theme(), completed, total)} wrapMode="none">{renderBar(total > 0 ? completed / total : 0, width(), frame())}</text>
      <text fg={theme().textMuted} wrapMode="none">{`  ${progressLabel(completed, total)}`}</text>
    </box>
  return <box>
    <Show when={showMain()}>{row(main().completed, main().total)}</Show>
    <Show when={showSubs()}>{row(subs().completed, subs().total)}</Show>
  </box>
}

export function Overview(props: { api: TuiPluginApi; id: string; mini?: boolean }) {
  const theme = () => props.api.theme.current
  const data = createMemo(() => sessionMetrics(props.api, props.id))
  const activity = createMemo(() => sidebarActivity(props.api, props.id))
  const agents = retainActivity(() => activity().agents, (agent) => agent.key, () => props.id)
  const size = useTerminalDimensions()
  const limit = () => size().height < 35 ? 2 : 4
  return (
    <box gap={1} flexShrink={0}>
      <box>
        <text fg={theme().text} wrapMode="char"><b>{data().model}</b></text>
        <text fg={theme().textMuted}>{data().agent ?? "New session"} · {activity().status?.type === "busy" ? "Working" : activity().status?.type === "retry" ? "Retrying" : "Ready"}</text>
      </box>
      <ProgressBars api={props.api} id={props.id} />
      <CreatureCard api={props.api} id={props.id} />
      <ObservedWait reason={waitingReason(props.api, props.id, activity())} session={props.id} />
      <box>
        <AsyncIdentity api={props.api} id={props.id} />
        <Show when={agents().length > 0}>
          <For each={agents().slice(0, limit())}>{(row) =>
            <SubagentCard api={props.api} agent={row.item} ended={row.ended} />
          }</For>
          <Show when={agents().length > limit()}><text fg={theme().textMuted}>+{agents().length - limit()} more agents</text></Show>
        </Show>
      </box>
      <Show when={activity().attention > 0}>
        <box>
          <text fg={theme().warning}><b>Needs answer · {activity().attention}</b></text>
          <text fg={theme().textMuted}>Check the request in the conversation.</text>
        </box>
      </Show>
      <InfoCard api={props.api} name="context" title="Provider token report" summary={data().used === undefined ? "Tokens not reported yet" : `${compact(data().used ?? NaN)} token · ${data().percent === undefined ? "context —" : `${data().percent}% context`} · $${data().cost.toFixed(4)}`}>
        <text fg={theme().textMuted} wrapMode="char">Provider · {data().provider}</text>
      </InfoCard>
      <Show when={taskProgressVisible()}>
        <InfoCard api={props.api} name="progress" title="Task progress" initialOpen summary={activity().total === 0 ? "No task list yet" : `${activity().completed}/${activity().total} done · ${activity().todos.length} remaining`}>
          <Show when={activity().total > 0}>
            <text fg={theme().textMuted}>{activity().todos.filter((todo) => todo.status === "in_progress").length} running · {activity().todos.filter((todo) => todo.status === "pending").length} queued</text>
            <For each={[...props.api.state.session.todo(props.id)].sort((a, b) => ({ in_progress: 0, pending: 1, completed: 2 }[a.status] ?? 3) - ({ in_progress: 0, pending: 1, completed: 2 }[b.status] ?? 3))}>{(todo) =>
              <box marginTop={1}><text fg={todo.status === "in_progress" ? theme().primary : theme().textMuted}>{todo.status === "completed" ? "✓ Done" : todo.status === "in_progress" ? "› In progress" : "· Pending"}</text><text fg={todo.status === "completed" ? theme().textMuted : theme().text} wrapMode="word">{todo.content}</text></box>
            }</For>
          </Show>
        </InfoCard>
      </Show>
      <WorkspaceCard api={props.api} id={props.id} />
    </box>
  )
}

export function SidebarPresence(props: { visible: (value: boolean) => void; children: JSX.Element }) {
  onMount(() => props.visible(true))
  onCleanup(() => props.visible(false))
  return props.children
}

export function ResponsiveDock(props: { api: TuiPluginApi; id: string; sidebarVisible: boolean }) {
  const size = useTerminalDimensions()
  const activity = createMemo(() => sidebarActivity(props.api, props.id))
  const identity = createMemo(() => asyncIdentity(props.api, props.id))
  const theme = () => props.api.theme.current
  const now = createClock()
  useDbSizePoll()
  // Single physical line: the dock absorbs the old StatusBar content (MCP/plugin)
  // so app_bottom renders exactly one line at any width.
  const width = () => Math.max(1, (size().width || 80) - 2)
  const segments = (): StatusSegment[] => {
    const list: StatusSegment[] = [
      { text: `Asynchronous Agent · v${__PLUGIN_VERSION__}`, tone: "primary", priority: 0 },
      { text: ` | ● ${identity().running} run · ✓ ${identity().done} done · ✕ ${identity().error} err · Σ ${identity().total}`, tone: "muted", priority: 0 },
      { text: ` | ${mcpPluginLabel(props.api)}`, tone: "muted", priority: 1 },
      { text: ` | DB ${dbSize() ?? "—"}`, tone: "muted", priority: 2 },
    ]
    if (activity().latest) {
      const detail = activityDetail(activity().latest!)
      list.push({ text: ` | ${detail.status} · ${detail.action}`, tone: "muted", priority: 2 })
      const target = detail.target ?? ""
      if (target) list.push({ text: ` · ${basename(target)}`, tone: "muted", priority: 3 })
    }
    list.push({ text: " | /studio-panel · detail", tone: "accent", priority: 4 })
    list.push({ text: ` | ${props.api.state.vcs?.branch ?? "local"}`, tone: "muted", priority: 5 })
    list.push({ text: ` | ${clockLabel(now())}`, tone: "muted", priority: 6 })
    return fitStatus(list, width())
  }
  const open = () => props.api.ui.dialog.replace(() => <props.api.ui.Dialog onClose={() => props.api.ui.dialog.clear()}>
    <box padding={1}>
      <text fg={theme().primary}><b>Studio · Session detail</b> · Esc to close</text>
      <scrollbox height={Math.max(5, size().height - 10)}>
        <Overview api={props.api} id={props.id} mini />
      </scrollbox>
    </box>
  </props.api.ui.Dialog>)
  const unregister = props.api.command?.register(() => [{
    title: "Studio: open all session information", value: "studio.panel", category: "Studio", slash: { name: "studio-panel" },
    onSelect: () => open(),
  }])
  if (unregister) onCleanup(unregister)
  return <Show when={!props.sidebarVisible}>
    <box
      backgroundColor={theme().backgroundPanel}
      width="100%" flexShrink={0} paddingLeft={1} paddingRight={1}
      onMouseDown={(event) => { if (event.button === 0) { event.stopPropagation(); open() } }}>
      <text wrapMode="none" truncate>
        <For each={segments()}>{(segment, index) => <span style={{ fg: segment.tone === "primary" ? theme().primary : segment.tone === "accent" ? theme().primary : theme().textMuted }}>{segment.tone === "primary" && index() === 0 ? <b>{segment.text}</b> : segment.text}</span>}</For>
      </text>
    </box>
  </Show>
}

function StatusBar(props: { api: TuiPluginApi }) {
  const size = useTerminalDimensions()
  const theme = () => props.api.theme.current
  const now = createClock()
  useDbSizePoll()
  return (
    <box flexDirection="row" justifyContent="space-between" backgroundColor={theme().backgroundPanel} paddingLeft={1} paddingRight={1} width="100%" height={1} flexShrink={0}>
      <text fg={theme().primary}><b>Asynchronous Agent · v{__PLUGIN_VERSION__}</b></text>
      <Show when={size().width >= 65}>
        <text fg={theme().textMuted}>{mcpPluginLabel(props.api)}</text>
      </Show>
      <Show when={size().width >= 80}>
        <text fg={theme().textMuted}>DB {dbSize() ?? "—"}</text>
      </Show>
      <Show when={size().width >= 95}>
        <text fg={theme().textMuted}>{clockLabel(now())}</text>
      </Show>
      <text fg={theme().textMuted}>{props.api.state.vcs?.branch ?? "local"}</text>
    </box>
  )
}

const plugin: TuiPluginModule = {
  id: "opencode-asynchronous-agent.tui",
  tui: async (api) => {
    subagentToasts(api)
    const [sidebarVisible, setSidebarVisible] = createSignal(false)
    const sessionID = () => {
      const route = api.route.current
      return route.name === "session" && typeof route.params?.sessionID === "string" ? route.params.sessionID : undefined
    }
    api.slots.register({
      order: 10,
      slots: {
        sidebar_title(_ctx, props) {
          return <box gap={1} paddingBottom={1}>
            <text fg={api.theme.current.text} wrapMode="word"><b>{props.title}</b></text>
            <Show when={props.share_url}><text fg={api.theme.current.textMuted} wrapMode="char">{props.share_url}</text></Show>
          </box>
        },
        sidebar_content(_ctx, props) {
          return <SidebarPresence visible={setSidebarVisible}><Overview api={api} id={props.session_id} /></SidebarPresence>
        },
        app_bottom() {
          // Exactly one physical line: the dock (session + collapsed sidebar)
          // replaces the fallback StatusBar; they never co-render.
          return <box flexShrink={0}>
            <Show when={sessionID() && !sidebarVisible()} fallback={<StatusBar api={api} />}>
              <ResponsiveDock api={api} id={sessionID()!} sidebarVisible={sidebarVisible()} />
            </Show>
          </box>
        },
      },
    })
  },
}

export default plugin
