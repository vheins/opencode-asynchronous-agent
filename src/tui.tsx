import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack, type Accessor, type JSX } from "solid-js"
import { activityDetail, sessionMetrics, sidebarActivity } from "./model"
import { elapsedLabel, fetchSubagent } from "./subagent"
import { inspectWorkspace } from "./workspace"

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

/** Navigates the host to a real subagent session, ignoring synthetic row ids. */
function navigateToSession(api: TuiPluginApi, target: string | undefined) {
  if (!target || !target.startsWith("ses_")) return
  api.route.navigate("session", { sessionID: target })
}

type CreatureStage = { name: string; frames: [string, string] }

/** Five growth stages, selected by context percent (0/20/40/60/80/100). */
const creatureStages: CreatureStage[] = [
  { name: "Egg", frames: ["( )", "(@)"] },
  { name: "Hatchling", frames: ["(•ᴗ•)", "(•o•)"] },
  { name: "Child", frames: ["(◕ᴗ◕)", "(◕‿◕)"] },
  { name: "Teen", frames: ["(≧ᴗ≦)", "(≧ω≦)"] },
  { name: "Adult", frames: ["ヽ(・∀・)ﾉ", "ヽ(^ω^)ﾉ"] },
]

/** Highest percent reached per creature key, so growth never regresses in a session. */
const creaturePeak = new Map<string, number>()

/** Maps context percent to a monotonic growth stage for a creature key. */
function growthStage(key: string, percent: number | undefined) {
  const peak = Math.max(creaturePeak.get(key) ?? 0, Math.max(0, Math.min(100, percent ?? 0)))
  creaturePeak.set(key, peak)
  return creatureStages[Math.min(creatureStages.length - 1, Math.floor(peak / 20))]
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

type SubagentStatus = "running" | "done" | "error"

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
  const live = new Set(sidebarActivity(api, id).agents.map((agent) => agent.id))
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

export function InfoCard(props: { api: TuiPluginApi; name: string; title: string; summary: string; children: JSX.Element; initialOpen?: boolean; onOpen?: (open: boolean) => void; onActivate?: () => void }) {
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
      <text fg={hovered() ? theme().accent : theme().primary}><b> {props.title}{clickable() ? " →" : ""}</b></text>
    </box>
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
    const poll = ended ? undefined : setInterval(() => void refresh(), 5000)
    onCleanup(() => { controller.abort(); clearInterval(poll) })
  })
  // Prefer the live session start; fall back to the fetched snapshot. Real start
  // is what lets the label tick from the child's true session creation time.
  const started = () => props.api.state.session.get(props.agent.id)?.time.created ?? data()?.started
  const elapsed = () => {
    const start = started()
    return start !== undefined && Number.isFinite(start) && start > 0 ? Math.max(0, (props.ended ?? now()) - start) : 0
  }
  // Session title replaces the provider/model line; the stat line carries Tools,
  // context used with percent of limit, and output tokens/sec next to elapsed.
  const summary = () => {
    const detail = data()
    const seconds = elapsed() / 1000
    const stat = [
      elapsedLabel(started(), props.ended ?? now()),
      detail ? `${detail.toolCount} Tools` : "… Tools",
      detail?.used !== undefined ? `${compact(detail.used)} (${detail.percent ?? 0}%)` : undefined,
      detail?.output !== undefined && seconds > 0 ? `${Math.round(detail.output / seconds)} Tok/s` : undefined,
    ].filter((part): part is string => Boolean(part)).join(" · ")
    return `${detail?.title ?? "Loading title…"}\n${stat}`
  }
  return <InfoCard api={props.api} name={`agent-${props.agent.id}`} title={`${props.agent.name} · ${props.ended ? "Just ended" : props.agent.label}`} onActivate={() => navigateToSession(props.api, props.agent.id)} summary={summary()}>
    <Show when={props.agent.target}><text fg={theme().text} wrapMode="word">{props.agent.target}</text></Show>
    <Show when={error()}><text fg={theme().warning}>{error()}</text></Show>
    <Show when={data()}>{(detail) => <box gap={1}>
      <text fg={theme().text} wrapMode="word">{detail().activity ? `${detail().current ? "Now" : "Last"} · ${detail().activity!.action} · ${detail().activity!.status}` : "Tool activity not reported yet."}</text>
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
 * A single growth-reactive creature: Unicode frames cycled by the shared tick
 * while working, static frame when idle. Stage derives from context percent.
 */
export function Creature(props: { api: TuiPluginApi; name: string; percent: number | undefined; working: boolean; growthKey: string }) {
  const theme = () => props.api.theme.current
  useCreatureAnimation(() => props.working)
  const stage = createMemo(() => growthStage(props.growthKey, props.percent))
  const frame = () => props.working ? creatureFrame() % 2 : 0
  return <box flexDirection="row">
    <text fg={props.working ? theme().accent : theme().textMuted}><b>{stage().frames[frame()]}</b></text>
    <text fg={theme().text}> {props.name}</text>
    <text fg={theme().textMuted}> · {stage().name}{props.percent !== undefined ? ` ${props.percent}%` : ""}{props.working ? "" : " · idle"}</text>
  </box>
}

/** Sidebar card: one growth-reactive creature for the main session plus one per active subagent. */
export function CreatureCard(props: { api: TuiPluginApi; id: string }) {
  const activity = createMemo(() => sidebarActivity(props.api, props.id))
  const main = createMemo(() => sessionMetrics(props.api, props.id))
  const agents = retainActivity(() => activity().agents, (agent) => agent.id, () => props.id)
  const mainWorking = () => activity().status?.type === "busy" || activity().status?.type === "retry"
  return <InfoCard api={props.api} name="creatures" title="Creatures" initialOpen summary={`${agents().length + 1} creatures · grow with context`}>
    <Creature api={props.api} growthKey={`main:${props.id}`} name={main().agent ?? "Main"} percent={main().percent} working={mainWorking()} />
    <For each={agents()}>{(row) => {
      const detail = createMemo(() => sessionMetrics(props.api, row.item.id))
      return <Creature api={props.api} growthKey={`agent:${row.item.id}`} name={row.item.name} percent={detail().percent} working={row.ended === undefined} />
    }}</For>
  </InfoCard>
}

/** Async-agent aggregate: running/done/err/total. Per-subagent detail lives in SubagentCard. */
export function AsyncIdentity(props: { api: TuiPluginApi; id: string; compact?: boolean }) {
  const theme = () => props.api.theme.current
  const data = createMemo(() => asyncIdentity(props.api, props.id))
  return <box backgroundColor={theme().backgroundElement} paddingLeft={1} paddingRight={1}>
    <text fg={theme().primary}><b>Subagents {data().total}</b></text>
    <text fg={theme().text}>● {data().running} run · ✓ {data().done} done · ✕ {data().error} err · Σ {data().total}</text>
  </box>
}

/** Describes why the parent is waiting, if it is. */
export function waitingReason(api: TuiPluginApi, id: string, activity: ReturnType<typeof sidebarActivity>) {
  if (api.state.session.permission(id).length) return "Waiting for your permission"
  if (api.state.session.question(id).length) return "Waiting for your choice / answer"
  if (activity.status?.type === "retry") return "Waiting for model retry"
  if (activity.current?.tool === "task" || activity.current?.tool === "subagent" || (!activity.current && activity.agents.length)) return "Waiting for subagent results"
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

export function Overview(props: { api: TuiPluginApi; id: string; mini?: boolean }) {
  const theme = () => props.api.theme.current
  const data = createMemo(() => sessionMetrics(props.api, props.id))
  const activity = createMemo(() => sidebarActivity(props.api, props.id))
  const agents = retainActivity(() => activity().agents, (agent) => agent.id, () => props.id)
  const size = useTerminalDimensions()
  const limit = () => size().height < 35 ? 2 : 4
  return (
    <box gap={1} flexShrink={0}>
      <box>
        <text fg={theme().text} wrapMode="char"><b>{data().model}</b></text>
        <text fg={theme().textMuted}>{data().agent ?? "New session"} · {activity().status?.type === "busy" ? "Working" : activity().status?.type === "retry" ? "Retrying" : "Ready"}</text>
      </box>
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
      <CreatureCard api={props.api} id={props.id} />
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
  // Single physical line: the dock absorbs the old StatusBar content (MCP/plugin)
  // so app_bottom renders exactly one line at any width.
  const width = () => Math.max(1, (size().width || 80) - 2)
  const segments = (): StatusSegment[] => {
    const list: StatusSegment[] = [
      { text: "ASYNC", tone: "primary", priority: 0 },
      { text: ` | ● ${identity().running} run · ✓ ${identity().done} done · ✕ ${identity().error} err · Σ ${identity().total}`, tone: "muted", priority: 0 },
      { text: ` | ${mcpPluginLabel(props.api)}`, tone: "muted", priority: 1 },
    ]
    if (activity().latest) {
      const detail = activityDetail(activity().latest!)
      list.push({ text: ` | ${detail.status} · ${detail.action}`, tone: "muted", priority: 2 })
      const target = detail.target ?? ""
      if (target) list.push({ text: ` · ${basename(target)}`, tone: "muted", priority: 3 })
    }
    list.push({ text: " | /studio-panel · detail", tone: "accent", priority: 4 })
    list.push({ text: ` | ${props.api.state.vcs?.branch ?? "local"}`, tone: "muted", priority: 5 })
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
  return (
    <box flexDirection="row" justifyContent="space-between" backgroundColor={theme().backgroundPanel} paddingLeft={1} paddingRight={1} width="100%" height={1} flexShrink={0}>
      <text fg={theme().primary}><b>ASYNC</b></text>
      <Show when={size().width >= 65}>
        <text fg={theme().textMuted}>{mcpPluginLabel(props.api)}</text>
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
            <text fg={api.theme.current.primary}><b>ASYNC AGENT / SESSION</b></text>
            <text fg={api.theme.current.text} wrapMode="word"><b>{props.title}</b></text>
            <Show when={props.share_url}><text fg={api.theme.current.textMuted} wrapMode="char">{props.share_url}</text></Show>
          </box>
        },
        sidebar_content(_ctx, props) {
          return <SidebarPresence visible={setSidebarVisible}><Overview api={api} id={props.session_id} /></SidebarPresence>
        },
        home_footer() {
          return <text fg={api.theme.current.textMuted}>OPENCODE ASYNC AGENT · v{api.app.version}</text>
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
