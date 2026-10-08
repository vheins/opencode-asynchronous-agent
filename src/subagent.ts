import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Message, Part, Session, Todo } from "@opencode-ai/sdk/v2"
import { activityDetail } from "./model"

/** Latest assistant message in a child transcript, if any. */
function latestAssistant(messages: ReadonlyArray<Message>) {
  return [...messages].reverse().find((message) => message.role === "assistant")
}

/** Provider/model of a child's latest assistant message, falling back to its session model. */
export function subagentModel(session: Session | undefined, messages: ReadonlyArray<Message>) {
  const assistant = latestAssistant(messages)
  const providerID = assistant?.providerID ?? session?.model?.providerID
  const modelID = assistant?.modelID ?? session?.model?.id
  return { providerID, modelID }
}

/** Token usage of the newest assistant message that actually reports any, if present. */
function latestReportedTokens(messages: ReadonlyArray<Message>) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== "assistant") continue
    const { input, output, reasoning, cache } = message.tokens
    if ([input, output, reasoning, cache.read, cache.write].some((value) => Number.isFinite(value) && value > 0)) return message.tokens
  }
  return undefined
}

export function subagentDetails(session: Session | undefined, messages: { info: Message; parts: Part[] }[], todos: Todo[], limit?: number) {
  const infos = messages.map((entry) => entry.info)
  const assistant = latestAssistant(infos)
  const tools = messages.flatMap((entry) => entry.parts.filter((part) => part.type === "tool"))
  const current = [...tools].reverse().find((part) => part.state.status === "running" || part.state.status === "pending")
  const latest = current ?? tools.at(-1)
  // The newest assistant message is often mid-step with `tokens = 0`, so read
  // usage from the newest message that actually reports tokens; otherwise a live
  // subagent would show no context/token line until it finishes.
  const usage = latestReportedTokens(infos)
  const used = usage ? [usage.input, usage.output, usage.reasoning, usage.cache.read, usage.cache.write].reduce((sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 0), 0) : 0
  const { providerID, modelID } = subagentModel(session, infos)
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
    percent: used > 0 && limit !== undefined && limit > 0 ? Math.round(used / limit * 100) : undefined,
  }
}

export async function fetchSubagent(api: TuiPluginApi, sessionID: string, signal: AbortSignal) {
  const params = { sessionID, directory: api.state.path.directory }
  const [session, messages, todos] = await Promise.all([
    api.client.session.get(params, { signal }),
    api.client.session.messages({ ...params, limit: 30 }, { signal }),
    api.client.session.todo(params, { signal }),
  ])
  if (session.error || messages.error || todos.error) throw new Error("Subagent details not available from host")
  const list = messages.data ?? []
  const { providerID, modelID } = subagentModel(session.data, list.map((entry) => entry.info))
  const limit = providerID && modelID ? api.state.provider.find((item) => item.id === providerID)?.models[modelID]?.limit.context : undefined
  return subagentDetails(session.data, list, todos.data ?? [], limit)
}

export function elapsedLabel(start: number | undefined, now: number) {
  if (start === undefined || !Number.isFinite(start) || start <= 0) return "Duration not available yet"
  const seconds = Math.max(0, Math.floor((now - start) / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds / 60) % 60
  return hours ? `${hours}h ${minutes}m ${seconds % 60}s` : `${minutes}m ${seconds % 60}s`
}
