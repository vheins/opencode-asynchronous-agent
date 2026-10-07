import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { ToolPart } from "@opencode-ai/sdk/v2"

export function activityDetail(tool: ToolPart) {
  const input = tool.state.input
  const clean = (value: unknown) => typeof value === "string"
    ? value.split("").map((char) => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159) ? " " : char).join("").replace(/(?:Bearer\s+\S+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S+)/gi, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 120)
    : ""
  const labels: Record<string, string> = { read: "Reading file", edit: "Editing file", write: "Writing file", glob: "Finding files", grep: "Searching code", search: "Searching information", bash: "Running command", task: "Delegating agent", subagent: "Delegating agent" }
  const action = labels[tool.tool] ?? clean(tool.tool)
  const target = clean(input.description) || clean(input.filePath ?? input.file_path ?? input.path) || clean(input.title)
  const status = { pending: "Queued", running: "Running", completed: "Done", error: "Failed" }[tool.state.status]
  const background = tool.state.status === "completed" && tool.state.metadata.background === true
  const duration = tool.state.status === "completed" || tool.state.status === "error"
    ? ` · ${Math.max(0, (tool.state.time.end - tool.state.time.start) / 1000).toFixed(1)}s` : ""
  const result = tool.state.status === "error" ? "Check the failure details in the conversation."
    : background ? "Launched; child status is tracked separately."
    : tool.state.status === "completed" ? `Tool finished${duration}.` : ""
  return { action, target, status: background ? "Launched" : status, result }
}

export function sessionMetrics(api: TuiPluginApi, id: string) {
  const messages = api.state.session.messages(id)
  const latest = [...messages].reverse().find((message) => message.role === "assistant")
  const model = latest?.role === "assistant" ? latest.modelID : undefined
  const provider = latest?.role === "assistant" ? latest.providerID : undefined
  const reported = [...messages].reverse().find((message) => message.role === "assistant" && message.modelID === model && message.providerID === provider && [message.tokens.input, message.tokens.output, message.tokens.reasoning, message.tokens.cache.read, message.tokens.cache.write].some((value) => Number.isFinite(value) && value > 0))
  const tokens = reported?.role === "assistant" ? reported.tokens : undefined
  const used = tokens ? [tokens.input, tokens.output, tokens.reasoning, tokens.cache.read, tokens.cache.write].reduce((sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 0), 0) : undefined
  const limit = api.state.provider.find((item) => item.id === provider)?.models[model ?? ""]?.limit.context
  return {
    model: model ?? "Waiting for response",
    provider: provider ?? "No usage yet",
    agent: latest?.role === "assistant" ? latest.agent : undefined,
    used,
    percent: used !== undefined && limit && limit > 0 ? Math.round(used / limit * 100) : undefined,
    cost: messages.reduce((total, message) => total + (message.role === "assistant" ? message.cost : 0), 0),
  }
}

export function sidebarActivity(api: TuiPluginApi, id: string) {
  const tools = api.state.session.messages(id).flatMap((message) =>
    api.state.part(message.id).filter((part) => part.type === "tool")
  )
  const servers = [...api.state.mcp()].sort((a, b) => b.name.length - a.name.length)
  const active = tools.filter((tool) => tool.state.status === "running" || tool.state.status === "pending")
  const mcpName = (name: string) => servers.find((server) => {
    const key = server.name.replace(/[^a-zA-Z0-9_-]/g, "_")
    return [server.name, key].some((prefix) => name.startsWith(`${prefix}_`) || name.startsWith(`${prefix}-`))
  })?.name
  const mcp = servers.flatMap((server) => {
    const calls = active.filter((tool) => mcpName(tool.tool) === server.name)
    return calls.length ? [{ name: server.name, calls }] : []
  })
  const agents = tools.filter((tool) => tool.tool === "task" || tool.tool === "subagent").flatMap((tool) => {
    const metadata = tool.state.status === "pending" ? undefined : tool.state.metadata
    const child = typeof metadata?.sessionId === "string" ? metadata.sessionId : undefined
    const status = child ? api.state.session.status(child) : undefined
    const waiting = child ? api.state.session.permission(child).length + api.state.session.question(child).length : 0
    const running = status ? status.type !== "idle" : tool.state.status === "running" || tool.state.status === "pending"
    if (!running && !waiting) return []
    return [{
      id: child ?? tool.callID,
      name: typeof tool.state.input.subagent_type === "string" ? tool.state.input.subagent_type : "subagent",
      label: waiting ? "Waiting for answer" : status?.type === "retry" ? "Retrying" : "Working",
      target: activityDetail(tool).target,
    }]
  }).filter((agent, index, list) => list.findIndex((item) => item.id === agent.id) === index)
  const todos = api.state.session.todo(id)
  return {
    mcp,
    latest: tools.at(-1),
    current: active.at(-1),
    agents,
    tools: active.filter((tool) => !mcpName(tool.tool) && tool.tool !== "task" && tool.tool !== "subagent"),
    todos: todos.filter((todo) => todo.status === "in_progress" || todo.status === "pending")
      .sort((a, b) => Number(b.status === "in_progress") - Number(a.status === "in_progress")),
    completed: todos.filter((todo) => todo.status === "completed").length,
    total: todos.length,
    attention: api.state.session.permission(id).length + api.state.session.question(id).length,
    status: api.state.session.status(id),
  }
}
