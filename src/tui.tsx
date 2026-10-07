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

/** Formats a millisecond duration as `Xm Yd` / `Xj Ym Zd`. */
function durationLabel(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds / 60) % 60
  return hours ? `${hours}j ${minutes}m ${seconds % 60}d` : `${minutes}m ${seconds % 60}d`
}

/** Total tokens reported by a child session's latest assistant message, if any. */
function childTokens(api: TuiPluginApi, childID: string) {
  const latest = [...api.state.session.messages(childID)].reverse().find((message) => message.role === "assistant")
  if (!latest || latest.role !== "assistant") return undefined
  const tokens = latest.tokens
  const total = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
  return total > 0 ? total : undefined
}

type SubagentStatus = "running" | "done" | "error"

type SubagentRow = {
  id: string
  label: string
  status: SubagentStatus
  elapsedMs: number
  tokens: number | undefined
  tokensPerSecond: number | undefined
}

/**
 * Derives the async-agent aggregate (running/done/error/total) and per-subagent
 * elapsed + tokens + tokens/sec from the parent session's task/subagent tool parts.
 */
function asyncIdentity(api: TuiPluginApi, id: string) {
  const now = Date.now()
  const tools = api.state.session.messages(id)
    .flatMap((message) => api.state.part(message.id))
    .filter((part): part is ToolPart => part.type === "tool")
    .filter((part) => part.tool === "task" || part.tool === "subagent")
  const rows: SubagentRow[] = tools.map((part) => {
    const state = part.state
    const child = state.status === "pending" ? undefined : typeof state.metadata?.sessionId === "string" ? state.metadata.sessionId : undefined
    const status: SubagentStatus = state.status === "completed" ? "done" : state.status === "error" ? "error" : "running"
    const started = state.status === "pending" ? undefined : state.time.start
    const ended = state.status === "completed" || state.status === "error" ? state.time.end : undefined
    const elapsedMs = started === undefined ? 0 : Math.max(0, (ended ?? now) - started)
    const tokens = child ? childTokens(api, child) : undefined
    const seconds = elapsedMs / 1000
    return {
      id: child ?? part.callID,
      label: activityDetail(part).target || part.tool,
      status,
      elapsedMs,
      tokens,
      tokensPerSecond: tokens !== undefined && seconds > 0 ? tokens / seconds : undefined,
    }
  })
  return {
    rows,
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
        title: ok ? "Subagent selesai" : "Subagent gagal",
        message: label,
        duration: ok ? 4000 : 6000,
      })
    } catch {
      // Toast is best-effort; never break the event loop.
    }
  })
  api.lifecycle.onDispose(() => { off(); previous.clear() })
}

export function InfoCard(props: { api: TuiPluginApi; name: string; title: string; summary: string; children: JSX.Element; initialOpen?: boolean; onOpen?: (open: boolean) => void }) {
  const [open, setOpen] = createSignal(props.api.kv.get<boolean>(`studio.card.${props.name}`, props.initialOpen ?? false))
  const theme = () => props.api.theme.current
  createEffect(() => props.onOpen?.(open()))
  const toggle = () => {
    const next = !open()
    setOpen(next)
    props.api.kv.set(`studio.card.${props.name}`, next)
  }
  const unregister = props.api.command?.register(() => [{
    title: `Studio: ${open() ? "tutup" : "buka"} ${props.title}`,
    value: `studio.card.${props.name}`,
    category: "Studio",
    slash: { name: `studio-${props.name}` },
    onSelect: (dialog) => { toggle(); dialog?.clear() },
  }])
  if (unregister) onCleanup(unregister)
  return <box backgroundColor={theme().backgroundElement} paddingLeft={1} paddingRight={1}>
    <box onMouseDown={(event) => { if (event.button === 0) { event.stopPropagation(); toggle() } }}>
      <text fg={theme().primary}><b>{open() ? "▾" : "▸"} {props.title}</b></text>
      <text fg={theme().textMuted} wrapMode="word">{props.summary}</text>
    </box>
    <Show when={open()}><box paddingTop={1} paddingBottom={1}>{props.children}</box></Show>
  </box>
}

export function SubagentCard(props: { api: TuiPluginApi; agent: ReturnType<typeof sidebarActivity>["agents"][number]; ended?: number }) {
  const [data, setData] = createSignal<Awaited<ReturnType<typeof fetchSubagent>>>()
  const [error, setError] = createSignal("")
  const [now, setNow] = createSignal(Date.now())
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
      catch { if (!controller.signal.aborted) setError("Detail belum tersedia; mencoba lagi.") }
      finally { pending = false }
    }
    void refresh()
    const poll = ended ? undefined : setInterval(() => void refresh(), 5000)
    const clock = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => { controller.abort(); clearInterval(poll); clearInterval(clock) })
  })
  return <InfoCard api={props.api} name={`agent-${props.agent.id}`} title={`${props.agent.name} · ${props.ended ? "Baru berakhir" : props.agent.label}`} summary={`${data()?.model ?? "Memuat model…"}\n${elapsedLabel(data()?.started, props.ended ?? now())} sejak sesi dibuat`}>
    <Show when={props.agent.target}><text fg={theme().text} wrapMode="word">{props.agent.target}</text></Show>
    <Show when={error()}><text fg={theme().warning}>{error()}</text></Show>
    <Show when={data()}>{(detail) => <box gap={1}>
      <text fg={theme().text} wrapMode="word">{detail().activity ? `${detail().current ? "Sekarang" : "Terakhir"} · ${detail().activity!.action} · ${detail().activity!.status}` : "Aktivitas tool belum dilaporkan."}</text>
      <Show when={detail().activity?.target}><text fg={theme().textMuted} wrapMode="char">{detail().activity?.target}</text></Show>
      <text fg={theme().textMuted}>{detail().todos.length ? `${detail().completed}/${detail().todos.length} tugas selesai` : "Progres tugas belum dilaporkan."}</text>
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
      catch { if (!controller.signal.aborted) setError("Pemindaian Git gagal. Periksa akses folder dan instalasi Git.") }
      finally { pending = false }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 15000)
    onCleanup(() => { controller.abort(); clearInterval(timer) })
  })
  return <InfoCard api={props.api} name="files" title="Ruang kerja & berkas" onOpen={setOpen} summary={error() || (data() ? `${data()!.repos.length} repo Git · ${data()!.repos.reduce((n, repo) => n + repo.files.length, 0)} entri berubah` : open() ? "Memindai repositori…" : "Buka untuk memindai repo root dan subfolder")}>
    <text fg={theme().textMuted} wrapMode="char">{props.api.state.path.directory}</text>
    <text fg={theme().textMuted}>Git lokal, bukan hanya perubahan sesi · refresh 15 dtk</text>
    <Show when={data()}>{(scan) => <box gap={1}>
      <For each={scan().repos} fallback={<text fg={theme().textMuted}>Tidak ditemukan repo Git dalam cakupan pemindaian.</text>}>{(repo) => <box>
        <text fg={theme().primary} wrapMode="char"><b>{repo.path}</b> · {repo.branch}</text>
        <Show when={repo.error} fallback={<text fg={theme().textMuted}>{repo.files.length ? `${repo.files.length} entri berubah` : "Working tree bersih"}</text>}><text fg={theme().warning}>{repo.error}</text></Show>
        <For each={repo.files}>{(file) => <text fg={theme().text} wrapMode="char">{file.status} {file.path}</text>}</For>
      </box>}</For>
      <For each={scan().errors}>{(message) => <text fg={theme().warning}>{message}</text>}</For>
      <Show when={scan().limited}><text fg={theme().warning}>Cakupan dibatasi 4 tingkat / 300 folder.</text></Show>
    </box>}</Show>
    <text fg={theme().textMuted}>{props.api.state.session.diff(props.id).length} berkas tercatat terpisah oleh sesi OpenCode.</text>
  </InfoCard>
}

/** Async-agent aggregate: running/done/err/total plus per-subagent elapsed + tokens + tokens/sec. */
export function AsyncIdentity(props: { api: TuiPluginApi; id: string; compact?: boolean }) {
  const theme = () => props.api.theme.current
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  const data = createMemo(() => asyncIdentity(props.api, props.id))
  return <box backgroundColor={theme().backgroundElement} paddingLeft={1} paddingRight={1}>
    <text fg={theme().primary}><b>Subagents {data().total}</b></text>
    <text fg={theme().text}>● {data().running} run · ✓ {data().done} done · ✕ {data().error} err · Σ {data().total}</text>
    <Show when={!props.compact}>
      <For each={data().rows.slice(0, 4)}>{(row) => <box>
        <text fg={row.status === "error" ? theme().error : row.status === "done" ? theme().success : theme().text} wrapMode="word">
          {row.status === "done" ? "✓" : row.status === "error" ? "✕" : "●"} {row.label}
        </text>
        <text fg={theme().textMuted}>↳ {durationLabel(row.elapsedMs)}{row.tokens === undefined ? "" : ` · ${compact(row.tokens)} tok`}{row.tokensPerSecond === undefined ? "" : ` · ${row.tokensPerSecond.toFixed(1)} t/s`}</text>
      </box>}</For>
    </Show>
    <Show when={!props.compact && data().total > 4}><text fg={theme().textMuted}>+{data().total - 4} subagent lainnya</text></Show>
  </box>
}

/** Describes why the parent is waiting, if it is. */
export function waitingReason(api: TuiPluginApi, id: string, activity: ReturnType<typeof sidebarActivity>) {
  if (api.state.session.permission(id).length) return "Menunggu izin kamu"
  if (api.state.session.question(id).length) return "Menunggu pilihan / jawaban kamu"
  if (activity.status?.type === "retry") return "Menunggu percobaan ulang model"
  if (activity.current?.tool === "task" || activity.current?.tool === "subagent" || (!activity.current && activity.agents.length)) return "Menunggu hasil subagent"
  if (activity.current) return `${activity.current.state.status === "pending" ? "Mengantre" : "Menunggu hasil"} · ${activityDetail(activity.current).action}`
  if (activity.status?.type === "busy") return "Menunggu respons model"
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
  return <Show when={props.reason}><text wrapMode="word">{props.reason} · {seconds()} dtk teramati</text></Show>
}

export function Overview(props: { api: TuiPluginApi; id: string; mini?: boolean }) {
  const theme = () => props.api.theme.current
  const data = createMemo(() => sessionMetrics(props.api, props.id))
  const activity = createMemo(() => sidebarActivity(props.api, props.id))
  const calls = createMemo(() => new Map(props.api.state.session.messages(props.id).flatMap((message) => props.api.state.part(message.id).filter((part) => part.type === "tool")).map((part) => [part.callID, part])))
  const detail = (tool: Parameters<typeof activityDetail>[0]) => activityDetail(calls().get(tool.callID) ?? tool)
  const mcp = retainActivity(() => activity().mcp, (server) => server.name, () => props.id)
  const agents = retainActivity(() => activity().agents, (agent) => agent.id, () => props.id)
  const tools = retainActivity(() => activity().tools, (tool) => tool.callID, () => props.id)
  const size = useTerminalDimensions()
  const limit = () => size().height < 35 ? 2 : 4
  return (
    <box gap={1} flexShrink={0}>
      <box>
        <text fg={theme().text} wrapMode="char"><b>{data().model}</b></text>
        <text fg={theme().textMuted}>{data().agent ?? "Sesi baru"} · {activity().status?.type === "busy" ? "Bekerja" : activity().status?.type === "retry" ? "Mencoba ulang" : "Siap"}</text>
      </box>
      <ObservedWait reason={waitingReason(props.api, props.id, activity())} session={props.id} />
      <AsyncIdentity api={props.api} id={props.id} />
      <Show when={activity().attention > 0}>
        <box>
          <text fg={theme().warning}><b>Butuh jawaban · {activity().attention}</b></text>
          <text fg={theme().textMuted}>Periksa permintaan di percakapan.</text>
        </box>
      </Show>
      <InfoCard api={props.api} name="connections" title="Koneksi MCP" initialOpen summary={`${props.api.state.mcp().filter((server) => server.status === "connected").length}/${props.api.state.mcp().length} terhubung · ${activity().mcp.length} sedang dipakai`}>
        <Show when={mcp().length > 0}>
          <box>
            <text fg={theme().primary}><b>MCP sedang dipakai / terakhir</b></text>
            <For each={mcp().slice(0, limit())}>{(row) => <box>
              <text fg={theme().text} wrapMode="char">{row.item.name} · {row.ended === undefined ? `${row.item.calls.length} panggilan` : "Baru berakhir"}</text>
              <For each={row.item.calls.slice(0, 2)}>{(call) => <text fg={theme().textMuted} wrapMode="word">{detail(call).status} · {detail(call).action}{detail(call).target ? ` · ${detail(call).target}` : ""}</text>}</For>
            </box>}</For>
            <Show when={mcp().length > limit()}><text fg={theme().textMuted}>+{mcp().length - limit()} MCP lainnya</text></Show>
          </box>
        </Show>
        <For each={props.api.state.mcp().filter((server) => !mcp().some((row) => row.item.name === server.name))}>{(server) =>
          <text fg={server.status === "connected" ? theme().textMuted : theme().warning} wrapMode="char">{server.name} · {server.status === "connected" ? "Terhubung · tidak sedang dipakai" : server.status}</text>
        }</For>
        <Show when={!props.api.state.mcp().length}><text fg={theme().textMuted}>Tidak ada server MCP.</text></Show>
      </InfoCard>
      <Show when={agents().length > 0}>
        <box>
          <text fg={theme().primary}><b>Subagent · {agents().length}</b></text>
          <For each={agents().slice(0, limit())}>{(row) =>
            <SubagentCard api={props.api} agent={row.item} ended={row.ended} />
          }</For>
          <Show when={agents().length > limit()}><text fg={theme().textMuted}>+{agents().length - limit()} agent lainnya</text></Show>
        </box>
      </Show>
      <InfoCard api={props.api} name="result" title="Aktivitas & hasil" initialOpen summary={activity().current ? `${activityDetail(activity().current!).action} · ${activityDetail(activity().current!).status}` : activity().latest ? `${activityDetail(activity().latest!).action} · ${activityDetail(activity().latest!).status}` : "Belum ada aktivitas tool"}>
        <Show when={tools().length > 0}>
          <box>
            <For each={tools().slice(0, limit())}>{(row) =>
              <box><text fg={theme().text} wrapMode="word">{detail(row.item).action} · {detail(row.item).status}{detail(row.item).target ? ` · ${detail(row.item).target}` : ""}</text><Show when={detail(row.item).result}><text fg={theme().textMuted} wrapMode="word">{detail(row.item).result}</text></Show></box>
            }</For>
            <Show when={tools().length > limit()}><text fg={theme().textMuted}>+{tools().length - limit()} tool lainnya</text></Show>
          </box>
        </Show>
        <Show when={activity().latest && !tools().slice(0, limit()).some((row) => row.item.callID === activity().latest?.callID) && !mcp().some((row) => row.item.calls.some((call) => call.callID === activity().latest?.callID)) && !["task", "subagent"].includes(activity().latest!.tool) ? activity().latest : undefined}>{(latest) => <box>
          <text fg={theme().text} wrapMode="word">{activityDetail(latest()).target || activityDetail(latest()).action}</text>
          <text fg={theme().textMuted} wrapMode="word">{activityDetail(latest()).result || "Masih diproses; belum ada hasil akhir."}</text>
        </box>}</Show>
        <text fg={theme().textMuted} wrapMode="word">Hasil tes: lihat keluaran pengujian di percakapan; status tool bukan bukti tes lulus.</text>
      </InfoCard>
      <InfoCard api={props.api} name="context" title="Laporan token provider" summary={data().used === undefined ? "Token belum dilaporkan" : `${compact(data().used ?? NaN)} token · laporan terakhir`}>
        <text fg={theme().textMuted} wrapMode="char">Provider · {data().provider}</text>
        <text fg={theme().textMuted}>Konteks aktif DCP · belum diukur</text>
        <text fg={theme().textMuted} wrapMode="word">Laporan ini menjumlahkan input, output, reasoning, dan cache dari pesan model terakhir yang melaporkan penggunaan.</text>
        <text fg={theme().textMuted} wrapMode="word">Periksa /dcp untuk statistik kompresi. Angka provider bukan ukuran pesan yang akan dikirim sesudah DCP.</text>
        <text fg={theme().textMuted}>Biaya tercatat · ${data().cost.toFixed(4)}</text>
      </InfoCard>
      <InfoCard api={props.api} name="progress" title="Progres tugas" initialOpen summary={`${activity().completed}/${activity().total} selesai · ${activity().todos.length} tersisa`}>
        <Show when={activity().total > 0} fallback={<text fg={theme().textMuted}>Belum ada daftar tugas di sesi ini.</text>}>
          <text fg={theme().textMuted}>{activity().todos.filter((todo) => todo.status === "in_progress").length} berjalan · {activity().todos.filter((todo) => todo.status === "pending").length} antre</text>
          <For each={[...props.api.state.session.todo(props.id)].sort((a, b) => ({ in_progress: 0, pending: 1, completed: 2 }[a.status] ?? 3) - ({ in_progress: 0, pending: 1, completed: 2 }[b.status] ?? 3))}>{(todo) =>
            <box marginTop={1}><text fg={todo.status === "in_progress" ? theme().primary : theme().textMuted}>{todo.status === "completed" ? "✓ Selesai" : todo.status === "in_progress" ? "› Sedang dikerjakan" : "· Menunggu"}</text><text fg={todo.status === "completed" ? theme().textMuted : theme().text} wrapMode="word">{todo.content}</text></box>
          }</For>
        </Show>
      </InfoCard>
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
  const data = createMemo(() => sessionMetrics(props.api, props.id))
  const identity = createMemo(() => asyncIdentity(props.api, props.id))
  const theme = () => props.api.theme.current
  const open = () => props.api.ui.dialog.replace(() => <props.api.ui.Dialog onClose={() => props.api.ui.dialog.clear()}>
    <box padding={1}>
      <text fg={theme().primary}><b>Studio · Detail sesi</b> · Esc tutup</text>
      <scrollbox height={Math.max(5, size().height - 10)}>
        <Overview api={props.api} id={props.id} mini />
      </scrollbox>
    </box>
  </props.api.ui.Dialog>)
  const unregister = props.api.command?.register(() => [{
    title: "Studio: buka seluruh informasi sesi", value: "studio.panel", category: "Studio", slash: { name: "studio-panel" },
    onSelect: () => open(),
  }])
  if (unregister) onCleanup(unregister)
  return <Show when={!props.sidebarVisible}>
    <box backgroundColor={theme().backgroundPanel} flexDirection="row" width="100%" height={8} flexShrink={0} gap={1} paddingLeft={1} paddingRight={1}>
      <box flexGrow={1} minWidth={0} flexShrink={1}>
        <text height={1} fg={theme().primary}><b>ASYNC · {data().agent ?? "Sesi"}</b></text>
        <text height={1} fg={theme().text}>{activity().attention ? `${activity().attention} permintaan menunggu jawaban` : identity().running > 0 ? `${identity().running} subagent berjalan` : "Siap"}</text>
        <text height={1} fg={theme().textMuted}>{data().model}{data().used === undefined ? "" : ` · ${compact(data().used ?? NaN)} token (laporan)`}</text>
        <text height={1} fg={theme().text}>● {identity().running} run · ✓ {identity().done} done · ✕ {identity().error} err · Σ {identity().total}</text>
        <text height={1} fg={theme().text}>{activity().latest ? `${activityDetail(activity().latest!).status} · ${activityDetail(activity().latest!).action}` : "Belum ada aktivitas tool"}</text>
        <text height={1} fg={theme().textMuted}>{activity().latest ? activityDetail(activity().latest!).target : ""}</text>
        <box onMouseDown={(event) => { if (event.button === 0) { event.stopPropagation(); open() } }}>
          <text height={1} fg={theme().primary}>/studio-panel · detail</text>
        </box>
      </box>
    </box>
  </Show>
}

function StatusBar(props: { api: TuiPluginApi }) {
  const size = useTerminalDimensions()
  const theme = () => props.api.theme.current
  const mcp = () => props.api.state.mcp()
  const plugins = () => props.api.plugins.list().filter((item) => item.source !== "internal")
  return (
    <box flexDirection="row" justifyContent="space-between" backgroundColor={theme().backgroundPanel} paddingLeft={1} paddingRight={1} width="100%">
      <text fg={theme().primary}><b>ASYNC</b></text>
      <Show when={size().width >= 65}>
        <text fg={theme().textMuted}>{mcp().filter((item) => item.status === "connected").length}/{mcp().length} MCP · {plugins().filter((item) => item.active).length}/{plugins().length} plugin TUI aktif</text>
      </Show>
      <text fg={theme().textMuted}>{props.api.state.vcs?.branch ?? "lokal"}</text>
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
            <text fg={api.theme.current.primary}><b>ASYNC AGENT / SESI</b></text>
            <text fg={api.theme.current.text} wrapMode="word"><b>{props.title}</b></text>
            <Show when={props.share_url}><text fg={api.theme.current.textMuted} wrapMode="char">{props.share_url}</text></Show>
          </box>
        },
        sidebar_content(_ctx, props) {
          return <SidebarPresence visible={setSidebarVisible}><Overview api={api} id={props.session_id} /></SidebarPresence>
        },
        sidebar_footer(_ctx, props) {
          return <AsyncIdentity api={api} id={props.session_id} compact />
        },
        home_footer() {
          return <text fg={api.theme.current.textMuted}>OPENCODE ASYNC AGENT · v{api.app.version}</text>
        },
        app_bottom() {
          return <box flexShrink={0}>
            <Show when={sessionID()}>{(id) => <ResponsiveDock api={api} id={id()} sidebarVisible={sidebarVisible()} />}</Show>
            <StatusBar api={api} />
          </box>
        },
      },
    })
  },
}

export default plugin
