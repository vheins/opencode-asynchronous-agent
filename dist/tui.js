// src/tui.tsx
import { use as _$use } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { useKeyboard } from "@opentui/solid";
import { useTerminalDimensions } from "@opentui/solid";
import { execFileSync } from "child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { createRequire } from "module";
import os2 from "os";
import { dirname as dirname2, join as join2 } from "path";
import { For, Show, createRoot, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

// src/reconcile.ts
var DEFAULT_STALE_RUNNING_THRESHOLD_MS = 10 * 60 * 6e4;
var RUNNING_SESSION_STATUS_VALUES = /* @__PURE__ */ new Set([
  "busy",
  "running",
  "pending",
  "queued",
  "in_progress",
  "working",
  "compacting",
  "retry"
]);
var DONE_SESSION_STATUS_VALUES = /* @__PURE__ */ new Set([
  "idle",
  "done",
  "completed",
  "complete",
  "success",
  "succeeded"
]);
var ERROR_SESSION_STATUS_VALUES = /* @__PURE__ */ new Set([
  "error",
  "failed",
  "failure",
  "cancelled",
  "canceled",
  "aborted"
]);
function parseStaleRunningThresholdMs(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return DEFAULT_STALE_RUNNING_THRESHOLD_MS;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_STALE_RUNNING_THRESHOLD_MS;
  }
  return Math.floor(parsed);
}
function deriveOpenCodeSessionStatus(value) {
  if (hasStructuredErrorEvidence(value)) {
    return "error";
  }
  const values = collectOpenCodeSessionStatusValues(value);
  if (values.some((status) => ERROR_SESSION_STATUS_VALUES.has(status))) {
    return "error";
  }
  if (values.some((status) => RUNNING_SESSION_STATUS_VALUES.has(status))) {
    return "running";
  }
  if (values.some((status) => DONE_SESSION_STATUS_VALUES.has(status))) {
    return "done";
  }
  return void 0;
}
function hasStructuredErrorEvidence(value, depth = 0) {
  if (depth > 4) return false;
  const record = asRecord(value);
  if (!record) return false;
  if (record.error) return true;
  for (const nested of Object.values(record)) {
    if (Array.isArray(nested)) {
      if (nested.some((item) => hasStructuredErrorEvidence(item, depth + 1))) {
        return true;
      }
      continue;
    }
    if (hasStructuredErrorEvidence(nested, depth + 1)) return true;
  }
  return false;
}
function resolveSessionStatusWithMessageSummary(input) {
  const summary = input.summary;
  if (input.status === "error") {
    return { status: "error", endedAt: summary?.evidenceAt };
  }
  if (input.status === "running") {
    return { status: "running" };
  }
  if (summary && !summary.fetchFailed && summary.hasError) {
    return { status: "error", endedAt: summary.evidenceAt };
  }
  if (input.status === "done") {
    return {
      status: "done",
      endedAt: summary?.completedAt ?? summary?.evidenceAt
    };
  }
  if (summary && !summary.fetchFailed && typeof summary.completedAt === "string") {
    return { status: "done", endedAt: summary.completedAt };
  }
  return {};
}
function summarizeSessionMessages(messages) {
  let completedAt;
  let evidenceAt;
  let hasError = false;
  let latestAssistantActivityAt;
  let latestAssistantActivityAtMs;
  let latestMessageActivityAt;
  let latestMessageActivityAtMs;
  const messageInfos = messages.map((rawMessage) => asRecord(rawMessage)).map((message) => asRecord(message?.info));
  for (const info of messageInfos) {
    if (!info) continue;
    const activityMs = messageTimeMillis(info);
    if (activityMs > 0 && (latestMessageActivityAtMs === void 0 || activityMs > latestMessageActivityAtMs)) {
      latestMessageActivityAtMs = activityMs;
      latestMessageActivityAt = new Date(activityMs).toISOString();
    }
  }
  const assistantMessages = messageInfos.filter(
    (info) => info?.role === "assistant"
  ).sort((left, right) => messageTimeMillis(left) - messageTimeMillis(right));
  for (const info of assistantMessages) {
    const time = asRecord(info.time);
    const activityMs = messageTimeMillis(info);
    if (activityMs > 0 && (latestAssistantActivityAtMs === void 0 || activityMs > latestAssistantActivityAtMs)) {
      latestAssistantActivityAtMs = activityMs;
      latestAssistantActivityAt = new Date(activityMs).toISOString();
    }
    const candidate = timestampFromUnknown(time?.completed);
    const errorAt = timestampFromUnknown(time?.updated) ?? timestampFromUnknown(time?.completed) ?? timestampFromUnknown(time?.created);
    if (info.error) {
      hasError = true;
      evidenceAt = errorAt ?? evidenceAt;
    } else if (candidate) {
      completedAt = candidate;
      evidenceAt = candidate;
      hasError = false;
    }
  }
  return {
    completedAt,
    evidenceAt,
    hasError,
    latestAssistantActivityAt,
    latestAssistantActivityAtMs,
    latestMessageActivityAt,
    latestMessageActivityAtMs
  };
}
function hasRecentMessageActivity(input) {
  return input.latestMessageActivityAtMs !== void 0 && input.nowMs - input.latestMessageActivityAtMs < input.staleThresholdMs;
}
function canSafelyCloseNoTargetPersistedCandidate(input) {
  if (input.staleThresholdMs <= 0) return false;
  if (input.startedMs < input.staleThresholdMs || input.updatedMs < input.staleThresholdMs) {
    return false;
  }
  return !hasRecentMessageActivity({
    nowMs: input.nowMs,
    latestMessageActivityAtMs: input.latestMessageActivityAtMs,
    staleThresholdMs: input.staleThresholdMs
  });
}
function shouldApplyStaleRunningFallback(input) {
  return input.staleThresholdMs > 0 && input.evidence.canApplyStaleFallback === true && input.evidence.probeFailed !== true && input.startedMs >= input.staleThresholdMs && input.updatedMs >= input.staleThresholdMs;
}
function shouldSkipCandidateForBackoff(cache, nowMs) {
  return cache !== void 0 && nowMs < cache.nextAllowedAtMs;
}
function nextBackoffState(input) {
  const nextBackoffMs = input.cache ? Math.min(
    input.maxBackoffMs,
    Math.max(input.initialBackoffMs, input.cache.backoffMs * 2)
  ) : input.initialBackoffMs;
  return {
    backoffMs: nextBackoffMs,
    nextAllowedAtMs: input.nowMs + nextBackoffMs
  };
}
function capCandidates(candidates, maxCandidates) {
  if (maxCandidates <= 0) return [];
  return candidates.length <= maxCandidates ? candidates : candidates.slice(0, maxCandidates);
}
function resolvePersistedStaleSubtaskFromParentMessages(input) {
  const matches = [];
  for (const rawMessage of input.messages) {
    const message = asRecord(rawMessage);
    const info = asRecord(message?.info);
    if (!info || info.role !== "assistant") continue;
    const assistantParentID = asString(
      info.parentID ?? message?.parentID ?? message?.parentMessageID
    );
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    for (const rawPart of parts) {
      const part = asRecord(rawPart);
      if (!part || part.type !== "tool" || part.tool !== "task") continue;
      const state = asRecord(part.state);
      const rawStatus = asString(state?.status);
      const status = rawStatus === "completed" ? "done" : rawStatus === "error" ? "error" : void 0;
      if (!status) continue;
      const metadata = asRecord(state?.metadata);
      const targetSessionID = sessionIDFromUnknown(metadata?.sessionId) ?? sessionIDFromUnknown(metadata?.sessionID) ?? parseTaskSessionIDFromOutput(state?.output);
      const partTitle = asString(state?.input && asRecord(state.input)?.description) ?? asString(state?.title) ?? asString(part.description);
      const partSummary = asString(state?.input && asRecord(state.input)?.prompt) ?? asString(state?.description);
      const partAgent = asString(state?.input && asRecord(state.input)?.subagent_type) ?? asString(part.agent);
      const parentMessageMatch = assistantParentID !== void 0 && assistantParentID === input.candidate.messageID;
      const titleMatch = sameDisplayText(partTitle, input.candidate.title);
      const summaryMatch = sameDisplayText(partSummary, input.candidate.summary);
      const agentMatch = sameDisplayText(partAgent, input.candidate.agentName);
      const metadataCompositeMatch = summaryMatch || titleMatch && agentMatch && !!input.candidate.summary;
      if (!parentMessageMatch && !metadataCompositeMatch) {
        continue;
      }
      const score = (parentMessageMatch ? 100 : 0) + (summaryMatch ? 40 : 0) + (titleMatch ? 20 : 0) + (agentMatch ? 10 : 0);
      const endedAt = timestampFromUnknown(
        asRecord(state?.time)?.end ?? asRecord(state?.time)?.completed ?? asRecord(state?.time)?.updated
      ) ?? timestampFromUnknown(
        asRecord(info?.time)?.completed ?? asRecord(info?.time)?.updated ?? asRecord(info?.time)?.created
      );
      matches.push({
        status,
        endedAt,
        targetSessionID,
        score
      });
    }
  }
  if (matches.length === 0) return void 0;
  if (matches.length === 1) {
    const [only] = matches;
    return {
      status: only.status,
      endedAt: only.endedAt,
      targetSessionID: only.targetSessionID
    };
  }
  const ranked = [...matches].sort((left, right) => right.score - left.score);
  const [best, second] = ranked;
  if (!best || second && best.score === second.score) return void 0;
  return {
    status: best.status,
    endedAt: best.endedAt,
    targetSessionID: best.targetSessionID
  };
}
function asRecord(value) {
  return value && typeof value === "object" ? value : void 0;
}
function collectOpenCodeSessionStatusValues(value) {
  if (typeof value === "string") {
    const normalized = normalizeStatusValue(value);
    return normalized ? [normalized] : [];
  }
  const record = asRecord(value);
  if (!record) return [];
  const values = [
    normalizeStatusValue(record.type),
    normalizeStatusValue(record.status),
    normalizeStatusValue(record.state),
    normalizeStatusValue(record.phase),
    normalizeStatusValue(record.result)
  ].filter((status) => Boolean(status));
  if (record.error) values.push("error");
  if (record.busy === true || record.running === true) values.push("busy");
  return values;
}
function normalizeStatusValue(value) {
  if (typeof value !== "string") return void 0;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : void 0;
}
function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function sameDisplayText(left, right) {
  if (!left || !right) return false;
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
function sessionIDFromUnknown(value) {
  return typeof value === "string" && value.startsWith("ses_") ? value : void 0;
}
function parseTaskSessionIDFromOutput(value) {
  if (typeof value !== "string") return void 0;
  const match = value.match(/\b(?:task_id\s*:\s*)?(ses_[A-Za-z0-9_-]+)\b/i);
  if (!match) return void 0;
  return match[1];
}
function messageTimeMillis(info) {
  const time = asRecord(info?.time);
  return timestampMillisFromUnknown(time?.completed) ?? timestampMillisFromUnknown(time?.updated) ?? timestampMillisFromUnknown(time?.created) ?? 0;
}
function timestampFromUnknown(value) {
  const millis = timestampMillisFromUnknown(value);
  return millis === void 0 ? void 0 : new Date(millis).toISOString();
}
function timestampMillisFromUnknown(value) {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? void 0 : parsed;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const millis = value < 1e10 ? value * 1e3 : value;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? void 0 : millis;
  }
  return void 0;
}

// src/state.ts
import { randomUUID } from "crypto";
import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { basename, dirname, join } from "path";
import os from "os";

// src/subagent-classification.ts
function isRealSessionID(value) {
  return typeof value === "string" && value.startsWith("ses_");
}
function isTrustedTargetSessionID(value) {
  return isRealSessionID(value);
}
function trustedTargetSessionID(item) {
  return isTrustedTargetSessionID(item.targetSessionID) ? item.targetSessionID : void 0;
}
function isRealExecution(item) {
  return item.source === "session" || isRealSessionID(item.id);
}
function realExecutionID(item) {
  return trustedTargetSessionID(item) ?? item.id;
}
function classifySubagentWorkItem(item) {
  if (isRealExecution(item)) {
    const executionID = realExecutionID(item);
    return {
      kind: "real-execution",
      executionID,
      targetSessionID: executionID
    };
  }
  const targetSessionID = trustedTargetSessionID(item);
  if (targetSessionID) {
    return {
      kind: "execution-proxy",
      executionID: targetSessionID,
      targetSessionID
    };
  }
  return { kind: "invocation-wrapper" };
}
function uniqueExecutionID(candidates) {
  const executionIDs = new Set(candidates.map((item) => realExecutionID(item)));
  return executionIDs.size === 1 ? [...executionIDs][0] : void 0;
}
function realExecutions(items) {
  return items.filter((item) => classifySubagentWorkItem(item).kind === "real-execution");
}
function resolveTrustedTargetExecutionID(item, realItems) {
  const targetSessionID = trustedTargetSessionID(item);
  if (!targetSessionID) return void 0;
  return realExecutions(realItems).some(
    (realItem) => realExecutionID(realItem) === targetSessionID
  ) ? targetSessionID : void 0;
}
function resolveSharedMessageExecutionID(item, realItems) {
  if (!item.messageID) return void 0;
  return uniqueExecutionID(
    realExecutions(realItems).filter(
      (realItem) => realItem.parentID === item.parentID && realItem.messageID === item.messageID
    )
  );
}
function resolveUniqueSameParentExecutionID(item, realItems) {
  return uniqueExecutionID(
    realExecutions(realItems).filter(
      (realItem) => realItem.parentID === item.parentID
    )
  );
}
function resolveCorrelatedExecutionID(item, realItems) {
  if (trustedTargetSessionID(item)) {
    return resolveTrustedTargetExecutionID(item, realItems);
  }
  return resolveSharedMessageExecutionID(item, realItems) ?? resolveUniqueSameParentExecutionID(item, realItems);
}
function correlateSubagentWorkItems(items) {
  const realItems = realExecutions(items);
  const executions = /* @__PURE__ */ new Map();
  for (const item of realItems) {
    const executionID = realExecutionID(item);
    if (!executions.has(executionID)) {
      executions.set(executionID, { executionID, real: item, proxies: [] });
    }
  }
  for (const item of items) {
    if (classifySubagentWorkItem(item).kind === "real-execution") continue;
    const executionID = resolveCorrelatedExecutionID(item, realItems);
    if (!executionID) continue;
    executions.get(executionID)?.proxies.push(item);
  }
  return [...executions.values()];
}
function mergeProxyMetadataWithRealExecution(real, proxy) {
  const executionID = realExecutionID(real);
  return {
    ...real,
    title: proxy.title ?? real.title,
    summary: proxy.summary ?? real.summary,
    agentName: proxy.agentName ?? real.agentName,
    messageID: real.messageID ?? proxy.messageID,
    id: real.id,
    parentID: real.parentID,
    source: "session",
    targetSessionID: real.targetSessionID ?? executionID,
    status: real.status,
    color: real.color,
    startedAt: real.startedAt,
    updatedAt: real.updatedAt,
    endedAt: real.endedAt,
    elapsedMs: real.elapsedMs,
    tokens: real.tokens,
    model: real.model
  };
}

// src/state.ts
var TERMINAL_CHILD_TTL_MS = 3 * 24 * 60 * 60 * 1e3;
var MAX_TERMINAL_CHILDREN = 1500;
function statusColor(status) {
  if (status === "done") return "green";
  if (status === "error") return "red";
  return "yellow";
}
function safeTimestamp(input, fallback) {
  if (typeof input !== "string") return fallback;
  return Number.isNaN(Date.parse(input)) ? fallback : input;
}
function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : void 0;
  }
  return void 0;
}
function toNonNegativeInteger(value) {
  const parsed = toFiniteNumber(value);
  if (parsed === void 0) return void 0;
  return Math.max(0, Math.floor(parsed));
}
function sanitizeCountedChildIDs(input) {
  if (!input || typeof input !== "object") return {};
  const counted = {};
  for (const [id, value] of Object.entries(input)) {
    if (!id) continue;
    if (value === true) {
      counted[id] = true;
    }
  }
  return counted;
}
function normalizeExecutionCounters(state) {
  state.countedChildIDs = sanitizeCountedChildIDs(state.countedChildIDs);
  const countedTotal = Object.keys(state.countedChildIDs).length;
  state.totalExecuted = Math.max(
    toNonNegativeInteger(state.totalExecuted) ?? 0,
    countedTotal
  );
}
function resolveExecutionCountIdentity(child) {
  const classification = classifySubagentWorkItem(child);
  return classification.kind === "real-execution" ? classification.executionID : void 0;
}
function countHistoricalSubagentExecutions(input) {
  const children = Array.isArray(input.children) ? input.children : Object.values(input.children);
  const scopedChildren = input.parentSessionID ? children.filter((child) => child.parentID === input.parentSessionID) : children;
  return correlateSubagentWorkItems(scopedChildren).length;
}
function countCountedSubagentExecutions(input) {
  const children = Array.isArray(input.children) ? input.children : Object.values(input.children);
  const scopedChildren = input.parentSessionID ? children.filter((child) => child.parentID === input.parentSessionID) : children;
  return correlateSubagentWorkItems(scopedChildren).filter(
    (execution) => input.countedChildIDs[execution.executionID]
  ).length;
}
function countRetainedSubagentStatuses(input) {
  const children = Array.isArray(input.children) ? input.children : Object.values(input.children);
  const scopedChildren = input.parentSessionID ? children.filter((child) => child.parentID === input.parentSessionID) : children;
  const counts = { running: 0, done: 0, error: 0 };
  for (const { real } of correlateSubagentWorkItems(scopedChildren)) {
    counts[real.status] += 1;
  }
  return counts;
}
function reconcileCountedExecutionsWithChildren(state) {
  const executionIDs = correlateSubagentWorkItems(
    Object.values(state.children)
  ).map((execution) => execution.executionID);
  state.countedChildIDs = Object.fromEntries(
    executionIDs.map((id) => [id, true])
  );
  state.totalExecuted = executionIDs.length;
}
function countChildExecution(state, child) {
  normalizeExecutionCounters(state);
  const countIdentity = resolveExecutionCountIdentity(child);
  if (!countIdentity) return false;
  if (state.countedChildIDs[countIdentity]) return false;
  const previousTotal = Math.max(
    toNonNegativeInteger(state.totalExecuted) ?? 0,
    Object.keys(state.countedChildIDs).length
  );
  state.countedChildIDs[countIdentity] = true;
  state.totalExecuted = previousTotal + 1;
  return true;
}
function sanitizeTokens(input) {
  if (!input || typeof input !== "object") return void 0;
  const raw = input;
  const tokens = {
    input: toFiniteNumber(raw.input),
    output: toFiniteNumber(raw.output),
    total: toFiniteNumber(raw.total),
    contextPercent: toFiniteNumber(raw.contextPercent)
  };
  if (tokens.input === void 0 && tokens.output === void 0 && tokens.total === void 0 && tokens.contextPercent === void 0) {
    return void 0;
  }
  return tokens;
}
function sanitizeModel(input) {
  if (!input || typeof input !== "object") return void 0;
  const raw = input;
  const providerID = typeof raw.providerID === "string" ? raw.providerID.trim() : "";
  const modelID = typeof raw.modelID === "string" ? raw.modelID.trim() : "";
  const variant = typeof raw.variant === "string" ? raw.variant.trim() : "";
  if (!providerID || !modelID) return void 0;
  return { providerID, modelID, ...variant ? { variant } : {} };
}
function sanitizeTargetSessionID(value, fallback) {
  if (typeof value === "string" && value.startsWith("ses_")) {
    return value;
  }
  if (typeof fallback === "string" && fallback.startsWith("ses_")) {
    return fallback;
  }
  return void 0;
}
function mergeTokens(existing, incoming) {
  if (!existing && !incoming) return void 0;
  return {
    input: incoming?.input ?? existing?.input,
    output: incoming?.output ?? existing?.output,
    total: incoming?.total ?? existing?.total,
    contextPercent: incoming?.contextPercent ?? existing?.contextPercent
  };
}
function sameTokens(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function normalizeComparableText(value) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}
function sanitizeSummary(value, title) {
  if (typeof value !== "string") return void 0;
  const summary = value.replace(/\s+/g, " ").trim();
  if (!summary) return void 0;
  if (normalizeComparableText(summary) === normalizeComparableText(title)) {
    return void 0;
  }
  return summary;
}
function sanitizeAgentName(value) {
  if (typeof value !== "string") return void 0;
  const agentName = value.replace(/^\((.*)\)$/, "$1").replace(/\s+/g, " ").trim();
  return agentName || void 0;
}
function resolveElapsedMs(child, nowMs) {
  const startedMs = Date.parse(child.startedAt);
  if (Number.isNaN(startedMs)) return 0;
  const endSource = child.endedAt ?? child.updatedAt;
  const endMs = child.endedAt ? Date.parse(endSource) : nowMs;
  if (Number.isNaN(endMs)) return 0;
  return Math.max(0, endMs - startedMs);
}
function terminalReferenceMs(child) {
  const parsed = Date.parse(
    child.endedAt ?? child.updatedAt ?? child.startedAt
  );
  return Number.isNaN(parsed) ? 0 : parsed;
}
function pruneTerminalChildren(state, now = /* @__PURE__ */ new Date()) {
  const nowMs = now.getTime();
  const terminalChildren = [];
  let pruned = 0;
  for (const child of Object.values(state.children)) {
    if (child.status === "running") continue;
    const referenceMs = terminalReferenceMs(child);
    if (nowMs - referenceMs > TERMINAL_CHILD_TTL_MS) {
      delete state.children[child.id];
      pruned += 1;
      continue;
    }
    terminalChildren.push({ id: child.id, referenceMs });
  }
  if (terminalChildren.length <= MAX_TERMINAL_CHILDREN) {
    return pruned;
  }
  terminalChildren.sort(
    (a, b) => b.referenceMs - a.referenceMs || a.id.localeCompare(b.id)
  );
  for (const child of terminalChildren.slice(MAX_TERMINAL_CHILDREN)) {
    delete state.children[child.id];
    pruned += 1;
  }
  return pruned;
}
function refreshDerivedFields(state, now = /* @__PURE__ */ new Date()) {
  const nowISO = now.toISOString();
  const nowMs = now.getTime();
  normalizeExecutionCounters(state);
  for (const [id, child] of Object.entries(state.children)) {
    const startedAt = safeTimestamp(child.startedAt, nowISO);
    const updatedAt = safeTimestamp(child.updatedAt, nowISO);
    const endedAt = child.endedAt ? safeTimestamp(child.endedAt, updatedAt) : void 0;
    const status = child.status === "done" || child.status === "error" || child.status === "running" ? child.status : "running";
    const targetSessionID = sanitizeTargetSessionID(
      child.targetSessionID,
      id.startsWith("ses_") ? id : void 0
    );
    state.children[id] = {
      ...child,
      startedAt,
      updatedAt,
      endedAt,
      status,
      targetSessionID,
      color: statusColor(status),
      tokens: sanitizeTokens(child.tokens),
      model: sanitizeModel(child.model),
      elapsedMs: resolveElapsedMs(
        {
          ...child,
          startedAt,
          updatedAt,
          endedAt,
          status,
          color: statusColor(status)
        },
        nowMs
      )
    };
  }
  reconcileCountedExecutionsWithChildren(state);
  state.updatedAt = safeTimestamp(state.updatedAt, nowISO);
  if (pruneTerminalChildren(state, now) > 0) {
    reconcileCountedExecutionsWithChildren(state);
    state.updatedAt = nowISO;
  }
}
var STATUS_DIRNAME = "opencode-subagent-statusline";
var STATUS_FILENAME = "state.json";
var STATUS_DIR_MODE = 448;
var STATUS_FILE_MODE = 384;
function sanitizeInstanceName(input) {
  return input.replace(/[^A-Za-z0-9._-]/g, "_");
}
function resolveDefaultInstanceName() {
  const fromEnv = process.env.OPENCODE_SUBAGENT_STATUSLINE_INSTANCE;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    const safe = sanitizeInstanceName(fromEnv);
    if (safe.length > 0) {
      return safe;
    }
  }
  return `pid-${process.pid}`;
}
function createEmptyState() {
  return {
    children: {},
    countedChildIDs: {},
    totalExecuted: 0,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function resolveStatePath() {
  const fromEnv = process.env.OPENCODE_SUBAGENT_STATUSLINE_STATE;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv;
  }
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? os.tmpdir();
  const instance = resolveDefaultInstanceName();
  return join(runtimeDir, STATUS_DIRNAME, instance, STATUS_FILENAME);
}
function resolveTextPath(statePath) {
  return join(dirname(statePath), "status.txt");
}
async function writeLocalStatusFile(path, contents) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: STATUS_DIR_MODE });
  const tempPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  );
  try {
    await writeFile(tempPath, contents, {
      encoding: "utf8",
      mode: STATUS_FILE_MODE
    });
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => void 0);
    throw error;
  }
}
async function saveStatusText(textPath, contents) {
  await writeLocalStatusFile(textPath, contents);
}
async function saveState(statePath, state) {
  refreshDerivedFields(state);
  await writeLocalStatusFile(statePath, JSON.stringify(state, null, 2));
}
function upsertRunningChild(state, input) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const observedUpdatedAt = safeTimestamp(input.updatedAt, now);
  const observedStartedAt = safeTimestamp(input.startedAt, observedUpdatedAt);
  const existing = state.children[input.id];
  const targetSessionID = sanitizeTargetSessionID(
    input.targetSessionID ?? existing?.targetSessionID,
    input.id.startsWith("ses_") ? input.id : void 0
  );
  const source = input.source ?? existing?.source ?? "session";
  const counted = existing ? false : countChildExecution(state, {
    id: input.id,
    title: input.title,
    parentID: input.parentID,
    messageID: input.messageID,
    source,
    targetSessionID
  });
  const shouldKeepCompletedTiming = existing?.status === "done" || existing?.status === "error";
  const next = {
    id: input.id,
    title: input.title,
    summary: sanitizeSummary(input.summary, input.title) ?? sanitizeSummary(existing?.summary, input.title),
    agentName: sanitizeAgentName(input.agentName) ?? existing?.agentName,
    parentID: input.parentID,
    messageID: input.messageID ?? existing?.messageID,
    source,
    toolName: input.toolName ?? existing?.toolName,
    targetSessionID,
    status: shouldKeepCompletedTiming ? existing.status : "running",
    color: statusColor(shouldKeepCompletedTiming ? existing.status : "running"),
    startedAt: existing?.startedAt ?? observedStartedAt,
    updatedAt: observedUpdatedAt,
    endedAt: shouldKeepCompletedTiming ? existing.endedAt : void 0,
    elapsedMs: existing?.elapsedMs,
    tokens: existing?.tokens,
    model: existing?.model
  };
  if (existing && next.title === existing.title && next.summary === existing.summary && next.agentName === existing.agentName && next.parentID === existing.parentID && next.messageID === existing.messageID && next.source === existing.source && next.toolName === existing.toolName && next.targetSessionID === existing.targetSessionID && next.status === existing.status && next.color === existing.color && next.startedAt === existing.startedAt && next.endedAt === existing.endedAt && sameTokens(next.tokens, existing.tokens) && JSON.stringify(next.model) === JSON.stringify(existing.model)) {
    return counted;
  }
  state.children[input.id] = next;
  state.updatedAt = observedUpdatedAt;
  return true;
}
function markChildStatus(state, childID, status, endedAt) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  let changed = false;
  let stateUpdatedAt = state.updatedAt;
  for (const child of Object.values(state.children)) {
    if (child.id !== childID && child.targetSessionID !== childID) continue;
    const observedEndedAt = endedAt ? safeTimestamp(endedAt, now) : child.endedAt ?? now;
    if (child.status === status && child.color === statusColor(status) && child.updatedAt === observedEndedAt && child.endedAt === observedEndedAt) {
      continue;
    }
    const nextChild = {
      ...child,
      status,
      color: statusColor(status),
      updatedAt: observedEndedAt,
      endedAt: observedEndedAt
    };
    state.children[child.id] = {
      ...nextChild,
      elapsedMs: resolveElapsedMs(nextChild, Date.now())
    };
    stateUpdatedAt = observedEndedAt;
    changed = true;
  }
  if (changed) {
    state.updatedAt = stateUpdatedAt;
  }
  return changed;
}
function upsertChildDetails(state, childID, input) {
  const existing = state.children[childID];
  if (!existing) return false;
  const nextTitle = typeof input.title === "string" && input.title.trim().length > 0 ? input.title : existing.title;
  const nextSummary = sanitizeSummary(input.summary, nextTitle) ?? sanitizeSummary(existing.summary, nextTitle);
  const nextAgentName = sanitizeAgentName(input.agentName) ?? existing.agentName;
  const mergedTokens = mergeTokens(existing.tokens, input.tokens);
  const nextTargetSessionID = sanitizeTargetSessionID(
    input.targetSessionID ?? existing.targetSessionID,
    existing.id.startsWith("ses_") ? existing.id : void 0
  );
  const detailsChanged = nextTitle !== existing.title || nextSummary !== existing.summary || nextAgentName !== existing.agentName || !sameTokens(mergedTokens, existing.tokens) || nextTargetSessionID !== existing.targetSessionID;
  if (!detailsChanged) return false;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const observedUpdatedAt = safeTimestamp(input.updatedAt, now);
  const next = {
    ...existing,
    title: nextTitle,
    summary: nextSummary,
    agentName: nextAgentName,
    tokens: mergedTokens,
    targetSessionID: nextTargetSessionID,
    updatedAt: observedUpdatedAt
  };
  state.children[childID] = next;
  state.updatedAt = observedUpdatedAt;
  return true;
}
function setChildModel(state, sessionID, model, updatedAt) {
  const matches = Object.values(state.children).filter(
    (child) => child.id === sessionID || child.targetSessionID === sessionID
  );
  if (matches.length === 0) return false;
  let changed = false;
  const observedUpdatedAt = safeTimestamp(updatedAt, (/* @__PURE__ */ new Date()).toISOString());
  for (const child of matches) {
    const sanitized = sanitizeModel(model);
    if (JSON.stringify(child.model) === JSON.stringify(sanitized)) continue;
    state.children[child.id] = { ...child, model: sanitized };
    changed = true;
  }
  if (changed) state.updatedAt = observedUpdatedAt;
  return changed;
}

// src/events.ts
function asString2(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function normalizeMessage(value) {
  const message = isRecord(value) ? value : void 0;
  if (!message) return void 0;
  return isRecord(message.info) ? message.info : message;
}
function messageActivityMs(message) {
  const time = isRecord(message.time) ? message.time : void 0;
  const value = time?.completed ?? time?.updated ?? time?.created;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}
function extractLatestAssistantModel(input) {
  const values = Array.isArray(input) ? input : [input];
  const assistants = values.map((value, index) => ({ message: normalizeMessage(value), index })).filter(
    (entry) => entry.message?.role === "assistant"
  ).sort(
    (left, right) => messageActivityMs(left.message) - messageActivityMs(right.message) || left.index - right.index
  );
  const latest = assistants.at(-1)?.message;
  if (!latest) return void 0;
  const sessionID = asString2(latest.sessionID);
  if (!sessionID) return void 0;
  const providerID = asString2(latest.providerID)?.trim();
  const modelID = asString2(latest.modelID)?.trim();
  const variant = asString2(latest.variant)?.trim();
  const model = providerID && modelID ? { providerID, modelID, ...variant ? { variant } : {} } : void 0;
  const activity = messageActivityMs(latest);
  return {
    sessionID,
    model,
    updatedAt: activity > 0 ? new Date(activity).toISOString() : void 0
  };
}
function conciseText(value) {
  if (typeof value !== "string") return void 0;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return void 0;
  return text.length > 180 ? `${text.slice(0, 179)}\u2026` : text;
}
function sameDisplayText2(a, b) {
  if (!a || !b) return false;
  return a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();
}
function firstDistinctSummary(candidates, title) {
  for (const candidate of candidates) {
    const summary = conciseText(candidate);
    if (summary && !sameDisplayText2(summary, title)) return summary;
  }
  return void 0;
}
function isTechnicalDelegationTitle(value) {
  if (!value) return false;
  return /^delegation:\s+/i.test(value.trim());
}
function promptTitle(value) {
  const text = conciseText(value);
  if (!text) return void 0;
  const sentence = text.match(/^(.+?[.!?])\s/)?.[1]?.trim();
  const title = sentence && sentence.length <= 100 ? sentence : text;
  return title.length > 100 ? `${title.slice(0, 99)}\u2026` : title;
}
function firstUsefulTitle(candidates) {
  for (const candidate of candidates) {
    const title = promptTitle(candidate);
    if (title && !isTechnicalDelegationTitle(title)) return title;
  }
  return void 0;
}
function extractCreatedChild(event) {
  const info = event.properties?.info;
  const parentID = asString2(info?.parentID);
  if (!parentID) return null;
  const id = asString2(info?.id) ?? asString2(event.properties?.id);
  if (!id) return null;
  const title = asString2(info?.title) ?? "subagent";
  const agentName = asString2(info?.agent) ?? asString2(info?.subagent_type);
  const startedAt = extractEventTimestamp(event, [
    "started",
    "start",
    "created",
    "updated"
  ]);
  const updatedAt = extractEventTimestamp(event, ["updated", "created", "started", "start"]) ?? startedAt;
  return { id, title, agentName, parentID, startedAt, updatedAt };
}
function extractSessionID(event) {
  return asString2(event.properties?.sessionID) ?? asString2(event.properties?.sessionId) ?? asString2(event.properties?.info?.sessionID) ?? asString2(event.properties?.info?.sessionId) ?? asString2(event.sessionID) ?? asString2(event.sessionId) ?? asString2(event.properties?.info?.id) ?? asString2(event.properties?.id);
}
function isRecord(value) {
  return !!value && typeof value === "object";
}
function isSessionID(value) {
  return typeof value === "string" && value.startsWith("ses_");
}
function collectSessionIDs(input, target, depth = 0) {
  if (depth > 4 || !input) return;
  if (isSessionID(input)) {
    target.add(input);
    return;
  }
  if (!isRecord(input) && !Array.isArray(input)) return;
  if (Array.isArray(input)) {
    for (const value of input) {
      collectSessionIDs(value, target, depth + 1);
    }
    return;
  }
  for (const [key, value] of Object.entries(input)) {
    if (!key.toLowerCase().includes("session")) continue;
    collectSessionIDs(value, target, depth + 1);
  }
}
function resolveSyntheticTargetSessionID(state, synthetic, explicitCandidates = []) {
  const candidates = new Set(explicitCandidates.filter(isSessionID));
  const byMessage = Object.values(state.children).filter(
    (child) => child.id.startsWith("ses_") && child.parentID === synthetic.parentID && child.messageID && synthetic.messageID && child.messageID === synthetic.messageID
  );
  if (byMessage.length === 1) {
    candidates.add(byMessage[0].id);
  }
  const byParent = Object.values(state.children).filter(
    (child) => child.id.startsWith("ses_") && child.parentID === synthetic.parentID
  );
  if (byParent.length === 1) {
    candidates.add(byParent[0].id);
  }
  if (candidates.size !== 1) return void 0;
  return [...candidates][0];
}
function extractPartTargetSessionCandidates(event) {
  const part = isRecord(event.properties?.part) ? event.properties.part : void 0;
  if (!part) return [];
  const candidates = /* @__PURE__ */ new Set();
  collectSessionIDs(part, candidates);
  const parentSessionID = asString2(part.sessionID) ?? extractSessionID(event);
  if (parentSessionID) candidates.delete(parentSessionID);
  return [...candidates];
}
function parseTaskSessionIDFromOutput2(value, parentSessionID) {
  if (typeof value !== "string") return void 0;
  const matches = [...value.matchAll(/\b(?:task_id\s*:\s*)?(ses_[a-zA-Z0-9_-]+)\b/gi)];
  const candidates = new Set(matches.map((match) => match[1]));
  if (parentSessionID) candidates.delete(parentSessionID);
  return candidates.size === 1 ? [...candidates][0] : void 0;
}
function backfillSyntheticTargetsForSession(state, session) {
  const targetlessSynthetic = Object.values(state.children).filter(
    (child) => (child.source === "tool" || child.source === "subtask") && !child.targetSessionID && child.parentID === session.parentID
  );
  const messageMatches = session.messageID ? targetlessSynthetic.filter(
    (child) => child.messageID === session.messageID
  ) : [];
  const existingSessionSiblings = Object.values(state.children).filter(
    (child) => child.id !== session.id && (child.source === "session" || child.id.startsWith("ses_")) && child.parentID === session.parentID
  );
  const candidates = messageMatches.length > 0 ? messageMatches : targetlessSynthetic;
  if (candidates.length !== 1) return false;
  if (messageMatches.length === 0 && existingSessionSiblings.length > 0) {
    return false;
  }
  const synthetic = candidates[0];
  const targetSessionID = resolveSyntheticTargetSessionID(
    state,
    {
      id: synthetic.id,
      parentID: synthetic.parentID,
      messageID: synthetic.messageID
    },
    [session.id]
  );
  if (targetSessionID !== session.id) return false;
  return upsertChildDetails(state, synthetic.id, {
    targetSessionID,
    updatedAt: session.updatedAt
  });
}
function extractTaskToolEvidence(event) {
  const part = event.properties?.part;
  if (!isRecord(part) || part.type !== "tool") return null;
  if (asString2(part.tool) !== "task") return null;
  const state = isRecord(part.state) ? part.state : void 0;
  if (!state) return null;
  const rawStatus = asString2(state.status);
  const status = rawStatus === "completed" ? "done" : rawStatus === "error" ? "error" : "running";
  const metadata = isRecord(state.metadata) ? state.metadata : void 0;
  const targetFromMetadata = asString2(metadata?.sessionId);
  const parentSessionID = asString2(part.sessionID) ?? extractSessionID(event);
  const targetFromOutput = parseTaskSessionIDFromOutput2(
    state.output,
    parentSessionID
  );
  const targetCandidates = extractPartTargetSessionCandidates(event);
  const targetSessionID = targetFromMetadata ?? targetFromOutput ?? (targetCandidates.length === 1 ? targetCandidates[0] : void 0);
  const endedAt = status === "done" || status === "error" ? extractEventTimestamp(event, ["completed", "end", "ended", "updated"]) : void 0;
  return {
    status,
    targetSessionID,
    endedAt
  };
}
function mapTaskToolToSubtaskID(state, task) {
  const runningSubtasks = Object.values(state.children).filter(
    (child) => child.source === "subtask" && child.status === "running" && child.parentID === task.parentID
  );
  const primaryCandidates = runningSubtasks.filter(
    (child) => child.messageID === task.messageID
  );
  const legacyCandidates = task.parentMessageID ? runningSubtasks.filter(
    (child) => child.messageID === task.parentMessageID
  ) : [];
  const candidates = primaryCandidates.length > 0 ? primaryCandidates : legacyCandidates;
  if (candidates.length === 0) return void 0;
  if (task.targetSessionID) {
    const byTarget = candidates.filter(
      (child) => child.targetSessionID === task.targetSessionID
    );
    if (byTarget.length === 1) return byTarget[0].id;
  }
  const byTitle = candidates.filter(
    (child) => sameDisplayText2(child.title, task.title)
  );
  if (byTitle.length === 1) return byTitle[0].id;
  const bySummary = candidates.filter(
    (child) => sameDisplayText2(child.summary, task.summary)
  );
  if (bySummary.length === 1) return bySummary[0].id;
  const byAgent = task.agentName ? candidates.filter(
    (child) => sameDisplayText2(child.agentName, task.agentName)
  ) : [];
  if (byAgent.length === 1) return byAgent[0].id;
  if (candidates.length === 1) return candidates[0].id;
  return void 0;
}
function extractParentMessageID(event) {
  return asString2(event.properties?.info?.parentID) ?? asString2(event.properties?.parentID) ?? asString2(event.parentID);
}
function toIsoTimestamp(value) {
  if (typeof value === "string") {
    if (value.trim().length === 0) return void 0;
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) return void 0;
    return new Date(parsed).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0) return void 0;
    const millis = value < 1e10 ? value * 1e3 : value;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? void 0 : parsed.toISOString();
  }
  return void 0;
}
function extractEventTimestamp(event, keys) {
  const part = isRecord(event.properties?.part) ? event.properties?.part : void 0;
  const state = isRecord(part?.state) ? part?.state : void 0;
  const sources = [
    isRecord(event.properties?.info?.time) ? event.properties?.info?.time : void 0,
    isRecord(part?.time) ? part?.time : void 0,
    isRecord(part?.timestamps) ? part?.timestamps : void 0,
    isRecord(state?.time) ? state?.time : void 0,
    isRecord(state?.timestamps) ? state?.timestamps : void 0,
    state,
    part
  ];
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      const candidate = toIsoTimestamp(source[key]);
      if (candidate) return candidate;
    }
  }
  return void 0;
}
function extractSubtaskChild(event) {
  const part = event.properties?.part;
  if (!isRecord(part) || part.type !== "subtask") return null;
  const partID = asString2(part.id);
  const parentID = asString2(part.sessionID) ?? extractSessionID(event);
  const messageID = asString2(part.messageID);
  if (!partID || !parentID || !messageID) return null;
  const description = asString2(part.description);
  const command = asString2(part.command);
  const agent = asString2(part.agent);
  const title = description || command || agent || "subtask";
  const state = isRecord(part.state) ? part.state : void 0;
  const input = isRecord(state?.input) ? state.input : void 0;
  const summary = firstDistinctSummary(
    [input?.prompt, input?.description, part.description, state?.description],
    title
  );
  const startedAt = extractEventTimestamp(event, [
    "started",
    "start",
    "created",
    "updated"
  ]);
  const updatedAt = extractEventTimestamp(event, ["updated", "created", "started", "start"]) ?? startedAt;
  const targetCandidates = extractPartTargetSessionCandidates(event);
  const targetSessionID = targetCandidates.length === 1 ? targetCandidates[0] : void 0;
  return {
    id: `subtask:${partID}`,
    title,
    summary,
    agentName: agent,
    parentID,
    messageID,
    targetSessionID,
    startedAt,
    updatedAt
  };
}
function extractToolChild(event) {
  const part = event.properties?.part;
  if (!isRecord(part) || part.type !== "tool") return null;
  const tool = asString2(part.tool);
  if (tool !== "delegate" && tool !== "task") return null;
  const partID = asString2(part.id);
  const parentID = asString2(part.sessionID) ?? extractSessionID(event);
  const messageID = asString2(part.messageID);
  const state = isRecord(part.state) ? part.state : void 0;
  if (!partID || !parentID || !messageID || !state) return null;
  const taskEvidence = extractTaskToolEvidence(event);
  const rawStatus = asString2(state.status);
  const status = taskEvidence?.status ?? (rawStatus === "completed" ? "done" : rawStatus === "error" ? "error" : "running");
  const input = isRecord(state.input) ? state.input : {};
  const description = asString2(input.description);
  const subagentType = asString2(input.subagent_type);
  const rawTitle = asString2(state.title);
  const title = (isTechnicalDelegationTitle(rawTitle) ? void 0 : rawTitle) || description || firstUsefulTitle([input.prompt, part.description, state.description]) || subagentType || tool;
  const summary = firstDistinctSummary(
    [input.prompt, input.description, part.description, state.description],
    title
  );
  const startedAt = extractEventTimestamp(event, [
    "started",
    "start",
    "created",
    "updated"
  ]);
  const updatedAt = extractEventTimestamp(event, [
    "updated",
    "completed",
    "created",
    "started",
    "start"
  ]) ?? startedAt;
  const endedAt = status === "done" || status === "error" ? extractEventTimestamp(event, ["completed", "end", "ended", "updated"]) : void 0;
  const targetCandidates = extractPartTargetSessionCandidates(event);
  const targetSessionID = taskEvidence?.targetSessionID ?? (targetCandidates.length === 1 ? targetCandidates[0] : void 0);
  return {
    id: `tool:${partID}`,
    title,
    summary,
    agentName: subagentType,
    parentID,
    messageID,
    toolName: tool,
    targetSessionID,
    status,
    startedAt,
    updatedAt,
    endedAt
  };
}
function extractCompletedAssistantMessage(event) {
  const info = event.properties?.info;
  if (!isRecord(info)) return null;
  if (info.role !== "assistant") return null;
  const time = info.time;
  if (!isRecord(time) || typeof time.completed !== "number") return null;
  const sessionID = asString2(info.sessionID) ?? extractSessionID(event);
  const messageID = asString2(info.id);
  if (!sessionID || !messageID) return null;
  return { sessionID, messageID };
}
function extractDetailTargetIDs(event) {
  const ids = /* @__PURE__ */ new Set();
  const part = event.properties?.part;
  if (isRecord(part)) {
    const partID = asString2(part.id);
    if (part.type === "subtask" && partID) {
      ids.add(`subtask:${partID}`);
    }
    if (part.type === "tool") {
      const tool = asString2(part.tool);
      if ((tool === "delegate" || tool === "task") && partID) {
        ids.add(`tool:${partID}`);
      }
    }
  }
  const sessionID = extractSessionID(event);
  if (sessionID) ids.add(sessionID);
  return [...ids];
}
function normalizePercent(value) {
  if (value > 0 && value <= 1) {
    return value * 100;
  }
  return value;
}
function extractChildDetails(event) {
  const details = {};
  details.updatedAt = extractEventTimestamp(event, [
    "updated",
    "completed",
    "created",
    "started",
    "start"
  ]);
  const titleCandidates = [
    event.properties?.info?.title,
    event.properties?.title,
    event.properties?.info?.name,
    event.properties?.name,
    event.title,
    event.name
  ];
  for (const candidate of titleCandidates) {
    const title = asString2(candidate);
    if (title) {
      details.title = title;
      break;
    }
  }
  const part = isRecord(event.properties?.part) ? event.properties.part : void 0;
  const partState = isRecord(part?.state) ? part.state : void 0;
  const partInput = isRecord(partState?.input) ? partState.input : void 0;
  details.agentName = asString2(partInput?.subagent_type) ?? asString2(partInput?.agent) ?? asString2(part?.agent) ?? asString2(event.properties?.info?.agent) ?? asString2(event.properties?.info?.subagent_type);
  details.summary = firstDistinctSummary(
    [
      partInput?.prompt,
      partInput?.description,
      part?.description,
      partState?.description
    ],
    details.title
  );
  if (isTechnicalDelegationTitle(details.title)) {
    const replacementTitle = asString2(partInput?.description) ?? firstUsefulTitle([
      partInput?.prompt,
      part?.description,
      partState?.description
    ]);
    if (replacementTitle) {
      details.title = replacementTitle;
    }
  }
  const tokenHints = {};
  const visited = /* @__PURE__ */ new Set();
  const walk = (node, depth) => {
    if (!isRecord(node) || depth > 6) return;
    if (visited.has(node)) return;
    visited.add(node);
    for (const [rawKey, rawValue] of Object.entries(node)) {
      const key = rawKey.toLowerCase();
      const asNumber = typeof rawValue === "number" ? rawValue : typeof rawValue === "string" && rawValue.trim().length > 0 ? Number(rawValue) : void 0;
      if (typeof asNumber === "number" && Number.isFinite(asNumber)) {
        if (key.includes("context") && key.includes("percent")) {
          tokenHints.contextPercent = normalizePercent(asNumber);
        } else if (key.includes("context") && key.includes("usage")) {
          tokenHints.contextPercent = normalizePercent(asNumber);
        } else if ((key.includes("input") || key.includes("prompt")) && key.includes("token")) {
          tokenHints.input = asNumber;
        } else if ((key.includes("output") || key.includes("completion")) && key.includes("token")) {
          tokenHints.output = asNumber;
        } else if (key.includes("total") && key.includes("token")) {
          tokenHints.total = asNumber;
        } else if (key === "tokens" || key === "token") {
          tokenHints.total = asNumber;
        }
      }
      if (isRecord(rawValue)) {
        walk(rawValue, depth + 1);
      }
    }
  };
  walk(event, 0);
  if (tokenHints.input !== void 0 || tokenHints.output !== void 0 || tokenHints.total !== void 0 || tokenHints.contextPercent !== void 0) {
    details.tokens = tokenHints;
  }
  return details;
}
function applySubagentEvent(state, event) {
  const e = event ?? {};
  const type = asString2(e.type);
  if (!type) return false;
  if (type === "session.created" || type === "session.updated") {
    const child = extractCreatedChild(e);
    if (child) {
      const details = extractChildDetails(e);
      let changed2 = upsertRunningChild(state, {
        ...child,
        source: "session",
        targetSessionID: child.id
      });
      changed2 = upsertChildDetails(state, child.id, details) || changed2;
      changed2 = backfillSyntheticTargetsForSession(state, {
        id: child.id,
        parentID: child.parentID,
        updatedAt: child.updatedAt
      }) || changed2;
      const sessionStatusFromUpdate = type === "session.updated" ? hasStructuredErrorEvidence(e.properties ?? e) ? "error" : deriveOpenCodeSessionStatus(
        e.properties?.status ?? e.properties?.state ?? e.properties?.info?.status ?? e.status ?? e.state
      ) : void 0;
      if (sessionStatusFromUpdate === "done" || sessionStatusFromUpdate === "error") {
        const endedAt = extractEventTimestamp(e, [
          "completed",
          "end",
          "ended",
          "updated"
        ]);
        changed2 = markChildStatus(state, child.id, sessionStatusFromUpdate, endedAt) || changed2;
      }
      return changed2;
    }
    return false;
  }
  if (type === "session.idle") {
    const childID = extractSessionID(e);
    if (!childID) return false;
    const endedAt = extractEventTimestamp(e, [
      "completed",
      "end",
      "ended",
      "updated"
    ]);
    const details = extractChildDetails(e);
    const status = deriveOpenCodeSessionStatus(e.properties ?? e) === "error" || hasStructuredErrorEvidence(e.properties ?? e) ? "error" : "done";
    let changed2 = markChildStatus(state, childID, status, endedAt);
    changed2 = upsertChildDetails(state, childID, details) || changed2;
    return changed2;
  }
  if (type === "session.error") {
    const childID = extractSessionID(e);
    if (!childID) return false;
    const endedAt = extractEventTimestamp(e, [
      "completed",
      "end",
      "ended",
      "updated"
    ]);
    const details = extractChildDetails(e);
    let changed2 = markChildStatus(state, childID, "error", endedAt);
    changed2 = upsertChildDetails(state, childID, details) || changed2;
    return changed2;
  }
  if (type === "session.status") {
    const childID = extractSessionID(e);
    if (!childID) return false;
    const status = hasStructuredErrorEvidence(e.properties ?? e) ? "error" : deriveOpenCodeSessionStatus(
      e.properties?.status ?? e.properties?.state ?? e.properties?.info?.status ?? e.status ?? e.state ?? e.properties
    );
    if (!status) return false;
    const endedAt = status === "done" || status === "error" ? extractEventTimestamp(e, ["completed", "end", "ended", "updated"]) : void 0;
    const details = extractChildDetails(e);
    let changed2 = status === "running" ? false : markChildStatus(state, childID, status, endedAt);
    changed2 = upsertChildDetails(state, childID, details) || changed2;
    return changed2;
  }
  let changed = false;
  if (type === "message.part.updated") {
    const subtask = extractSubtaskChild(e);
    if (subtask) {
      const targetSessionID = resolveSyntheticTargetSessionID(
        state,
        {
          id: subtask.id,
          parentID: subtask.parentID,
          messageID: subtask.messageID
        },
        subtask.targetSessionID ? [subtask.targetSessionID] : []
      );
      changed = upsertRunningChild(state, {
        ...subtask,
        source: "subtask",
        targetSessionID,
        startedAt: subtask.startedAt,
        updatedAt: subtask.updatedAt
      }) || changed;
    }
    const tool = extractToolChild(e);
    if (tool) {
      const targetSessionID = resolveSyntheticTargetSessionID(
        state,
        {
          id: tool.id,
          parentID: tool.parentID,
          messageID: tool.messageID
        },
        tool.targetSessionID ? [tool.targetSessionID] : []
      );
      const childChanged = upsertRunningChild(state, {
        ...tool,
        source: "tool",
        targetSessionID,
        startedAt: tool.startedAt,
        updatedAt: tool.updatedAt
      });
      changed = childChanged || changed;
      if (tool.status === "done" || tool.status === "error") {
        changed = markChildStatus(
          state,
          tool.id,
          tool.status,
          tool.endedAt ?? tool.updatedAt
        ) || changed;
        if (asString2(
          e.properties?.part?.tool
        ) === "task") {
          const subtaskID = mapTaskToolToSubtaskID(state, {
            parentID: tool.parentID,
            messageID: tool.messageID,
            parentMessageID: extractParentMessageID(e),
            title: tool.title,
            summary: tool.summary,
            agentName: tool.agentName,
            targetSessionID
          });
          if (subtaskID) {
            if (targetSessionID) {
              changed = upsertChildDetails(state, subtaskID, {
                targetSessionID,
                updatedAt: tool.updatedAt
              }) || changed;
            }
            changed = markChildStatus(
              state,
              subtaskID,
              tool.status,
              tool.endedAt ?? tool.updatedAt
            ) || changed;
          }
        }
      }
    }
  }
  if (type === "message.updated") {
    const assistantModel = extractLatestAssistantModel(e.properties?.info ?? e);
    if (assistantModel) {
      changed = setChildModel(
        state,
        assistantModel.sessionID,
        assistantModel.model,
        assistantModel.updatedAt
      ) || changed;
    }
    const completed = extractCompletedAssistantMessage(e);
    if (completed) {
      for (const child of Object.values(state.children)) {
        if (child.source === "subtask" && child.status === "running" && child.parentID === completed.sessionID && child.messageID === completed.messageID) {
          changed = markChildStatus(state, child.id, "done") || changed;
        }
      }
    }
  }
  if (type === "message.updated" || type === "message.part.updated") {
    const details = extractChildDetails(e);
    for (const childID of extractDetailTargetIDs(e)) {
      if (state.children[childID]) {
        changed = upsertChildDetails(state, childID, details) || changed;
      }
    }
  }
  return changed;
}

// src/logs.ts
import { readFileSync, statSync } from "fs";
var MAX_SYNC_LOG_READ_BYTES = 1024 * 1024;
function safeRead(reader) {
  try {
    return reader();
  } catch {
    return void 0;
  }
}
function readOpenCodeLogFileIfSmall(path) {
  const stats = safeRead(() => statSync(path));
  if (!stats?.isFile() || stats.size > MAX_SYNC_LOG_READ_BYTES) {
    return void 0;
  }
  return safeRead(() => readFileSync(path, "utf8"));
}

// src/render.ts
var ansi = {
  reset: "\x1B[0m",
  gray: "\x1B[90m",
  green: "\x1B[32m",
  yellow: "\x1B[33m",
  red: "\x1B[31m"
};
function colorsEnabled() {
  if (process.env.NO_COLOR) return false;
  const fromEnv = process.env.OPENCODE_SUBAGENT_STATUSLINE_COLOR;
  if (fromEnv === "0") return false;
  return true;
}
function paint(text, color, enabled) {
  if (!enabled) return text;
  return `${color}${text}${ansi.reset}`;
}
function formatDuration(elapsedMs2) {
  const totalSeconds = Math.max(0, Math.floor((elapsedMs2 ?? 0) / 1e3));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
function formatNumber(value) {
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}
function resolveTokenTotal(child) {
  const total = child.tokens?.total;
  if (typeof total === "number" && Number.isFinite(total)) {
    return total;
  }
  const inTokens = child.tokens?.input;
  const outTokens = child.tokens?.output;
  if (typeof inTokens === "number" || typeof outTokens === "number") {
    return (inTokens ?? 0) + (outTokens ?? 0);
  }
  return void 0;
}
function formatPercentUsed(percent) {
  const rounded = Math.round(percent * 10) / 10;
  if (Math.abs(rounded - Math.round(rounded)) < 0.05) {
    return `${Math.round(rounded)}% used`;
  }
  return `${rounded.toFixed(1)}% used`;
}
function formatTokenCount(total) {
  const label = total === 1 ? "token" : "tokens";
  return `${formatNumber(total)} ${label}`;
}
function formatContextDetails(child) {
  const total = resolveTokenTotal(child);
  const percent = child.tokens?.contextPercent;
  const hasPercent = typeof percent === "number" && Number.isFinite(percent);
  const hasTotal = typeof total === "number" && Number.isFinite(total);
  if (hasTotal && hasPercent) {
    return `${formatTokenCount(total)} \xB7 ${formatPercentUsed(percent)}`;
  }
  if (hasTotal) {
    return formatTokenCount(total);
  }
  if (hasPercent) {
    return formatPercentUsed(percent);
  }
  return void 0;
}
function formatContext(child) {
  const details = formatContextDetails(child);
  if (!details) return "";
  return `ctx ${details}`;
}
function childColor(child) {
  if (child.color === "green") return ansi.green;
  if (child.color === "red") return ansi.red;
  return ansi.yellow;
}
function byPriority(a, b) {
  const startedDiff = b.startedAt.localeCompare(a.startedAt);
  if (startedDiff !== 0) return startedDiff;
  return a.id.localeCompare(b.id);
}
var RECENT_TERMINAL_VISIBLE_MS = 10 * 60 * 1e3;
function collapseSubagentWorkItems(children) {
  return correlateSubagentWorkItems(children).map(
    ({ real, proxies }) => proxies.reduce(
      (current, proxy) => mergeProxyMetadataWithRealExecution(current, proxy),
      real
    )
  );
}
function isTerminalWorkItem(child) {
  return child.status === "done" || child.status === "error";
}
function isVisibleWorkItem(child, nowMs = Date.now()) {
  if (!isTerminalWorkItem(child)) return true;
  const endedMs = Date.parse(child.endedAt ?? child.updatedAt);
  if (Number.isNaN(endedMs)) return false;
  return nowMs - endedMs <= RECENT_TERMINAL_VISIBLE_MS;
}
function visibleSubagentWorkItems(children, nowMs = Date.now(), options = {}) {
  const collapsed = collapseSubagentWorkItems(children);
  if (options.showCompletedHistory) return collapsed;
  const visible = collapsed.filter((child) => isVisibleWorkItem(child, nowMs));
  const hasRunning = visible.some((child) => child.status === "running");
  const activeMessageIDs = new Set(
    visible.filter((child) => child.status === "running" && child.messageID).map((child) => child.messageID)
  );
  if (!hasRunning) return visible;
  return visible.filter((child) => {
    if (child.status === "running") return true;
    if (!child.messageID) return false;
    return activeMessageIDs.has(child.messageID);
  });
}
function renderStatusLine(state) {
  const children = visibleSubagentWorkItems(Object.values(state.children)).sort(
    byPriority
  );
  const counts = countRetainedSubagentStatuses({ children: state.children });
  const totalExecuted = formatNumber(state.totalExecuted ?? 0);
  const colorOn = colorsEnabled();
  const aggregate = `\u21B3 ${counts.running} running \xB7 ${counts.done} done \xB7 ${counts.error} error \xB7 \u03A3 ${totalExecuted} total`;
  if (children.length === 0) return aggregate;
  const details = children.map((child) => {
    const context = formatContext(child);
    const label = [child.title, formatDuration(child.elapsedMs), context].filter((part) => part.length > 0).join(" ");
    return paint(label, childColor(child), colorOn);
  }).join(paint(" \xB7 ", ansi.gray, colorOn));
  return `${aggregate} \xB7 ${details}`;
}

// src/tui-focus.ts
function shouldReleaseSidebarListFocus(input) {
  return input.listFocusModeActive && (input.previousRunningCount ?? 0) > 0 && input.runningCount === 0;
}
function resolveSiblingSidebarRefocus(input) {
  const { pendingSidebarRefocus, routeSessionID, children } = input;
  if (!pendingSidebarRefocus || !routeSessionID || routeSessionID === pendingSidebarRefocus.parentSessionID || routeSessionID === pendingSidebarRefocus.childSessionID) {
    return void 0;
  }
  const sibling = Object.values(children).find(
    (child) => child.parentID === pendingSidebarRefocus.parentSessionID && child.targetSessionID === routeSessionID
  );
  if (!sibling) return void 0;
  return {
    childSessionID: routeSessionID,
    childRowID: sibling.id
  };
}
function resolveSidebarReturnFocusAction(input) {
  const { pendingSidebarRefocus, previousRouteSessionID, routeSessionID } = input;
  if (!pendingSidebarRefocus || previousRouteSessionID === routeSessionID) {
    return "none";
  }
  if (previousRouteSessionID === pendingSidebarRefocus.childSessionID && routeSessionID === pendingSidebarRefocus.parentSessionID) {
    return "focus-prompt";
  }
  if (routeSessionID !== pendingSidebarRefocus.childSessionID) {
    return "clear-pending";
  }
  return "none";
}
function focusPromptWithDeferredRetry(tryFocusPrompt, schedule = (callback) => {
  setTimeout(callback, 0);
}) {
  schedule(() => {
    if (tryFocusPrompt()) return;
    schedule(() => {
      void tryFocusPrompt();
    });
  });
}

// src/text-width.ts
var ELLIPSIS = "\u2026";
function isCombiningCodePoint(codePoint) {
  return codePoint >= 768 && codePoint <= 879 || codePoint >= 6832 && codePoint <= 6911 || codePoint >= 7616 && codePoint <= 7679 || codePoint >= 8400 && codePoint <= 8447 || codePoint >= 65024 && codePoint <= 65039 || codePoint >= 65056 && codePoint <= 65071;
}
function isWideCodePoint(codePoint) {
  return codePoint >= 4352 && (codePoint <= 4447 || codePoint === 9001 || codePoint === 9002 || codePoint >= 11904 && codePoint <= 42191 && codePoint !== 12351 || codePoint >= 44032 && codePoint <= 55203 || codePoint >= 63744 && codePoint <= 64255 || codePoint >= 65040 && codePoint <= 65049 || codePoint >= 65072 && codePoint <= 65135 || codePoint >= 65280 && codePoint <= 65376 || codePoint >= 65504 && codePoint <= 65510 || codePoint >= 127744 && codePoint <= 128591 || codePoint >= 128640 && codePoint <= 128767 || codePoint >= 131072 && codePoint <= 262141);
}
function characterWidth(character) {
  const codePoint = character.codePointAt(0);
  if (codePoint === void 0) return 0;
  if (codePoint === 0 || codePoint < 32 || codePoint >= 127 && codePoint < 160) {
    return 0;
  }
  if (codePoint === 8205 || isCombiningCodePoint(codePoint)) return 0;
  return isWideCodePoint(codePoint) ? 2 : 1;
}
function textColumns(value) {
  let columns = 0;
  for (const character of value) columns += characterWidth(character);
  return columns;
}
function takeColumns(value, maxColumns) {
  if (maxColumns <= 0) return "";
  let columns = 0;
  let result = "";
  for (const character of value) {
    const width = characterWidth(character);
    if (columns + width > maxColumns) break;
    columns += width;
    result += character;
  }
  return result;
}
function truncateToColumns(value, maxColumns) {
  if (maxColumns <= 0) return "";
  if (textColumns(value) <= maxColumns) return value;
  if (maxColumns <= textColumns(ELLIPSIS)) return ELLIPSIS;
  const prefix = takeColumns(
    value,
    maxColumns - textColumns(ELLIPSIS)
  ).trimEnd();
  return `${prefix}${ELLIPSIS}`;
}

// src/tui-commands.ts
var TOGGLE_SECTION_COMMAND = "subagent-statusline.toggle-sidebar-section";
var FOCUS_SIDEBAR_LIST_COMMAND = "subagent-statusline.focus-sidebar-list";
var TOGGLE_COMPLETED_HISTORY_COMMAND = "subagent-statusline.toggle-completed-history";
var COMMAND_CATEGORY = "Subagents";
var SHARED_COMMAND_METADATA = {
  toggle: {
    id: TOGGLE_SECTION_COMMAND,
    title: "Subagents: Toggle sidebar section",
    description: "Toggle the entire subagent sidebar section",
    category: COMMAND_CATEGORY
  },
  focus: {
    id: FOCUS_SIDEBAR_LIST_COMMAND,
    title: "Subagents: Focus sidebar list",
    description: "Focus the subagent sidebar list for keyboard navigation",
    category: COMMAND_CATEGORY
  },
  toggleCompletedHistory: {
    id: TOGGLE_COMPLETED_HISTORY_COMMAND,
    title: "Subagents: Toggle completed history",
    description: "Toggle retained completed rows in the subagent sidebar. Shortcut: c while the sidebar list is focused.",
    category: COMMAND_CATEGORY
  }
};
function createToggleSelectionTitle(sectionEnabled) {
  return sectionEnabled ? "Subagents: Disable sidebar section" : "Subagents: Enable sidebar section";
}
function createCompositeDispose(disposers) {
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
      }
    }
  };
}
function registerSubagentCommands({
  api,
  sectionEnabled,
  toggleSection,
  focusSidebarList,
  toggleCompletedHistory
}) {
  const disposers = [];
  if (api.keymap?.registerLayer) {
    disposers.push(
      api.keymap.registerLayer({
        commands: [
          {
            name: SHARED_COMMAND_METADATA.toggle.id,
            title: SHARED_COMMAND_METADATA.toggle.title,
            description: SHARED_COMMAND_METADATA.toggle.description,
            category: SHARED_COMMAND_METADATA.toggle.category,
            run: () => toggleSection(!sectionEnabled())
          },
          {
            name: SHARED_COMMAND_METADATA.focus.id,
            title: SHARED_COMMAND_METADATA.focus.title,
            description: SHARED_COMMAND_METADATA.focus.description,
            category: SHARED_COMMAND_METADATA.focus.category,
            run: focusSidebarList
          },
          {
            name: SHARED_COMMAND_METADATA.toggleCompletedHistory.id,
            title: SHARED_COMMAND_METADATA.toggleCompletedHistory.title,
            description: SHARED_COMMAND_METADATA.toggleCompletedHistory.description,
            category: SHARED_COMMAND_METADATA.toggleCompletedHistory.category,
            run: toggleCompletedHistory
          }
        ],
        bindings: [
          {
            key: "alt+b",
            cmd: SHARED_COMMAND_METADATA.focus.id
          }
        ]
      })
    );
  }
  if (api.command?.register) {
    disposers.push(
      api.command.register(() => [
        {
          title: createToggleSelectionTitle(sectionEnabled()),
          value: SHARED_COMMAND_METADATA.toggle.id,
          description: SHARED_COMMAND_METADATA.toggle.description,
          category: SHARED_COMMAND_METADATA.toggle.category,
          onSelect: () => toggleSection(!sectionEnabled())
        },
        {
          title: SHARED_COMMAND_METADATA.focus.title,
          value: SHARED_COMMAND_METADATA.focus.id,
          description: SHARED_COMMAND_METADATA.focus.description,
          category: SHARED_COMMAND_METADATA.focus.category,
          keybind: "alt+b",
          onSelect: focusSidebarList
        },
        {
          title: SHARED_COMMAND_METADATA.toggleCompletedHistory.title,
          value: SHARED_COMMAND_METADATA.toggleCompletedHistory.id,
          description: SHARED_COMMAND_METADATA.toggleCompletedHistory.description,
          category: SHARED_COMMAND_METADATA.toggleCompletedHistory.category,
          onSelect: toggleCompletedHistory
        }
      ])
    );
  }
  return createCompositeDispose(disposers);
}

// src/i18n.ts
var translations = {
  es: {
    subagents: "Subagentes"
  },
  en: {
    subagents: "Subagents"
  }
};
var _cachedLocale = null;
function detectSystemLocale() {
  const envLang = process.env.LANG ?? process.env.LC_ALL ?? process.env.LANGUAGE ?? Intl.DateTimeFormat().resolvedOptions().locale;
  const lang = envLang.toLowerCase();
  if (lang.startsWith("es")) return "es";
  return "en";
}
function getLocale() {
  if (_cachedLocale === null) {
    _cachedLocale = detectSystemLocale();
  }
  return _cachedLocale;
}
function t(key) {
  const locale = getLocale();
  const translation = translations[locale][key];
  if (translation === void 0) {
    const fallback = translations.en[key];
    if (fallback === void 0) {
      throw new Error(`Missing translation key: ${key}`);
    }
    return fallback;
  }
  return translation;
}

// src/tui.tsx
var TUI_PLUGIN_ID = "subagent-statusline.tui";
var ELAPSED_TICK_MS = 1e3;
var FALLBACK_SIDEBAR_WIDTH = 34;
var MIN_ROW_WIDTH = 24;
var MIN_LABEL_WIDTH = 8;
var DONE_TOKEN_REHYDRATE_THROTTLE_MS = 2e3;
var DONE_TOKEN_REHYDRATE_MAX_ATTEMPTS = 15;
var MAINTENANCE_TICK_MS = DONE_TOKEN_REHYDRATE_THROTTLE_MS;
var HYDRATE_RETRY_BASE_DELAY_MS = 1e3;
var HYDRATE_RETRY_MAX_DELAY_MS = 3e4;
var HYDRATE_RETRY_MAX_ATTEMPTS = 6;
var RUNNING_RECONCILE_MAINTENANCE_INTERVAL_MS = 10 * 6e4;
var RUNNING_RECONCILE_MAX_CANDIDATES = 8;
var RUNNING_RECONCILE_INITIAL_BACKOFF_MS = 15e3;
var RUNNING_RECONCILE_MAX_BACKOFF_MS = 5 * 6e4;
var RUNNING_RECONCILE_MESSAGE_AGE_GATE_MS = 6e4;
var RUNNING_RECONCILE_OLD_CANDIDATE_AGE_MS = 5 * 6e4;
var CLOCK_ICON = "\uF017";
var TOKEN_ICON = "\uF51E";
var SIDEBAR_ARROW_EXPANDED = "\u25BC";
var SIDEBAR_ARROW_COLLAPSED = "\u25B6";
var SUBAGENTS_EXPANDED_KV_KEY = "subagents.sidebar.expanded";
var SUBAGENTS_SECTION_ENABLED_KV_KEY = "subagents.sidebar.enabled";
var SUBAGENTS_MAX_VISIBLE_ROWS = 5;
var SUBAGENTS_RUNNING_ROW_HEIGHT = 3;
var SUBAGENTS_TERMINAL_ROW_HEIGHT = 2;
var SUBAGENTS_MODEL_ROW_HEIGHT = 1;
var SUBAGENTS_ROW_GAP = 0;
var SUBAGENTS_ROW_MARKER_WIDTH = 4;
var SUBAGENTS_MAX_LIST_HEIGHT = SUBAGENTS_MAX_VISIBLE_ROWS * (SUBAGENTS_RUNNING_ROW_HEIGHT + SUBAGENTS_MODEL_ROW_HEIGHT) + (SUBAGENTS_MAX_VISIBLE_ROWS - 1) * SUBAGENTS_ROW_GAP;
var INACTIVE_SUBAGENT_OPACITY = 0.65;
var packageRequire = createRequire(import.meta.url);
function readPluginVersion() {
  try {
    const metadata = packageRequire("../package.json");
    return typeof metadata.version === "string" && metadata.version.length > 0 ? metadata.version : void 0;
  } catch {
    return void 0;
  }
}
var PLUGIN_VERSION = readPluginVersion();
var sidebarScrollRegistrations = /* @__PURE__ */ new Set();
var sidebarListFocusRegistrations = /* @__PURE__ */ new Set();
var sidebarCompletedHistoryRegistrations = /* @__PURE__ */ new Set();
var SIDEBAR_SCROLL_RESTORE_FRAME_BUDGET = 2;
function focusVisibleSidebarSubagentList(preferredChildID) {
  for (const registration of [...sidebarListFocusRegistrations].reverse()) {
    if (registration.focusList(preferredChildID)) return true;
  }
  return false;
}
function blurVisibleSidebarSubagentList() {
  for (const registration of [...sidebarListFocusRegistrations].reverse()) {
    if (registration.blurList()) return true;
  }
  return false;
}
function isAnySidebarSubagentListFocused() {
  return [...sidebarListFocusRegistrations].some((registration) => registration.isListFocusModeActive());
}
function toggleVisibleSidebarCompletedHistory() {
  for (const registration of [...sidebarCompletedHistoryRegistrations].reverse()) {
    if (registration.toggleCompletedHistory()) return true;
  }
  return false;
}
function maxScrollTop(scrollbox) {
  return Math.max(0, scrollbox.scrollHeight - scrollbox.viewport.height);
}
function clampedScrollTop(scrollbox, value) {
  return Math.max(0, Math.min(value, maxScrollTop(scrollbox)));
}
function snapshotSidebarScrollOffsets() {
  for (const registration of sidebarScrollRegistrations) {
    const scrollbox = registration.getScrollbox();
    if (!scrollbox) continue;
    registration.offsetTop = clampedScrollTop(scrollbox, scrollbox.scrollTop);
    registration.anchor = registration.getAnchor();
    registration.restoreFramesRemaining = SIDEBAR_SCROLL_RESTORE_FRAME_BUDGET;
  }
}
function resolveSidebarAnchorScrollTop(input) {
  if (!input.expanded || !input.anchor || input.anchor.childIDs.length === 0) {
    return {
      matched: false
    };
  }
  let top = input.leadingHeight;
  const rowTops = /* @__PURE__ */ new Map();
  for (const row of input.rows) {
    rowTops.set(row.id, top);
    top += row.height + SUBAGENTS_ROW_GAP;
  }
  for (const [index, childID] of input.anchor.childIDs.entries()) {
    const rowTop = rowTops.get(childID);
    if (rowTop === void 0) continue;
    const desiredTop = rowTop + (index === 0 ? input.anchor.intraRowOffset : 0);
    const maxTop = Math.max(0, input.scrollHeight - input.viewportHeight);
    const nextTop = Math.max(0, Math.min(desiredTop, maxTop));
    return {
      matched: true,
      offsetTop: nextTop,
      scrollTop: input.scrollTop !== nextTop ? nextTop : void 0
    };
  }
  return {
    matched: false
  };
}
function preservedSidebarAnchorScrollTop(input) {
  return resolveSidebarAnchorScrollTop({
    ...input,
    leadingHeight: input.leadingHeight ?? 0
  }).scrollTop;
}
function preservedSidebarScrollTop(input) {
  if (!input.expanded) return void 0;
  const anchorTop = resolveSidebarAnchorScrollTop({
    expanded: input.expanded,
    anchor: input.anchor,
    rows: input.rows ?? [],
    leadingHeight: input.leadingHeight ?? 0,
    scrollTop: input.scrollTop,
    scrollHeight: input.scrollHeight,
    viewportHeight: input.viewportHeight
  });
  if (anchorTop.matched) return anchorTop.scrollTop;
  const maxTop = Math.max(0, input.scrollHeight - input.viewportHeight);
  const top = Math.max(0, Math.min(input.offsetTop, maxTop));
  return top > 0 && input.scrollTop !== top ? top : void 0;
}
var doneTokenCache = /* @__PURE__ */ new Map();
function debugLog(input) {
  if (!process.env.OPENCODE_SUBAGENT_STATUSLINE_DEBUG_EVENTS) return;
  try {
    const path = join2(process.env.XDG_RUNTIME_DIR ?? os2.tmpdir(), "opencode-subagent-statusline", "tui-events.log");
    mkdirSync(dirname2(path), {
      recursive: true
    });
    const line = JSON.stringify({
      time: (/* @__PURE__ */ new Date()).toISOString(),
      ...input
    });
    appendFileSync(path, `${line}
`, "utf8");
  } catch {
  }
}
function debugEvent(event) {
  const e = event;
  const part = e.properties?.part;
  debugLog({
    kind: "event",
    type: e.type,
    sessionID: e.properties?.sessionID,
    partType: part?.type,
    tool: part?.tool,
    toolStatus: part?.state?.status
  });
}
function cloneState(state) {
  return {
    updatedAt: state.updatedAt,
    totalExecuted: state.totalExecuted,
    countedChildIDs: {
      ...state.countedChildIDs
    },
    children: Object.fromEntries(Object.entries(state.children).map(([id, child]) => [id, {
      ...child,
      tokens: child.tokens ? {
        ...child.tokens
      } : void 0,
      model: child.model ? {
        ...child.model
      } : void 0
    }]))
  };
}
function mergeTokenState(existing, incoming) {
  if (!existing && !incoming) return void 0;
  return {
    input: incoming?.input ?? existing?.input,
    output: incoming?.output ?? existing?.output,
    total: incoming?.total ?? existing?.total,
    contextPercent: incoming?.contextPercent ?? existing?.contextPercent
  };
}
function hasTokenTotal(tokens) {
  return typeof tokens?.total === "number" && Number.isFinite(tokens.total);
}
function sameTokens2(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function asRecord2(value) {
  return value && typeof value === "object" ? value : void 0;
}
function tokenStateFromMessageData(data) {
  const parsed = safeRead2(() => JSON.parse(data));
  return parsed?.tokens;
}
function resolveOpenCodeDataDir() {
  return join2(process.env.XDG_DATA_HOME ?? join2(os2.homedir(), ".local", "share"), "opencode");
}
function resolveOpenCodeDbPath() {
  return process.env.OPENCODE_SUBAGENT_STATUSLINE_OPENCODE_DB ?? join2(resolveOpenCodeDataDir(), "opencode.db");
}
function escapeSqlString(value) {
  return value.replace(/'/g, "''");
}
function readDoneTokensFromOpenCodeDb(sessionID) {
  const dbPath = resolveOpenCodeDbPath();
  if (!existsSync(dbPath)) return void 0;
  const output = safeRead2(() => execFileSync("sqlite3", [dbPath, `select data from message where session_id='${escapeSqlString(sessionID)}' order by time_created desc limit 50;`], {
    encoding: "utf8",
    timeout: 1e3,
    maxBuffer: 1024 * 1024
  }));
  if (!output) return void 0;
  let tokens;
  for (const line of output.split("\n")) {
    const hydrated = tokenStateFromMessageData(line.trim());
    tokens = mergeTokenState(tokens, hydrated);
    if (hasTokenTotal(tokens)) break;
  }
  return tokens;
}
function readDoneTokensFromOpenCodeLogs(sessionID) {
  const logDir = join2(resolveOpenCodeDataDir(), "log");
  if (!existsSync(logDir)) return void 0;
  const files = safeRead2(() => readdirSync(logDir).filter((file) => file.endsWith(".log")).sort().reverse().slice(0, 8));
  if (!files) return void 0;
  const tokenPattern = /"tokens"\s*:\s*(\{[^\n]*?\})/g;
  let tokens;
  for (const file of files) {
    const contents = readOpenCodeLogFileIfSmall(join2(logDir, file));
    if (!contents || !contents.includes(sessionID)) continue;
    for (const line of contents.split("\n")) {
      if (!line.includes(sessionID) || !line.includes('"tokens"')) continue;
      for (const match of line.matchAll(tokenPattern)) {
        const hydrated = safeRead2(() => JSON.parse(match[1] ?? "{}"));
        tokens = mergeTokenState(tokens, hydrated);
        if (hasTokenTotal(tokens)) return tokens;
      }
    }
  }
  return tokens;
}
function rehydrateDoneChildTokens(child) {
  if (child.status !== "done") return void 0;
  if (hasTokenTotal(child.tokens)) return void 0;
  if (!child.id.startsWith("ses_")) return void 0;
  const nowMs = Date.now();
  const cached = doneTokenCache.get(child.id);
  if (cached?.tokens) return cached.tokens;
  if (cached && cached.attempts >= DONE_TOKEN_REHYDRATE_MAX_ATTEMPTS) {
    return void 0;
  }
  if (cached && nowMs - cached.checkedAtMs < DONE_TOKEN_REHYDRATE_THROTTLE_MS) {
    return void 0;
  }
  const tokens = readDoneTokensFromOpenCodeDb(child.id) ?? readDoneTokensFromOpenCodeLogs(child.id);
  doneTokenCache.set(child.id, {
    attempts: (cached?.attempts ?? 0) + 1,
    checkedAtMs: nowMs,
    tokens
  });
  if (tokens) {
    debugLog({
      kind: "state.tokens.rehydrated.done",
      id: child.id,
      title: child.title,
      tokens
    });
  }
  return tokens;
}
function safeRead2(read) {
  try {
    return read();
  } catch {
    return void 0;
  }
}
function messageIDOf(message) {
  const record = asRecord2(message);
  if (!record) return void 0;
  const id = record.id ?? record.messageID ?? record.messageId;
  return typeof id === "string" && id.length > 0 ? id : void 0;
}
function pushSessionCandidates(api, sessionID, candidates) {
  if (!sessionID) return;
  const status = safeRead2(() => api.state.session.status(sessionID));
  if (status) candidates.push(status);
  const messages = safeRead2(() => api.state.session.messages(sessionID));
  if (!messages) return;
  candidates.push(messages);
  for (const message of messages) {
    const messageID = messageIDOf(message);
    if (!messageID) continue;
    const parts = safeRead2(() => api.state.part(messageID));
    if (parts) candidates.push(parts);
  }
}
function hydrateChildTokensFromTuiState(api, child) {
  const candidates = [];
  pushSessionCandidates(api, child.id, candidates);
  if (child.messageID) {
    const parentParts = safeRead2(() => api.state.part(child.messageID));
    if (parentParts) candidates.push(parentParts);
    const parentMessages = safeRead2(() => api.state.session.messages(child.parentID));
    const parentMessage = parentMessages?.find((message) => messageIDOf(message) === child.messageID);
    if (parentMessage) candidates.push(parentMessage);
  }
  let tokens;
  for (const candidate of candidates) {
    tokens = mergeTokenState(tokens, extractChildDetails(candidate).tokens);
  }
  tokens = mergeTokenState(tokens, rehydrateDoneChildTokens(child));
  return tokens;
}
function hydrateStateTokensFromTuiState(api, state) {
  let changed = false;
  for (const child of Object.values(state.children)) {
    if (child.status !== "running" && hasTokenTotal(child.tokens)) continue;
    const hydrated = hydrateChildTokensFromTuiState(api, child);
    const nextTokens = mergeTokenState(child.tokens, hydrated);
    if (!sameTokens2(child.tokens, nextTokens)) {
      child.tokens = nextTokens;
      child.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      changed = true;
    }
  }
  if (changed) {
    state.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    debugLog({
      kind: "state.tokens.hydrated",
      children: Object.values(state.children).map((child) => ({
        id: child.id,
        title: child.title,
        tokens: child.tokens
      }))
    });
  }
  return changed;
}
function persistStateSnapshot(statePath, textPath, state) {
  const snapshot = cloneState(state);
  void (async () => {
    try {
      await saveState(statePath, snapshot);
      await saveStatusText(textPath, renderStatusLine(snapshot));
    } catch {
    }
  })();
}
function refreshLiveState(state) {
  const beforeChildIDs = new Set(Object.keys(state.children));
  refreshDerivedFields(state);
  if (Object.keys(state.children).length !== beforeChildIDs.size) {
    return true;
  }
  for (const childID of beforeChildIDs) {
    if (!state.children[childID]) return true;
  }
  return false;
}
function runTuiStateMaintenance(api, current) {
  const next = cloneState(current);
  const hydrated = hydrateStateTokensFromTuiState(api, next);
  const refreshed = refreshLiveState(next);
  return hydrated || refreshed ? next : current;
}
function createTuiMaintenanceTimers(input) {
  let elapsedTimer;
  const maintenanceTimer = setInterval(input.onMaintenanceTick, MAINTENANCE_TICK_MS);
  return {
    syncElapsedTimer(hasRunningChild) {
      if (hasRunningChild && !elapsedTimer) {
        elapsedTimer = setInterval(input.onElapsedTick, ELAPSED_TICK_MS);
      } else if (!hasRunningChild && elapsedTimer) {
        clearInterval(elapsedTimer);
        elapsedTimer = void 0;
      }
    },
    dispose() {
      if (elapsedTimer) clearInterval(elapsedTimer);
      clearInterval(maintenanceTimer);
      elapsedTimer = void 0;
    }
  };
}
function elapsedMs(child, nowMs) {
  if (child.status !== "running") {
    return child.elapsedMs ?? 0;
  }
  const started = Date.parse(child.startedAt);
  if (Number.isNaN(started)) return child.elapsedMs ?? 0;
  return Math.max(0, nowMs - started);
}
function taskStatusMarker(status) {
  if (status === "done") return "[\u2713]";
  if (status === "error") return "[x]";
  return "[ ]";
}
function statusColor2(status, theme) {
  if (status === "done") return theme.success;
  if (status === "error") return theme.error;
  return theme.warning;
}
function isSessionTarget(value) {
  return typeof value === "string" && value.startsWith("ses_");
}
function resolveChildTargetSessionID(child) {
  if (isSessionTarget(child.targetSessionID)) {
    return child.targetSessionID;
  }
  if (child.id.startsWith("ses_")) {
    return child.id;
  }
  return void 0;
}
function resolveSyntheticTargetFromHydratedState(state, synthetic) {
  const messageMatches = Object.values(state.children).filter((candidate) => candidate.id.startsWith("ses_") && candidate.parentID === synthetic.parentID && synthetic.messageID && candidate.messageID === synthetic.messageID);
  if (messageMatches.length === 1) return messageMatches[0].id;
  const parentMatches = Object.values(state.children).filter((candidate) => candidate.id.startsWith("ses_") && candidate.parentID === synthetic.parentID);
  if (parentMatches.length === 1) return parentMatches[0].id;
  return void 0;
}
function backfillHydratedTargetSessionIDs(state, parentSessionID) {
  let changed = false;
  for (const child of Object.values(state.children)) {
    if (child.parentID !== parentSessionID) continue;
    if (resolveChildTargetSessionID(child)) continue;
    if (child.source === "session" || child.id.startsWith("ses_")) {
      child.targetSessionID = child.id;
      changed = true;
      continue;
    }
    const syntheticTarget = resolveSyntheticTargetFromHydratedState(state, child);
    if (syntheticTarget) {
      child.targetSessionID = syntheticTarget;
      changed = true;
    }
  }
  if (changed) {
    state.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  }
  return changed;
}
function navigateToSessionTarget(api, targetSessionID) {
  if (!isSessionTarget(targetSessionID)) return;
  api.route.navigate("session", {
    sessionID: targetSessionID
  });
}
function toFinitePositiveInt(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return void 0;
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : void 0;
}
function parseStaleRunningThresholdMs2() {
  return parseStaleRunningThresholdMs(process.env.OPENCODE_SUBAGENT_STATUSLINE_STALE_RUNNING_MS);
}
var STALE_RUNNING_THRESHOLD_MS = parseStaleRunningThresholdMs2();
function resolveSidebarWidth(ctx) {
  const source = asRecord2(ctx);
  if (!source) return void 0;
  const direct = toFinitePositiveInt(source.width) ?? toFinitePositiveInt(source.columns) ?? toFinitePositiveInt(source.cols);
  if (direct) return direct;
  const size = asRecord2(source.size);
  const viewport = asRecord2(source.viewport);
  const bounds = asRecord2(source.bounds);
  return toFinitePositiveInt(size?.width) ?? toFinitePositiveInt(viewport?.width) ?? toFinitePositiveInt(bounds?.width);
}
function ellipsize(value, maxColumns) {
  return truncateToColumns(value, maxColumns);
}
function splitParentheticalTitle(title) {
  const match = title.match(/^(.*?)\s*(\([^)]*\))\s*$/);
  if (!match) return {
    label: title
  };
  const label = match[1]?.trim();
  const parenthetical = match[2]?.trim();
  if (!label || !parenthetical) return {
    label: title
  };
  return {
    label,
    parenthetical
  };
}
function childParenthetical(child) {
  if (child.agentName?.trim()) return `(${child.agentName.trim()})`;
  const primary = splitParentheticalTitle(childPrimaryText(child));
  if (primary.parenthetical) return primary.parenthetical;
  return splitParentheticalTitle(child.title).parenthetical;
}
function formatSecondaryLine(continuation, parenthetical, width) {
  if (!continuation) return parenthetical;
  if (!parenthetical) return continuation;
  const parentheticalWidth = Math.min(textColumns(parenthetical), width);
  const continuationWidth = width - parentheticalWidth - 1;
  if (continuationWidth >= MIN_LABEL_WIDTH) {
    return `${ellipsize(continuation, continuationWidth)} ${ellipsize(parenthetical, parentheticalWidth)}`;
  }
  return ellipsize(parenthetical, width);
}
function childPrimaryText(child) {
  return child.summary?.trim() || child.title;
}
function resolveTokenTotal2(child) {
  const total = child.tokens?.total;
  if (typeof total === "number" && Number.isFinite(total)) {
    return total;
  }
  const input = child.tokens?.input;
  const output = child.tokens?.output;
  if (typeof input === "number" || typeof output === "number") {
    return Math.max(0, (input ?? 0) + (output ?? 0));
  }
  return void 0;
}
function formatCompactTokenCount(total) {
  const value = Math.max(0, total);
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M tok`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k tok`;
  return `${Math.round(value)} tok`;
}
function formatTokensPerSecond(child, nowMs) {
  const output = child.tokens?.output;
  if (typeof output !== "number" || !Number.isFinite(output) || output <= 0) return "";
  const ms = elapsedMs(child, nowMs);
  if (!Number.isFinite(ms) || ms < 500) return "";
  const tps = output / (ms / 1e3);
  if (!Number.isFinite(tps) || tps <= 0) return "";
  return `${tps >= 100 ? Math.round(tps) : tps.toFixed(1)} t/s`;
}
function formatCompactPercent(percent) {
  return `${Math.max(0, Math.round(percent))}%`;
}
function contextVariants(child) {
  const total = resolveTokenTotal2(child);
  const percent = child.tokens?.contextPercent;
  const hasTotal = typeof total === "number" && Number.isFinite(total);
  const hasPercent = typeof percent === "number" && Number.isFinite(percent);
  if (!hasTotal && !hasPercent) return [""];
  const tokenPart = hasTotal ? formatCompactTokenCount(total) : "";
  const percentPart = hasPercent ? formatCompactPercent(percent) : "";
  if (tokenPart && percentPart) {
    return [`${tokenPart} ${percentPart}`, percentPart, tokenPart, ""];
  }
  return [tokenPart || percentPart, ""];
}
function rowWidthBudget(sidebarWidth) {
  const width = sidebarWidth ?? FALLBACK_SIDEBAR_WIDTH;
  const innerWidth = width - 4;
  return Math.max(MIN_ROW_WIDTH, Math.min(innerWidth, 52));
}
function wrapCompactText(value, width, maxLines) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return [""];
  const lines = [];
  let remaining = normalized;
  while (textColumns(remaining) > width && lines.length < maxLines - 1) {
    const probe = takeColumns(remaining, width + 1);
    const breakAt = probe.lastIndexOf(" ");
    const breakPrefix = breakAt >= 0 ? probe.slice(0, breakAt) : "";
    const fit = takeColumns(remaining, width);
    const take = breakAt >= 0 && textColumns(breakPrefix) >= MIN_LABEL_WIDTH && textColumns(breakPrefix) <= width ? breakAt : fit.length;
    if (take <= 0) break;
    lines.push(remaining.slice(0, take).trimEnd());
    remaining = remaining.slice(take).trimStart();
  }
  lines.push(lines.length === maxLines - 1 ? ellipsize(remaining, Math.max(1, width)) : remaining);
  return lines;
}
function formatChildRowLine(input) {
  const elapsed = formatDuration(elapsedMs(input.child, input.nowMs));
  const width = Math.max(MIN_ROW_WIDTH, rowWidthBudget(input.sidebarWidth) - (input.reservedWidth ?? 0));
  const title = splitParentheticalTitle(childPrimaryText(input.child));
  const parenthetical = childParenthetical(input.child);
  for (const meta of contextVariants(input.child)) {
    const detailChars = 2 + textColumns(elapsed) + (meta ? 3 + textColumns(meta) : 0);
    const labelBudget = Math.min(width - 2, width - Math.max(0, detailChars - width));
    if (labelBudget >= MIN_LABEL_WIDTH || textColumns(meta) === 0) {
      const labelLines2 = wrapCompactText(title.label, Math.max(1, labelBudget), 2);
      return {
        labelLines: labelLines2,
        secondaryLine: formatSecondaryLine(labelLines2[1], parenthetical, Math.max(1, labelBudget)),
        elapsed,
        meta,
        tps: formatTokensPerSecond(input.child, input.nowMs)
      };
    }
  }
  const labelLines = wrapCompactText(title.label, MIN_LABEL_WIDTH, 2);
  return {
    labelLines,
    secondaryLine: formatSecondaryLine(labelLines[1], parenthetical, MIN_LABEL_WIDTH),
    elapsed,
    meta: "",
    tps: formatTokensPerSecond(input.child, input.nowMs)
  };
}
function formatTerminalChildRowLine(input) {
  const elapsed = formatDuration(elapsedMs(input.child, input.nowMs));
  const width = Math.max(MIN_ROW_WIDTH, rowWidthBudget(input.sidebarWidth));
  const title = splitParentheticalTitle(childPrimaryText(input.child));
  const parenthetical = childParenthetical(input.child);
  const labelSource = parenthetical ? `${title.label} ${parenthetical}` : title.label;
  const context = contextVariants(input.child).find((variant) => variant.length > 0);
  const tps = formatTokensPerSecond(input.child, input.nowMs);
  const meta = [elapsed, context, tps].filter((part) => part && part.length > 0).join(" ");
  return {
    label: ellipsize(labelSource, Math.max(1, width - (input.reservedWidth ?? 0))),
    meta
  };
}
function subagentRowHeight(input) {
  const modelHeight = input.child.model?.variant ? SUBAGENTS_MODEL_ROW_HEIGHT : 0;
  if (input.child.status !== "running") {
    return SUBAGENTS_TERMINAL_ROW_HEIGHT + modelHeight;
  }
  const line = formatChildRowLine(input);
  return (line.secondaryLine ? SUBAGENTS_RUNNING_ROW_HEIGHT : SUBAGENTS_RUNNING_ROW_HEIGHT - 1) + modelHeight;
}
function formatChildModelLine(child, providers, width) {
  if (!child.model?.variant) return void 0;
  const provider = providers.find((candidate) => candidate.id === child.model?.providerID);
  const name = provider?.models[child.model.modelID]?.name || child.model.modelID;
  return ellipsize(`${name} \xB7 ${child.model.variant}`, Math.max(1, width));
}
function resolveTuiSubagentSnapshot(input) {
  const allChildren = Object.values(input.state.children);
  const options = {
    showCompletedHistory: input.showCompletedHistory
  };
  const nowMs = input.nowMs ?? Date.now();
  const ownChildren = input.sessionID ? allChildren.filter((child) => child.parentID === input.sessionID) : allChildren;
  const ownVisibleChildren = visibleSubagentWorkItems(ownChildren, nowMs, options).sort(byPriority);
  const totalExecuted = input.sessionID ? countCountedSubagentExecutions({
    children: allChildren,
    countedChildIDs: input.state.countedChildIDs,
    parentSessionID: input.sessionID
  }) : countHistoricalSubagentExecutions({
    children: allChildren
  });
  return {
    visibleChildren: ownVisibleChildren,
    visibleCounts: countRetainedSubagentStatuses({
      children: allChildren,
      parentSessionID: input.sessionID
    }),
    totalExecuted,
    showingOtherSessions: false
  };
}
function resolveSidebarSubagentSnapshot(input) {
  return resolveTuiSubagentSnapshot(input);
}
function SidebarSubagents(props) {
  const [showCompletedHistory, setShowCompletedHistory] = createSignal(props.restoreFromChild?.showCompletedHistory ?? false);
  const completedHistoryOptions = () => ({
    showCompletedHistory: showCompletedHistory()
  });
  const snapshot = createMemo(() => resolveSidebarSubagentSnapshot({
    state: props.state(),
    sessionID: props.sessionID,
    nowMs: props.nowMs(),
    ...completedHistoryOptions()
  }));
  const visibleChildren = createMemo(() => snapshot().visibleChildren);
  const counts = createMemo(() => snapshot().visibleCounts);
  const totalExecuted = createMemo(() => snapshot().totalExecuted);
  const visibleChildIDs = createMemo(() => visibleChildren().map((child) => child.id));
  const [selectedChildID, setSelectedChildID] = createSignal(props.restoreFromChild?.childRowID);
  let restoreChildRowID = props.restoreFromChild?.childRowID;
  const [mouseDownChildID, setMouseDownChildID] = createSignal();
  const [listFocused, setListFocused] = createSignal(false);
  const [listFocusModeActive, setListFocusModeActive] = createSignal(false);
  const visibleChildLayoutSignature = createMemo(() => visibleChildren().map((child) => JSON.stringify([child.id, child.status, child.title, child.summary ?? "", child.agentName ?? "", child.tokens?.input ?? "", child.tokens?.output ?? "", child.tokens?.total ?? "", child.tokens?.contextPercent ?? "", child.model?.providerID ?? "", child.model?.modelID ?? "", child.model?.variant ?? ""])).join("|"));
  const listHeight = createMemo(() => {
    const nowMs = props.nowMs();
    const sidebarWidth = props.sidebarWidth?.();
    const contentHeight = visibleChildren().reduce((height, child) => height + subagentRowHeight({
      child,
      nowMs,
      sidebarWidth,
      reservedWidth: SUBAGENTS_ROW_MARKER_WIDTH
    }), 0) + Math.max(0, visibleChildren().length - 1) * SUBAGENTS_ROW_GAP;
    return Math.max(1, Math.min(SUBAGENTS_MAX_LIST_HEIGHT, contentHeight));
  });
  let listContainer;
  let scrollbox;
  const scrollRegistration = {
    getScrollbox: () => scrollbox,
    getAnchor: () => currentSidebarScrollAnchor(),
    getRows: () => rowLayouts(),
    getLeadingHeight: () => 0,
    offsetTop: 0,
    restoreFramesRemaining: 0
  };
  sidebarScrollRegistrations.add(scrollRegistration);
  const focusRegistration = {
    focusList: (preferredChildID) => {
      if (!listContainer) return false;
      const ids = visibleChildIDs();
      if (preferredChildID && ids.includes(preferredChildID)) {
        setSelectedChildID(preferredChildID);
      } else if (!selectedChildID() && ids[0]) {
        setSelectedChildID(ids[0]);
      }
      listContainer.focus();
      setListFocused(true);
      setListFocusModeActive(true);
      return true;
    },
    blurList: () => {
      if (!listFocused() && !listFocusModeActive()) return false;
      listContainer?.blur();
      setListFocused(false);
      setListFocusModeActive(false);
      return true;
    },
    isListFocusModeActive: () => listFocusModeActive()
  };
  sidebarListFocusRegistrations.add(focusRegistration);
  let previousRunningCount;
  createEffect(() => {
    const runningCount = counts().running;
    const shouldReleaseFocus = shouldReleaseSidebarListFocus({
      previousRunningCount,
      runningCount,
      listFocusModeActive: listFocusModeActive()
    });
    previousRunningCount = runningCount;
    if (!shouldReleaseFocus) return;
    focusRegistration.blurList();
    props.onReturnFocus();
  });
  const completedHistoryRegistration = {
    toggleCompletedHistory: () => {
      setShowCompletedHistory((current) => !current);
      return true;
    }
  };
  sidebarCompletedHistoryRegistrations.add(completedHistoryRegistration);
  onCleanup(() => {
    sidebarScrollRegistrations.delete(scrollRegistration);
    sidebarListFocusRegistrations.delete(focusRegistration);
    sidebarCompletedHistoryRegistrations.delete(completedHistoryRegistration);
  });
  createEffect(() => {
    const ids = visibleChildIDs();
    const current = selectedChildID();
    if (ids.length === 0) {
      if (current) setSelectedChildID(void 0);
      return;
    }
    if (!current || !ids.includes(current)) setSelectedChildID(ids[0]);
  });
  const refreshListFocused = () => {
    if (listFocused() && !listContainer) {
      setListFocused(false);
      return;
    }
    const focused = Boolean(listContainer?.focused || listContainer?.hasFocusedDescendant);
    if (!focused && listFocused()) setListFocused(false);
  };
  const rowTopForIndex = (index) => {
    let top = 0;
    const nowMs = props.nowMs();
    const sidebarWidth = props.sidebarWidth?.();
    for (let i = 0; i < index; i += 1) {
      const child = visibleChildren()[i];
      if (child) {
        top += subagentRowHeight({
          child,
          nowMs,
          sidebarWidth,
          reservedWidth: SUBAGENTS_ROW_MARKER_WIDTH
        }) + SUBAGENTS_ROW_GAP;
      }
    }
    return top;
  };
  const rowLayouts = () => {
    const nowMs = props.nowMs();
    const sidebarWidth = props.sidebarWidth?.();
    return visibleChildren().map((child) => ({
      id: child.id,
      height: subagentRowHeight({
        child,
        nowMs,
        sidebarWidth,
        reservedWidth: SUBAGENTS_ROW_MARKER_WIDTH
      })
    }));
  };
  const currentSidebarScrollAnchor = () => {
    if (!scrollbox) return void 0;
    const rows = rowLayouts();
    if (rows.length === 0) return void 0;
    const viewportTop = clampedScrollTop(scrollbox, scrollbox.scrollTop);
    let top = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row) continue;
      const rowBottom = top + row.height;
      if (rowBottom > viewportTop) {
        return {
          childIDs: rows.slice(index).map((candidate) => candidate.id),
          intraRowOffset: Math.max(0, viewportTop - top)
        };
      }
      top = rowBottom + SUBAGENTS_ROW_GAP;
    }
    const lastRow = rows[rows.length - 1];
    return lastRow ? {
      childIDs: [lastRow.id],
      intraRowOffset: 0
    } : void 0;
  };
  const scrollChildIntoView = (childID) => {
    if (!scrollbox) return;
    const selectedIndex = visibleChildIDs().findIndex((id) => id === childID);
    if (selectedIndex < 0) return;
    const selectedChild = visibleChildren()[selectedIndex];
    if (!selectedChild) return;
    const rowTop = rowTopForIndex(selectedIndex);
    const rowBottom = rowTop + subagentRowHeight({
      child: selectedChild,
      nowMs: props.nowMs(),
      sidebarWidth: props.sidebarWidth?.(),
      reservedWidth: SUBAGENTS_ROW_MARKER_WIDTH
    });
    const viewportTop = scrollbox.scrollTop;
    const viewportBottom = viewportTop + listHeight();
    if (rowTop < viewportTop) {
      const nextTop = clampedScrollTop(scrollbox, rowTop);
      scrollRegistration.offsetTop = nextTop;
      scrollbox.scrollTop = nextTop;
    } else if (rowBottom > viewportBottom) {
      const nextTop = clampedScrollTop(scrollbox, rowBottom - listHeight());
      scrollRegistration.offsetTop = nextTop;
      scrollbox.scrollTop = nextTop;
    }
  };
  const scrollSelectedChildIntoView = () => {
    if (!listFocusModeActive()) return;
    scrollChildIntoView(selectedChildID());
  };
  const moveSelection = (delta) => {
    const ids = visibleChildIDs();
    if (ids.length === 0) return;
    const currentIndex = ids.findIndex((id) => id === selectedChildID());
    const fallbackIndex = delta > 0 ? 0 : ids.length - 1;
    const nextIndex = Math.max(0, Math.min(ids.length - 1, currentIndex < 0 ? fallbackIndex : currentIndex + delta));
    setSelectedChildID(ids[nextIndex]);
    scrollChildIntoView(ids[nextIndex]);
  };
  const rowActivations = /* @__PURE__ */ new Map();
  const resolveNavigableChildTargetSessionID = (child) => resolveChildTargetSessionID(child) ?? resolveSyntheticTargetFromHydratedState(props.state(), child);
  const selectedTargetSessionID = () => {
    const selected = visibleChildren().find((child) => child.id === selectedChildID());
    return selected ? resolveNavigableChildTargetSessionID(selected) : void 0;
  };
  const activateSelectedChild = () => {
    const selectedID = selectedChildID();
    const activateRow = selectedID ? rowActivations.get(selectedID) : void 0;
    if (activateRow) {
      activateRow();
      return;
    }
    navigateToSessionTarget(props.api, selectedTargetSessionID());
  };
  const toggleCompletedHistory = () => {
    completedHistoryRegistration.toggleCompletedHistory();
  };
  createEffect(() => {
    selectedChildID();
    listHeight();
    if (!listFocused()) return;
    scrollSelectedChildIntoView();
  });
  const handleListKeyDown = (event) => {
    if (!listFocused()) return;
    const name = event.name.toLowerCase();
    if ((event.meta || event.option) && name === "b") {
      props.onToggleListFocus();
    } else if (name === "j" || name === "down" || name === "arrowdown") {
      moveSelection(1);
    } else if (name === "k" || name === "up" || name === "arrowup") {
      moveSelection(-1);
    } else if (name === "return" || name === "enter") {
      activateSelectedChild();
    } else if (name === "h" || name === "left" || name === "arrowleft") {
      if (props.expanded()) props.onSetExpanded(false);
    } else if (name === "l" || name === "right" || name === "arrowright") {
      if (!props.expanded()) props.onSetExpanded(true);
    } else if (name === "c") {
      toggleCompletedHistory();
    } else if (name === "escape" || name === "esc") {
      focusRegistration.blurList();
      props.onReturnFocus();
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };
  useKeyboard(handleListKeyDown);
  const restorePreservedScroll = () => {
    if (!scrollbox) return;
    if (scrollRegistration.restoreFramesRemaining <= 0) return;
    scrollRegistration.restoreFramesRemaining -= 1;
    if (restoreChildRowID) {
      const childRowID = restoreChildRowID;
      restoreChildRowID = void 0;
      scrollRegistration.restoreFramesRemaining = 0;
      if (visibleChildIDs().includes(childRowID)) {
        scrollChildIntoView(childRowID);
      } else {
        scrollbox.scrollTop = 0;
      }
      return;
    }
    const top = preservedSidebarScrollTop({
      expanded: props.expanded(),
      offsetTop: scrollRegistration.offsetTop,
      anchor: scrollRegistration.anchor,
      rows: scrollRegistration.getRows(),
      leadingHeight: scrollRegistration.getLeadingHeight(),
      scrollTop: scrollbox.scrollTop,
      scrollHeight: scrollbox.scrollHeight,
      viewportHeight: scrollbox.viewport.height
    });
    if (top === void 0) return;
    scrollRegistration.offsetTop = top;
    scrollbox.scrollTop = top;
  };
  createEffect(() => {
    props.expanded();
    visibleChildIDs().join("|");
    visibleChildLayoutSignature();
    props.sidebarWidth?.();
    restorePreservedScroll();
  });
  const ChildRow = (rowProps) => {
    const child = createMemo(() => visibleChildren().find((candidate) => candidate.id === rowProps.childID));
    const [hovered, setHovered] = createSignal(false);
    const [focused, setFocused] = createSignal(false);
    const targetSessionID = createMemo(() => {
      const currentChild = child();
      return currentChild ? resolveNavigableChildTargetSessionID(currentChild) : void 0;
    });
    const clickable = createMemo(() => isSessionTarget(targetSessionID()));
    const selected = createMemo(() => listFocused() && selectedChildID() === rowProps.childID);
    const emphasized = createMemo(() => clickable() && (hovered() || focused() || selected()));
    const status = createMemo(() => child()?.status ?? "running");
    const muted = createMemo(() => status() !== "running" && clickable() && !emphasized());
    const rowOpacity = createMemo(() => status() === "running" ? 1 : INACTIVE_SUBAGENT_OPACITY);
    const line = createMemo(() => {
      const currentChild = child();
      if (!currentChild) {
        return {
          labelLines: [""],
          elapsed: "00:00",
          meta: ""
        };
      }
      return formatChildRowLine({
        child: currentChild,
        nowMs: props.nowMs(),
        sidebarWidth: props.sidebarWidth?.(),
        reservedWidth: SUBAGENTS_ROW_MARKER_WIDTH
      });
    });
    const terminalLine = createMemo(() => {
      const currentChild = child();
      if (!currentChild) return {
        label: "",
        meta: "00:00"
      };
      return formatTerminalChildRowLine({
        child: currentChild,
        nowMs: props.nowMs(),
        sidebarWidth: props.sidebarWidth?.(),
        reservedWidth: SUBAGENTS_ROW_MARKER_WIDTH
      });
    });
    const rowHeight = createMemo(() => {
      const currentChild = child();
      if (!currentChild) return SUBAGENTS_TERMINAL_ROW_HEIGHT;
      return subagentRowHeight({
        child: currentChild,
        nowMs: props.nowMs(),
        sidebarWidth: props.sidebarWidth?.(),
        reservedWidth: SUBAGENTS_ROW_MARKER_WIDTH
      });
    });
    const modelLine = createMemo(() => {
      const currentChild = child();
      if (!currentChild) return void 0;
      return formatChildModelLine(currentChild, props.api.state.provider, rowWidthBudget(props.sidebarWidth?.()) - SUBAGENTS_ROW_MARKER_WIDTH);
    });
    const activate = () => {
      const target = targetSessionID();
      if (target) {
        props.onNavigateToChild({
          parentSessionID: props.sessionID,
          childSessionID: target,
          childRowID: rowProps.childID,
          showCompletedHistory: showCompletedHistory()
        });
      }
      snapshotSidebarScrollOffsets();
      navigateToSessionTarget(props.api, target);
    };
    rowActivations.set(rowProps.childID, activate);
    onCleanup(() => {
      rowActivations.delete(rowProps.childID);
    });
    const handleKeyDown = (event) => {
      if (!clickable()) return;
      setFocused(true);
      if (event.name === "return" || event.name === "space") {
        activate();
        event.preventDefault();
        event.stopPropagation();
      }
    };
    return (() => {
      var _el$ = _$createElement("box");
      _$setProp(_el$, "flexDirection", "column");
      _$insert(_el$, _$createComponent(Show, {
        get when() {
          return status() === "running";
        },
        get fallback() {
          return (() => {
            var _el$0 = _$createElement("box"), _el$1 = _$createElement("box"), _el$10 = _$createElement("text"), _el$11 = _$createElement("text"), _el$12 = _$createElement("text"), _el$13 = _$createElement("text");
            _$insertNode(_el$0, _el$1);
            _$insertNode(_el$0, _el$13);
            _$setProp(_el$0, "flexDirection", "column");
            _$insertNode(_el$1, _el$10);
            _$insertNode(_el$1, _el$11);
            _$insertNode(_el$1, _el$12);
            _$setProp(_el$1, "flexDirection", "row");
            _$insert(_el$10, () => selected() ? "\u203A" : " ");
            _$insert(_el$11, () => taskStatusMarker(status()));
            _$insert(_el$12, () => ` ${terminalLine().label}`);
            _$insert(_el$13, () => `    \u21B3 ${CLOCK_ICON} ${terminalLine().meta}`);
            _$insert(_el$0, _$createComponent(Show, {
              get when() {
                return modelLine();
              },
              children: (metadata) => (() => {
                var _el$14 = _$createElement("text");
                _$insert(_el$14, () => `    ${metadata()}`);
                _$effect((_$p) => _$setProp(_el$14, "fg", props.theme.textMuted, _$p));
                return _el$14;
              })()
            }), null);
            _$effect((_p$) => {
              var _v$13 = selected() ? props.theme.accent : props.theme.textMuted, _v$14 = statusColor2(status(), props.theme), _v$15 = selected() ? props.theme.text : muted() ? props.theme.textMuted : props.theme.text, _v$16 = emphasized() ? props.theme.text : props.theme.textMuted;
              _v$13 !== _p$.e && (_p$.e = _$setProp(_el$10, "fg", _v$13, _p$.e));
              _v$14 !== _p$.t && (_p$.t = _$setProp(_el$11, "fg", _v$14, _p$.t));
              _v$15 !== _p$.a && (_p$.a = _$setProp(_el$12, "fg", _v$15, _p$.a));
              _v$16 !== _p$.o && (_p$.o = _$setProp(_el$13, "fg", _v$16, _p$.o));
              return _p$;
            }, {
              e: void 0,
              t: void 0,
              a: void 0,
              o: void 0
            });
            return _el$0;
          })();
        },
        get children() {
          var _el$2 = _$createElement("box"), _el$3 = _$createElement("box"), _el$4 = _$createElement("text"), _el$5 = _$createElement("text"), _el$6 = _$createElement("text"), _el$7 = _$createElement("box"), _el$8 = _$createElement("text");
          _$insertNode(_el$2, _el$3);
          _$insertNode(_el$2, _el$7);
          _$setProp(_el$2, "flexDirection", "column");
          _$insertNode(_el$3, _el$4);
          _$insertNode(_el$3, _el$5);
          _$insertNode(_el$3, _el$6);
          _$setProp(_el$3, "flexDirection", "row");
          _$insert(_el$4, () => selected() ? "\u203A" : " ");
          _$insert(_el$5, () => taskStatusMarker(status()));
          _$insert(_el$6, () => ` ${line().labelLines[0] ?? ""}`);
          _$insert(_el$2, _$createComponent(Show, {
            get when() {
              return line().secondaryLine;
            },
            children: (secondaryLine) => (() => {
              var _el$15 = _$createElement("text");
              _$insert(_el$15, () => `    ${secondaryLine()}`);
              _$effect((_$p) => _$setProp(_el$15, "fg", muted() ? props.theme.textMuted : props.theme.text, _$p));
              return _el$15;
            })()
          }), _el$7);
          _$insertNode(_el$7, _el$8);
          _$setProp(_el$7, "flexDirection", "row");
          _$setProp(_el$7, "paddingLeft", 4);
          _$insert(_el$8, () => `\u21B3 ${CLOCK_ICON} ${line().elapsed}`);
          _$insert(_el$7, _$createComponent(Show, {
            get when() {
              return line().meta.length > 0;
            },
            get children() {
              var _el$9 = _$createElement("text");
              _$insert(_el$9, () => ` ${TOKEN_ICON} ${line().meta}`);
              _$effect((_$p) => _$setProp(_el$9, "fg", emphasized() ? props.theme.text : props.theme.textMuted, _$p));
              return _el$9;
            }
          }), null);
          _$insert(_el$7, _$createComponent(Show, {
            get when() {
              return line().tps.length > 0;
            },
            get children() {
              var _el$tps = _$createElement("text");
              _$insert(_el$tps, () => ` ${line().tps}`);
              _$effect((_$p) => _$setProp(_el$tps, "fg", emphasized() ? props.theme.text : props.theme.textMuted, _$p));
              return _el$tps;
            }
          }), null);
          _$insert(_el$2, _$createComponent(Show, {
            get when() {
              return modelLine();
            },
            children: (metadata) => (() => {
              var _el$16 = _$createElement("text");
              _$insert(_el$16, () => `    ${metadata()}`);
              _$effect((_$p) => _$setProp(_el$16, "fg", props.theme.textMuted, _$p));
              return _el$16;
            })()
          }), null);
          _$effect((_p$) => {
            var _v$ = selected() ? props.theme.accent : props.theme.textMuted, _v$2 = statusColor2(status(), props.theme), _v$3 = selected() ? props.theme.text : muted() ? props.theme.textMuted : props.theme.text, _v$4 = emphasized() ? props.theme.text : props.theme.textMuted;
            _v$ !== _p$.e && (_p$.e = _$setProp(_el$4, "fg", _v$, _p$.e));
            _v$2 !== _p$.t && (_p$.t = _$setProp(_el$5, "fg", _v$2, _p$.t));
            _v$3 !== _p$.a && (_p$.a = _$setProp(_el$6, "fg", _v$3, _p$.a));
            _v$4 !== _p$.o && (_p$.o = _$setProp(_el$8, "fg", _v$4, _p$.o));
            return _p$;
          }, {
            e: void 0,
            t: void 0,
            a: void 0,
            o: void 0
          });
          return _el$2;
        }
      }));
      _$effect((_p$) => {
        var _v$5 = rowHeight(), _v$6 = rowOpacity(), _v$7 = selected() ? props.theme.backgroundElement : void 0, _v$8 = clickable() ? () => setHovered(true) : void 0, _v$9 = clickable() ? () => {
          setHovered(false);
          setFocused(false);
          setMouseDownChildID(void 0);
        } : void 0, _v$0 = clickable() ? (event) => {
          event.stopPropagation();
          setSelectedChildID(rowProps.childID);
          setMouseDownChildID(rowProps.childID);
        } : void 0, _v$1 = clickable() ? (event) => {
          if (mouseDownChildID() === rowProps.childID) {
            event.stopPropagation();
            activate();
          }
          setMouseDownChildID(void 0);
        } : void 0, _v$10 = clickable() ? handleKeyDown : void 0, _v$11 = clickable(), _v$12 = clickable() && focused();
        _v$5 !== _p$.e && (_p$.e = _$setProp(_el$, "height", _v$5, _p$.e));
        _v$6 !== _p$.t && (_p$.t = _$setProp(_el$, "opacity", _v$6, _p$.t));
        _v$7 !== _p$.a && (_p$.a = _$setProp(_el$, "backgroundColor", _v$7, _p$.a));
        _v$8 !== _p$.o && (_p$.o = _$setProp(_el$, "onMouseOver", _v$8, _p$.o));
        _v$9 !== _p$.i && (_p$.i = _$setProp(_el$, "onMouseOut", _v$9, _p$.i));
        _v$0 !== _p$.n && (_p$.n = _$setProp(_el$, "onMouseDown", _v$0, _p$.n));
        _v$1 !== _p$.s && (_p$.s = _$setProp(_el$, "onMouseUp", _v$1, _p$.s));
        _v$10 !== _p$.h && (_p$.h = _$setProp(_el$, "onKeyDown", _v$10, _p$.h));
        _v$11 !== _p$.r && (_p$.r = _$setProp(_el$, "focusable", _v$11, _p$.r));
        _v$12 !== _p$.d && (_p$.d = _$setProp(_el$, "focused", _v$12, _p$.d));
        return _p$;
      }, {
        e: void 0,
        t: void 0,
        a: void 0,
        o: void 0,
        i: void 0,
        n: void 0,
        s: void 0,
        h: void 0,
        r: void 0,
        d: void 0
      });
      return _el$;
    })();
  };
  const AggregateBar = () => (() => {
    var _el$17 = _$createElement("box"), _el$18 = _$createElement("text"), _el$19 = _$createElement("text"), _el$21 = _$createElement("text"), _el$22 = _$createElement("text"), _el$24 = _$createElement("text"), _el$25 = _$createElement("text"), _el$27 = _$createElement("text");
    _$insertNode(_el$17, _el$18);
    _$insertNode(_el$17, _el$19);
    _$insertNode(_el$17, _el$21);
    _$insertNode(_el$17, _el$22);
    _$insertNode(_el$17, _el$24);
    _$insertNode(_el$17, _el$25);
    _$insertNode(_el$17, _el$27);
    _$setProp(_el$17, "flexDirection", "row");
    _$setProp(_el$17, "paddingRight", 1);
    _$insert(_el$18, () => `\u25CF ${counts().running} run`);
    _$insertNode(_el$19, _$createTextNode(` \xB7 `));
    _$insert(_el$21, () => `\u2713 ${counts().done} done`);
    _$insertNode(_el$22, _$createTextNode(` \xB7 `));
    _$insert(_el$24, () => `\u2715 ${counts().error} err`);
    _$insertNode(_el$25, _$createTextNode(` \xB7 `));
    _$setProp(_el$27, "selectable", false);
    _$setProp(_el$27, "onMouseDown", toggleCompletedHistory);
    _$insert(_el$27, () => `\u03A3 ${totalExecuted()}`);
    _$effect((_p$) => {
      var _v$17 = props.theme.warning, _v$18 = props.theme.textMuted, _v$19 = props.theme.success, _v$20 = props.theme.textMuted, _v$21 = props.theme.error, _v$22 = props.theme.textMuted, _v$23 = showCompletedHistory() ? props.theme.accent : props.theme.text;
      _v$17 !== _p$.e && (_p$.e = _$setProp(_el$18, "fg", _v$17, _p$.e));
      _v$18 !== _p$.t && (_p$.t = _$setProp(_el$19, "fg", _v$18, _p$.t));
      _v$19 !== _p$.a && (_p$.a = _$setProp(_el$21, "fg", _v$19, _p$.a));
      _v$20 !== _p$.o && (_p$.o = _$setProp(_el$22, "fg", _v$20, _p$.o));
      _v$21 !== _p$.i && (_p$.i = _$setProp(_el$24, "fg", _v$21, _p$.i));
      _v$22 !== _p$.n && (_p$.n = _$setProp(_el$25, "fg", _v$22, _p$.n));
      _v$23 !== _p$.s && (_p$.s = _$setProp(_el$27, "fg", _v$23, _p$.s));
      return _p$;
    }, {
      e: void 0,
      t: void 0,
      a: void 0,
      o: void 0,
      i: void 0,
      n: void 0,
      s: void 0
    });
    return _el$17;
  })();
  return (() => {
    var _el$28 = _$createElement("box"), _el$29 = _$createElement("box"), _el$30 = _$createElement("text");
    _$insertNode(_el$28, _el$29);
    _$use((element) => {
      listContainer = element;
      if (!element) setListFocused(false);
    }, _el$28);
    _$setProp(_el$28, "flexDirection", "column");
    _$setProp(_el$28, "focusable", true);
    _$setProp(_el$28, "renderBefore", () => {
      refreshListFocused();
      restorePreservedScroll();
    });
    _$insertNode(_el$29, _el$30);
    _$setProp(_el$29, "flexDirection", "row");
    _$setProp(_el$30, "selectable", false);
    _$insert(_el$30, () => `${props.expanded() ? SIDEBAR_ARROW_EXPANDED : SIDEBAR_ARROW_COLLAPSED} ${t("subagents")}`);
    _$insert(_el$29, _$createComponent(Show, {
      when: PLUGIN_VERSION,
      children: (version) => (() => {
        var _el$33 = _$createElement("box"), _el$34 = _$createElement("text");
        _$insertNode(_el$33, _el$34);
        _$setProp(_el$33, "flexDirection", "row");
        _$setProp(_el$34, "opacity", 0.7);
        _$setProp(_el$34, "selectable", false);
        _$insert(_el$34, () => ` ${version()}`);
        _$insert(_el$33, _$createComponent(Show, {
          get when() {
            return listFocused();
          },
          get children() {
            var _el$35 = _$createElement("text");
            _$insertNode(_el$35, _$createTextNode(` \u25CF`));
            _$setProp(_el$35, "selectable", false);
            _$effect((_p$) => {
              var _v$28 = props.theme.accent, _v$29 = props.onToggleExpanded;
              _v$28 !== _p$.e && (_p$.e = _$setProp(_el$35, "fg", _v$28, _p$.e));
              _v$29 !== _p$.t && (_p$.t = _$setProp(_el$35, "onMouseDown", _v$29, _p$.t));
              return _p$;
            }, {
              e: void 0,
              t: void 0
            });
            return _el$35;
          }
        }), null);
        _$effect((_p$) => {
          var _v$30 = props.theme.textMuted, _v$31 = props.onToggleExpanded;
          _v$30 !== _p$.e && (_p$.e = _$setProp(_el$34, "fg", _v$30, _p$.e));
          _v$31 !== _p$.t && (_p$.t = _$setProp(_el$34, "onMouseDown", _v$31, _p$.t));
          return _p$;
        }, {
          e: void 0,
          t: void 0
        });
        return _el$33;
      })()
    }), null);
    _$insert(_el$28, _$createComponent(AggregateBar, {}), null);
    _$insert(_el$28, _$createComponent(Show, {
      get when() {
        return props.expanded();
      },
      get children() {
        var _el$31 = _$createElement("scrollbox"), _el$32 = _$createElement("box");
        _$insertNode(_el$31, _el$32);
        _$use((element) => {
          scrollbox = element;
          restorePreservedScroll();
        }, _el$31);
        _$setProp(_el$31, "scrollY", true);
        _$setProp(_el$31, "viewportCulling", false);
        _$setProp(_el$32, "flexDirection", "column");
        _$setProp(_el$32, "rowGap", 0);
        _$insert(_el$32, _$createComponent(For, {
          get each() {
            return visibleChildIDs();
          },
          children: (childID) => _$createComponent(ChildRow, {
            childID
          })
        }));
        _$effect((_$p) => _$setProp(_el$31, "height", listHeight(), _$p));
        return _el$31;
      }
    }), null);
    _$effect((_p$) => {
      var _v$24 = listFocused() ? props.theme.backgroundPanel : void 0, _v$25 = listFocused(), _v$26 = props.theme.text, _v$27 = props.onToggleExpanded;
      _v$24 !== _p$.e && (_p$.e = _$setProp(_el$28, "backgroundColor", _v$24, _p$.e));
      _v$25 !== _p$.t && (_p$.t = _$setProp(_el$28, "focused", _v$25, _p$.t));
      _v$26 !== _p$.a && (_p$.a = _$setProp(_el$30, "fg", _v$26, _p$.a));
      _v$27 !== _p$.o && (_p$.o = _$setProp(_el$30, "onMouseDown", _v$27, _p$.o));
      return _p$;
    }, {
      e: void 0,
      t: void 0,
      a: void 0,
      o: void 0
    });
    return _el$28;
  })();
}
function HomeBottomStatus(props) {
  const snapshot = createMemo(() => resolveTuiSubagentSnapshot({
    state: props.state()
  }));
  const counts = createMemo(() => snapshot().visibleCounts);
  const totalExecuted = createMemo(() => snapshot().totalExecuted);
  const visible = createMemo(() => counts().running > 0 || counts().error > 0 || totalExecuted() > 0);
  return _$createComponent(Show, {
    get when() {
      return visible();
    },
    get children() {
      var _el$37 = _$createElement("box"), _el$38 = _$createElement("box"), _el$39 = _$createElement("text"), _el$40 = _$createElement("text"), _el$42 = _$createElement("text"), _el$43 = _$createElement("text"), _el$45 = _$createElement("text"), _el$46 = _$createElement("text"), _el$48 = _$createElement("text");
      _$insertNode(_el$37, _el$38);
      _$setProp(_el$37, "paddingLeft", 1);
      _$setProp(_el$37, "paddingRight", 1);
      _$insertNode(_el$38, _el$39);
      _$insertNode(_el$38, _el$40);
      _$insertNode(_el$38, _el$42);
      _$insertNode(_el$38, _el$43);
      _$insertNode(_el$38, _el$45);
      _$insertNode(_el$38, _el$46);
      _$insertNode(_el$38, _el$48);
      _$setProp(_el$38, "flexDirection", "row");
      _$insert(_el$39, () => `\u25CF ${counts().running}`);
      _$insertNode(_el$40, _$createTextNode(` \xB7 `));
      _$insert(_el$42, () => `\u2713 ${counts().done}`);
      _$insertNode(_el$43, _$createTextNode(` \xB7 `));
      _$insert(_el$45, () => `\u2715 ${counts().error}`);
      _$insertNode(_el$46, _$createTextNode(` \xB7 `));
      _$insert(_el$48, () => `\u03A3 ${totalExecuted()}`);
      _$effect((_p$) => {
        var _v$32 = props.theme.warning, _v$33 = props.theme.textMuted, _v$34 = props.theme.success, _v$35 = props.theme.textMuted, _v$36 = props.theme.error, _v$37 = props.theme.textMuted, _v$38 = props.theme.text;
        _v$32 !== _p$.e && (_p$.e = _$setProp(_el$39, "fg", _v$32, _p$.e));
        _v$33 !== _p$.t && (_p$.t = _$setProp(_el$40, "fg", _v$33, _p$.t));
        _v$34 !== _p$.a && (_p$.a = _$setProp(_el$42, "fg", _v$34, _p$.a));
        _v$35 !== _p$.o && (_p$.o = _$setProp(_el$43, "fg", _v$35, _p$.o));
        _v$36 !== _p$.i && (_p$.i = _$setProp(_el$45, "fg", _v$36, _p$.i));
        _v$37 !== _p$.n && (_p$.n = _$setProp(_el$46, "fg", _v$37, _p$.n));
        _v$38 !== _p$.s && (_p$.s = _$setProp(_el$48, "fg", _v$38, _p$.s));
        return _p$;
      }, {
        e: void 0,
        t: void 0,
        a: void 0,
        o: void 0,
        i: void 0,
        n: void 0,
        s: void 0
      });
      return _el$37;
    }
  });
}
function AppBottomStatus(props) {
  const dims = useTerminalDimensions();
  const collapsed = createMemo(() => dims().width <= 120);
  return _$createComponent(Show, {
    get when() {
      return collapsed();
    },
    get children() {
      return _$createComponent(HomeBottomStatus, {
        state: props.state,
        get theme() {
          return props.theme;
        }
      });
    }
  });
}
async function hydratePreviousSubagents(api, currentSessionID, statePath, textPath, setState) {
  if (!currentSessionID) return false;
  try {
    const directory = api.state.path.directory;
    const sessionClient = api.client.session;
    let topLevelHydrationFailed = false;
    let statusHydrationFailed = false;
    let parentMessageHydrationFailed = false;
    const [childrenResp, messagesResp, statusResp] = await Promise.all([(async () => {
      const response = await safeReadAsync(() => sessionClient?.children?.({
        sessionID: currentSessionID,
        directory
      }) ?? Promise.resolve({
        data: []
      }));
      if (!response) topLevelHydrationFailed = true;
      return response;
    })(), (async () => {
      const response = await safeReadAsync(() => sessionClient?.messages?.({
        sessionID: currentSessionID,
        directory
      }) ?? Promise.resolve({
        data: []
      }));
      if (!response) {
        topLevelHydrationFailed = true;
        parentMessageHydrationFailed = true;
      }
      return response;
    })(), (async () => {
      const response = await safeReadAsync(() => sessionClient?.status?.({
        directory
      }) ?? Promise.resolve({
        data: {}
      }));
      if (!response) {
        topLevelHydrationFailed = true;
        statusHydrationFailed = true;
      }
      return response;
    })()]);
    const children = Array.isArray(childrenResp?.data) ? childrenResp.data : [];
    const messages = Array.isArray(messagesResp?.data) ? messagesResp.data : [];
    const allStatuses = asRecord2(statusResp?.data) ?? {};
    const parentTaskEvidenceByChildID = collectParentTaskEvidenceByChildSessionID(messages, currentSessionID);
    let childHydrationFailed = false;
    const childMessageResults = await Promise.all(children.map(async (child) => {
      const session = asRecord2(child);
      const childID = typeof session?.id === "string" ? session.id : void 0;
      if (!childID) {
        return {
          childID: void 0,
          completedAt: void 0,
          evidenceAt: void 0,
          hasError: false,
          fetchFailed: false
        };
      }
      const childMessagesResp = await safeReadAsync(() => sessionClient?.messages?.({
        sessionID: childID,
        directory
      }) ?? Promise.resolve({
        data: []
      }));
      let fetchFailed = false;
      if (!childMessagesResp) {
        childHydrationFailed = true;
        fetchFailed = true;
      }
      const childMessages = Array.isArray(childMessagesResp?.data) ? childMessagesResp.data : [];
      return {
        childID,
        ...summarizeSessionMessages(childMessages),
        model: extractLatestAssistantModel(childMessages),
        fetchFailed
      };
    }));
    const childMessageSummaryByID = new Map(childMessageResults.filter((result) => result.childID).map((result) => [result.childID, result]));
    snapshotSidebarScrollOffsets();
    setState((current) => {
      const next = cloneState(current);
      let changed = false;
      for (const rawSession of children) {
        const session = asRecord2(rawSession);
        if (!session || typeof session.id !== "string") continue;
        const status = allStatuses[session.id];
        const sessionStatus = deriveSessionChildStatus(status);
        const childSummary = childMessageSummaryByID.get(session.id);
        const hasHydrationEvidence = shouldHydrateSessionChild({
          childID: session.id,
          sessionStatus,
          childSummary,
          parentTaskEvidenceByChildID
        });
        const parentTaskEvidence = parentTaskEvidenceByChildID.get(session.id);
        const explicitCompletionEvidence = !!childSummary && !childSummary.fetchFailed && (typeof childSummary.completedAt === "string" || childSummary.hasError);
        const fallbackEndedAt = childSummary?.completedAt ?? childSummary?.evidenceAt;
        const statusEndedAt = fallbackEndedAt ?? sessionTimestamp(session, "completed") ?? sessionTimestamp(session, "updated");
        const shouldHydrateChildFromSession = hasHydrationEvidence;
        if (!shouldHydrateChildFromSession) {
          const existing = next.children[session.id];
          if (!statusHydrationFailed && !parentMessageHydrationFailed && !!childSummary && !childSummary.fetchFailed && existing?.parentID === currentSessionID && existing.source === "session" && existing.status === "running") {
            delete next.children[session.id];
            changed = true;
          }
          continue;
        }
        const fakeEvent = {
          type: "session.created",
          properties: {
            sessionID: session.id,
            info: session
          }
        };
        if (applySubagentEvent(next, fakeEvent)) changed = true;
        if (childSummary?.model) {
          changed = setChildModel(next, session.id, childSummary.model.model, childSummary.model.updatedAt) || changed;
        }
        const resolvedStatus = resolveSessionStatusWithMessageSummary({
          status: sessionStatus ?? parentTaskEvidence?.status,
          summary: childSummary
        });
        if (resolvedStatus.status === "done" || resolvedStatus.status === "error") {
          if (markChildStatus(next, session.id, resolvedStatus.status, resolvedStatus.endedAt ?? parentTaskEvidence?.endedAt ?? statusEndedAt)) changed = true;
          continue;
        }
        if (!sessionStatus && !statusHydrationFailed && explicitCompletionEvidence) {
          const childStatus = childSummary?.hasError ? "error" : "done";
          if (markChildStatus(next, session.id, childStatus, fallbackEndedAt)) changed = true;
        }
      }
      for (const rawMessage of messages) {
        const message = asRecord2(rawMessage);
        const info = asRecord2(message?.info);
        const parts = Array.isArray(message?.parts) ? message.parts : [];
        const parentMessageID = messageIDOf(message);
        const isAssistant = info?.role === "assistant";
        const time = asRecord2(info?.time);
        const eventInfo = {
          id: typeof info?.id === "string" ? info.id : void 0,
          role: typeof info?.role === "string" ? info.role : void 0,
          parentID: typeof info?.parentID === "string" ? info.parentID : void 0,
          time
        };
        const completedAt = timestampFromUnknown2(time?.completed);
        const isCompleted = typeof completedAt === "string";
        const hasError = !!info?.error;
        for (const rawPart of parts) {
          const part = asRecord2(rawPart);
          if (!part) continue;
          const partWithMessageID = typeof part.messageID === "string" && part.messageID.length > 0 ? part : parentMessageID ? {
            ...part,
            messageID: parentMessageID
          } : part;
          if (part.type === "subtask" || part.type === "tool" && (part.tool === "delegate" || part.tool === "task")) {
            const fakeEvent = {
              type: "message.part.updated",
              properties: {
                sessionID: currentSessionID,
                info: eventInfo,
                part: partWithMessageID
              }
            };
            if (applySubagentEvent(next, fakeEvent)) changed = true;
            if (part.type === "subtask" && isAssistant && isCompleted) {
              const childID = `subtask:${part.id}`;
              const status = hasError ? "error" : "done";
              if (markChildStatus(next, childID, status, completedAt)) changed = true;
            }
          }
        }
      }
      if (backfillHydratedTargetSessionIDs(next, currentSessionID)) {
        changed = true;
      }
      const refreshed = refreshLiveState(next);
      if (!changed && !refreshed) return current;
      persistStateSnapshot(statePath, textPath, next);
      return next;
    });
    if (topLevelHydrationFailed || childHydrationFailed) return false;
    return true;
  } catch (err) {
    debugLog({
      kind: "hydration.error",
      sessionID: currentSessionID,
      error: String(err)
    });
    return false;
  }
}
function shouldHydrateSessionChild(input) {
  if (input.sessionStatus) return true;
  if (input.parentTaskEvidenceByChildID.has(input.childID)) return true;
  const summary = input.childSummary;
  if (!summary || summary.fetchFailed) return false;
  return summary.hasError === true || typeof summary.completedAt === "string" || typeof summary.evidenceAt === "string" || typeof summary.latestAssistantActivityAt === "string" || typeof summary.latestMessageActivityAt === "string";
}
function collectParentTaskEvidenceByChildSessionID(messages, parentSessionID) {
  const evidenceByID = /* @__PURE__ */ new Map();
  for (const rawMessage of messages) {
    const message = asRecord2(rawMessage);
    const info = asRecord2(message?.info);
    const parts = Array.isArray(message?.parts) ? message.parts : [];
    for (const rawPart of parts) {
      const part = asRecord2(rawPart);
      if (!part || part.type !== "tool" || part.tool !== "task") continue;
      const state = asRecord2(part.state);
      const metadata = asRecord2(state?.metadata);
      const childID = typeof metadata?.sessionId === "string" ? metadata.sessionId : void 0;
      if (!childID || childID === parentSessionID) continue;
      const taskEvidence = extractTaskToolEvidence({
        type: "message.part.updated",
        properties: {
          sessionID: parentSessionID,
          info: {
            time: info?.time
          },
          part: rawPart
        }
      });
      evidenceByID.set(childID, {
        status: taskEvidence?.status ?? "running",
        endedAt: taskEvidence?.endedAt
      });
    }
  }
  return evidenceByID;
}
async function safeReadAsync(read) {
  try {
    return await read();
  } catch {
    return void 0;
  }
}
function deriveSessionChildStatus(status) {
  return deriveOpenCodeSessionStatus(status);
}
function sessionTimestamp(session, key) {
  const time = asRecord2(session.time);
  return timestampFromUnknown2(time?.[key]);
}
function timestampFromUnknown2(value) {
  const millis = timestampMillisFromUnknown2(value);
  return millis === void 0 ? void 0 : new Date(millis).toISOString();
}
function timestampMillisFromUnknown2(value) {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? void 0 : parsed;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const millis = value < 1e10 ? value * 1e3 : value;
    const parsed = new Date(millis);
    return Number.isNaN(parsed.getTime()) ? void 0 : millis;
  }
  return void 0;
}
function resolveRouteSessionID(api) {
  return api.route.current.name === "session" && typeof api.route.current.params?.sessionID === "string" ? api.route.current.params.sessionID : void 0;
}
function resolveRunningChildAgeMillis(child, nowMs) {
  const startedMs = Date.parse(child.startedAt);
  const updatedMs = Date.parse(child.updatedAt);
  return {
    startedMs: Number.isNaN(startedMs) ? 0 : Math.max(0, nowMs - startedMs),
    updatedMs: Number.isNaN(updatedMs) ? 0 : Math.max(0, nowMs - updatedMs)
  };
}
function resolveReconcileTargetSessionID(state, child) {
  return resolveChildTargetSessionID(child) ?? resolveSyntheticTargetFromHydratedState(state, child);
}
function selectRunningReconcileCandidates(input) {
  const runningChildren = Object.values(input.state.children).filter((child) => child.status === "running");
  if (runningChildren.length === 0) return [];
  const prioritized = visibleSubagentWorkItems(runningChildren, input.nowMs).sort(byPriority);
  const prioritizedForSession = prioritized.filter((child) => input.currentSessionID ? child.parentID === input.currentSessionID : true);
  const veryOldIDs = new Set(runningChildren.filter((child) => {
    const age = resolveRunningChildAgeMillis(child, input.nowMs);
    return age.startedMs >= RUNNING_RECONCILE_OLD_CANDIDATE_AGE_MS || age.updatedMs >= RUNNING_RECONCILE_OLD_CANDIDATE_AGE_MS;
  }).map((child) => child.id));
  const ordered = [...prioritizedForSession, ...runningChildren.filter((child) => veryOldIDs.has(child.id))];
  const selected = [];
  const seen = /* @__PURE__ */ new Set();
  for (const child of ordered) {
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    const age = resolveRunningChildAgeMillis(child, input.nowMs);
    const targetSessionID = resolveReconcileTargetSessionID(input.state, child);
    const canProbePersistedSubtask = child.source === "subtask" && !targetSessionID && typeof child.parentID === "string" && child.parentID.length > 0 && typeof child.messageID === "string" && child.messageID.length > 0 && (age.startedMs >= RUNNING_RECONCILE_OLD_CANDIDATE_AGE_MS || age.updatedMs >= RUNNING_RECONCILE_OLD_CANDIDATE_AGE_MS);
    if (!targetSessionID && !canProbePersistedSubtask) continue;
    selected.push({
      childID: child.id,
      targetSessionID,
      parentID: child.parentID,
      messageID: child.messageID,
      source: child.source,
      title: child.title,
      summary: child.summary,
      agentName: child.agentName,
      startedMs: age.startedMs,
      updatedMs: age.updatedMs
    });
    if (selected.length >= input.maxCandidates) break;
  }
  return capCandidates(selected, input.maxCandidates);
}
async function probeRunningEvidence(input) {
  let probeFailed = false;
  const directStatus = safeRead2(() => input.api.state.session.status(input.targetSessionID));
  if (directStatus === void 0) probeFailed = true;
  const statusFromState = deriveSessionChildStatus(directStatus);
  if (statusFromState === "error") {
    return {
      status: statusFromState,
      endedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  if (statusFromState === "running") {
    return {
      status: "running",
      sawRunningEvidence: true
    };
  }
  const doneFromState = statusFromState === "done";
  let doneFromClient = false;
  const statusResp = await safeReadAsync(() => input.api.client.session.status({
    directory: input.directory
  }));
  if (statusResp === void 0) probeFailed = true;
  const statuses = asRecord2(statusResp?.data);
  const statusFromClient = deriveSessionChildStatus(statuses?.[input.targetSessionID]);
  if (statusFromClient === "error") {
    return {
      status: statusFromClient,
      endedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  if (statusFromClient === "running") {
    return {
      status: "running",
      sawRunningEvidence: true
    };
  }
  doneFromClient = statusFromClient === "done";
  const hasDoneStatus = doneFromState || doneFromClient;
  if (!hasDoneStatus && input.candidateAgeMs < RUNNING_RECONCILE_MESSAGE_AGE_GATE_MS) {
    return {
      probeFailed,
      canApplyStaleFallback: false
    };
  }
  const messagesResp = await safeReadAsync(() => input.api.client.session.messages({
    sessionID: input.targetSessionID,
    directory: input.directory
  }));
  if (messagesResp === void 0 || !Array.isArray(messagesResp?.data)) {
    if (hasDoneStatus) {
      return {
        status: "done",
        endedAt: (/* @__PURE__ */ new Date()).toISOString(),
        checkedMessages: false,
        probeFailed: true,
        canApplyStaleFallback: false
      };
    }
    return {
      checkedMessages: false,
      probeFailed: true,
      canApplyStaleFallback: false
    };
  }
  const messages = Array.isArray(messagesResp?.data) ? messagesResp.data : [];
  const summary = summarizeSessionMessages(messages);
  const resolvedStatus = resolveSessionStatusWithMessageSummary({
    status: hasDoneStatus ? "done" : void 0,
    summary
  });
  if (resolvedStatus.status === "error") {
    return {
      status: "error",
      endedAt: resolvedStatus.endedAt,
      checkedMessages: true,
      canApplyStaleFallback: false
    };
  }
  if (resolvedStatus.status === "done") {
    return {
      status: "done",
      endedAt: resolvedStatus.endedAt ?? (/* @__PURE__ */ new Date()).toISOString(),
      checkedMessages: true,
      canApplyStaleFallback: false
    };
  }
  if (hasRecentMessageActivity({
    nowMs: input.nowMs,
    latestMessageActivityAtMs: summary.latestMessageActivityAtMs,
    staleThresholdMs: STALE_RUNNING_THRESHOLD_MS
  })) {
    return {
      checkedMessages: true,
      sawRunningEvidence: true,
      endedAt: summary.latestMessageActivityAt,
      probeFailed,
      canApplyStaleFallback: false
    };
  }
  return {
    checkedMessages: true,
    probeFailed,
    canApplyStaleFallback: !probeFailed
  };
}
function initializeTui(api, disposeRoot) {
  const statePath = resolveStatePath();
  const textPath = resolveTextPath(statePath);
  const [state, setState] = createSignal(createEmptyState());
  const [nowMs, setNowMs] = createSignal(Date.now());
  const [hydratedSessions, setHydratedSessions] = createSignal(/* @__PURE__ */ new Set());
  const [hydratingSessions, setHydratingSessions] = createSignal(/* @__PURE__ */ new Set());
  const [hydrateRetryPendingSessions, setHydrateRetryPendingSessions] = createSignal(/* @__PURE__ */ new Set());
  const [hydrateRetryAttempts, setHydrateRetryAttempts] = createSignal(/* @__PURE__ */ new Map());
  const [hydrateRetryTick, setHydrateRetryTick] = createSignal(0);
  const [subagentsExpanded, setSubagentsExpanded] = createSignal(api.kv.get(SUBAGENTS_EXPANDED_KV_KEY, true) !== false);
  const [subagentsSectionEnabled, setSubagentsSectionEnabled] = createSignal(api.kv.get(SUBAGENTS_SECTION_ENABLED_KV_KEY, true) !== false);
  const hydrateRetryTimeouts = /* @__PURE__ */ new Map();
  const runningReconcileBackoff = /* @__PURE__ */ new Map();
  let reconcileInFlight = false;
  let lastRunningReconcileAtMs = 0;
  let disposed = false;
  let previousRouteSessionID;
  let pendingSidebarRefocus;
  let pendingRefocusConsumed = false;
  let activePromptRef;
  const consumePendingSidebarRefocus = () => {
    if (pendingRefocusConsumed) return void 0;
    pendingRefocusConsumed = true;
    return pendingSidebarRefocus;
  };
  const setActivePromptRef = (ref) => {
    activePromptRef = ref;
  };
  const composePromptRef = (slotRef) => {
    return (ref) => {
      setActivePromptRef(ref);
      if (typeof slotRef === "function") {
        slotRef(ref);
      } else if (slotRef && "current" in slotRef) {
        slotRef.current = ref;
      }
    };
  };
  const focusActivePrompt = () => {
    focusPromptWithDeferredRetry(() => {
      if (!activePromptRef) return false;
      activePromptRef.focus();
      return true;
    });
  };
  const rememberSidebarChildNavigation = (input) => {
    pendingSidebarRefocus = input;
  };
  const setSubagentsExpandedPreference = (expanded) => {
    setSubagentsExpanded(expanded);
    api.kv.set(SUBAGENTS_EXPANDED_KV_KEY, expanded);
    api.ui.toast({
      variant: "info",
      message: expanded ? "Subagent list expanded" : "Subagent list collapsed"
    });
  };
  const setSubagentsExpandedSilently = (expanded) => {
    setSubagentsExpanded(expanded);
    api.kv.set(SUBAGENTS_EXPANDED_KV_KEY, expanded);
  };
  const setSubagentsSectionEnabledPreference = (enabled) => {
    setSubagentsSectionEnabled(enabled);
    api.kv.set(SUBAGENTS_SECTION_ENABLED_KV_KEY, enabled);
    api.ui.toast({
      variant: "info",
      message: enabled ? "Subagent section enabled" : "Subagent section disabled"
    });
  };
  const toggleSidebarListFocus = () => {
    api.ui.dialog.clear();
    if (isAnySidebarSubagentListFocused()) {
      blurVisibleSidebarSubagentList();
      focusActivePrompt();
      return;
    }
    setSubagentsSectionEnabled(true);
    setSubagentsExpanded(true);
    api.kv.set(SUBAGENTS_SECTION_ENABLED_KV_KEY, true);
    api.kv.set(SUBAGENTS_EXPANDED_KV_KEY, true);
    setTimeout(() => {
      focusVisibleSidebarSubagentList();
    }, 0);
  };
  const toggleSidebarCompletedHistory = () => {
    api.ui.dialog.clear();
    setSubagentsSectionEnabled(true);
    setSubagentsExpanded(true);
    api.kv.set(SUBAGENTS_SECTION_ENABLED_KV_KEY, true);
    api.kv.set(SUBAGENTS_EXPANDED_KV_KEY, true);
    setTimeout(() => {
      toggleVisibleSidebarCompletedHistory();
    }, 0);
  };
  const commandDispose = registerSubagentCommands({
    api,
    sectionEnabled: subagentsSectionEnabled,
    toggleSection: setSubagentsSectionEnabledPreference,
    focusSidebarList: toggleSidebarListFocus,
    toggleCompletedHistory: toggleSidebarCompletedHistory
  });
  const clearHydrateRetryTimeout = (sessionID) => {
    const timeout = hydrateRetryTimeouts.get(sessionID);
    if (timeout) {
      clearTimeout(timeout);
      hydrateRetryTimeouts.delete(sessionID);
    }
  };
  const resetHydrateRetry = (sessionID) => {
    if (!sessionID) return;
    clearHydrateRetryTimeout(sessionID);
    setHydrateRetryPendingSessions((prev) => {
      if (!prev.has(sessionID)) return prev;
      const next = new Set(prev);
      next.delete(sessionID);
      return next;
    });
    setHydrateRetryAttempts((prev) => {
      if (!prev.has(sessionID)) return prev;
      const next = new Map(prev);
      next.delete(sessionID);
      return next;
    });
  };
  createEffect(() => {
    hydrateRetryTick();
    void api.route.current;
    const routeSessionID = resolveRouteSessionID(api);
    if (previousRouteSessionID && previousRouteSessionID !== routeSessionID) {
      resetHydrateRetry(previousRouteSessionID);
    }
    const siblingRefocus = resolveSiblingSidebarRefocus({
      pendingSidebarRefocus,
      routeSessionID,
      children: state().children
    });
    if (siblingRefocus && pendingSidebarRefocus) {
      pendingSidebarRefocus = {
        ...pendingSidebarRefocus,
        ...siblingRefocus
      };
    }
    const sidebarReturnAction = resolveSidebarReturnFocusAction({
      pendingSidebarRefocus,
      previousRouteSessionID,
      routeSessionID
    });
    pendingRefocusConsumed = false;
    if (sidebarReturnAction === "focus-prompt") {
      blurVisibleSidebarSubagentList();
      focusActivePrompt();
    } else if (sidebarReturnAction === "clear-pending") {
      pendingSidebarRefocus = void 0;
    }
    previousRouteSessionID = routeSessionID;
    if (!routeSessionID) return;
    const sessionID = routeSessionID;
    if (hydratedSessions().has(sessionID) || hydratingSessions().has(sessionID) || hydrateRetryPendingSessions().has(sessionID)) {
      return;
    }
    setHydratingSessions((prev) => {
      const next = new Set(prev);
      next.add(sessionID);
      return next;
    });
    void (async () => {
      const finishHydrating = () => {
        setHydratingSessions((prev) => {
          const next = new Set(prev);
          next.delete(sessionID);
          return next;
        });
      };
      const hydrated = await hydratePreviousSubagents(api, sessionID, statePath, textPath, setState);
      if (disposed) {
        clearHydrateRetryTimeout(sessionID);
        finishHydrating();
        return;
      }
      if (hydrated) {
        resetHydrateRetry(sessionID);
        setHydratedSessions((prev) => {
          const next = new Set(prev);
          next.add(sessionID);
          return next;
        });
        finishHydrating();
        return;
      }
      const attempts = hydrateRetryAttempts().get(sessionID) ?? 0;
      const delayMs = Math.min(HYDRATE_RETRY_MAX_DELAY_MS, HYDRATE_RETRY_BASE_DELAY_MS * 2 ** attempts);
      setHydrateRetryAttempts((prev) => {
        const next = new Map(prev);
        next.set(sessionID, Math.min(attempts + 1, HYDRATE_RETRY_MAX_ATTEMPTS));
        return next;
      });
      setHydrateRetryPendingSessions((prev) => {
        const next = new Set(prev);
        next.add(sessionID);
        return next;
      });
      finishHydrating();
      clearHydrateRetryTimeout(sessionID);
      const timeout = setTimeout(() => {
        hydrateRetryTimeouts.delete(sessionID);
        setHydrateRetryPendingSessions((prev) => {
          if (!prev.has(sessionID)) return prev;
          const next = new Set(prev);
          next.delete(sessionID);
          return next;
        });
        if (disposed) return;
        setHydrateRetryTick((value) => value + 1);
      }, delayMs);
      hydrateRetryTimeouts.set(sessionID, timeout);
    })();
  });
  const reconcileRunningChildren = async () => {
    if (reconcileInFlight || disposed) return;
    reconcileInFlight = true;
    lastRunningReconcileAtMs = Date.now();
    try {
      const snapshot = cloneState(state());
      const nowMs2 = Date.now();
      const currentSessionID = resolveRouteSessionID(api);
      const directory = api.state.path.directory;
      const selected = selectRunningReconcileCandidates({
        state: snapshot,
        currentSessionID,
        nowMs: nowMs2,
        maxCandidates: RUNNING_RECONCILE_MAX_CANDIDATES
      });
      const mutations = [];
      const parentMessagesCache = /* @__PURE__ */ new Map();
      for (const candidate of selected) {
        const key = candidate.targetSessionID ?? candidate.childID;
        const cache = runningReconcileBackoff.get(key);
        if (shouldSkipCandidateForBackoff(cache, nowMs2)) continue;
        if (!candidate.targetSessionID) {
          const isPersistedSubtaskCandidate = candidate.source === "subtask" && typeof candidate.parentID === "string" && candidate.parentID.length > 0 && typeof candidate.messageID === "string" && candidate.messageID.length > 0;
          if (!isPersistedSubtaskCandidate) continue;
          const parentSessionID = candidate.parentID;
          let parentMessages = parentMessagesCache.get(parentSessionID);
          if (parentMessages === void 0) {
            const parentMessagesResp = await safeReadAsync(() => api.client.session.messages({
              sessionID: parentSessionID,
              directory
            }));
            parentMessages = Array.isArray(parentMessagesResp?.data) ? parentMessagesResp.data : null;
            parentMessagesCache.set(parentSessionID, parentMessages);
          }
          if (parentMessages === null) {
            runningReconcileBackoff.set(key, nextBackoffState({
              cache,
              nowMs: nowMs2,
              initialBackoffMs: RUNNING_RECONCILE_INITIAL_BACKOFF_MS,
              maxBackoffMs: RUNNING_RECONCILE_MAX_BACKOFF_MS
            }));
            continue;
          }
          const evidence2 = resolvePersistedStaleSubtaskFromParentMessages({
            candidate: {
              childID: candidate.childID,
              parentID: candidate.parentID,
              messageID: candidate.messageID,
              title: candidate.title,
              summary: candidate.summary,
              agentName: candidate.agentName
            },
            messages: parentMessages
          });
          if (!evidence2) {
            const parentSummary = summarizeSessionMessages(parentMessages);
            const canSafelyFallbackByParentInactivity = canSafelyCloseNoTargetPersistedCandidate({
              nowMs: nowMs2,
              staleThresholdMs: STALE_RUNNING_THRESHOLD_MS,
              startedMs: candidate.startedMs,
              updatedMs: candidate.updatedMs,
              latestMessageActivityAtMs: parentSummary.latestMessageActivityAtMs
            });
            if (canSafelyFallbackByParentInactivity) {
              mutations.push({
                childID: candidate.childID,
                targetSessionID: candidate.childID,
                status: "done",
                endedAt: parentSummary.latestMessageActivityAt ?? new Date(nowMs2 - candidate.updatedMs).toISOString(),
                reconcileWithoutTargetSessionID: true
              });
              runningReconcileBackoff.delete(key);
              continue;
            }
            runningReconcileBackoff.set(key, nextBackoffState({
              cache,
              nowMs: nowMs2,
              initialBackoffMs: RUNNING_RECONCILE_INITIAL_BACKOFF_MS,
              maxBackoffMs: RUNNING_RECONCILE_MAX_BACKOFF_MS
            }));
            continue;
          }
          mutations.push({
            childID: candidate.childID,
            targetSessionID: evidence2.targetSessionID ?? candidate.childID,
            status: evidence2.status,
            endedAt: evidence2.endedAt,
            reconcileWithoutTargetSessionID: true
          });
          runningReconcileBackoff.delete(key);
          continue;
        }
        const evidence = await probeRunningEvidence({
          api,
          targetSessionID: candidate.targetSessionID,
          directory,
          candidateAgeMs: Math.max(candidate.startedMs, candidate.updatedMs),
          nowMs: nowMs2
        });
        if (evidence.status === "done" || evidence.status === "error") {
          mutations.push({
            childID: candidate.childID,
            targetSessionID: candidate.targetSessionID,
            status: evidence.status,
            endedAt: evidence.endedAt
          });
          runningReconcileBackoff.delete(key);
          continue;
        }
        if (evidence.sawRunningEvidence) {
          runningReconcileBackoff.set(key, {
            backoffMs: RUNNING_RECONCILE_INITIAL_BACKOFF_MS,
            nextAllowedAtMs: nowMs2 + RUNNING_RECONCILE_INITIAL_BACKOFF_MS
          });
          continue;
        }
        const shouldApplyFallback = shouldApplyStaleRunningFallback({
          staleThresholdMs: STALE_RUNNING_THRESHOLD_MS,
          evidence,
          startedMs: candidate.startedMs,
          updatedMs: candidate.updatedMs
        });
        if (shouldApplyFallback) {
          mutations.push({
            childID: candidate.childID,
            targetSessionID: candidate.targetSessionID,
            status: "done",
            endedAt: new Date(nowMs2 - candidate.updatedMs).toISOString()
          });
          runningReconcileBackoff.delete(key);
          continue;
        }
        runningReconcileBackoff.set(key, nextBackoffState({
          cache,
          nowMs: nowMs2,
          initialBackoffMs: RUNNING_RECONCILE_INITIAL_BACKOFF_MS,
          maxBackoffMs: RUNNING_RECONCILE_MAX_BACKOFF_MS
        }));
      }
      if (mutations.length === 0) return;
      snapshotSidebarScrollOffsets();
      setState((current) => {
        const next = cloneState(current);
        let changed = false;
        for (const mutation of mutations) {
          if (mutation.reconcileWithoutTargetSessionID && mutation.targetSessionID.startsWith("ses_")) {
            changed = upsertChildDetails(next, mutation.childID, {
              targetSessionID: mutation.targetSessionID,
              updatedAt: mutation.endedAt
            }) || changed;
          }
          if (markChildStatus(next, mutation.reconcileWithoutTargetSessionID ? mutation.childID : mutation.targetSessionID, mutation.status, mutation.endedAt)) {
            changed = true;
          }
        }
        const refreshed = refreshLiveState(next);
        if (!changed && !refreshed) return current;
        persistStateSnapshot(statePath, textPath, next);
        return next;
      });
    } finally {
      reconcileInFlight = false;
    }
  };
  const timers = createTuiMaintenanceTimers({
    onElapsedTick: () => {
      snapshotSidebarScrollOffsets();
      setNowMs(Date.now());
    },
    onMaintenanceTick: () => {
      const currentNowMs = Date.now();
      if (currentNowMs - lastRunningReconcileAtMs >= RUNNING_RECONCILE_MAINTENANCE_INTERVAL_MS) {
        void reconcileRunningChildren();
      }
      setState((current) => {
        const next = runTuiStateMaintenance(api, current);
        if (next === current) return current;
        snapshotSidebarScrollOffsets();
        persistStateSnapshot(statePath, textPath, next);
        return next;
      });
    }
  });
  createEffect(() => {
    timers.syncElapsedTimer(Object.values(state().children).some((child) => child.status === "running"));
  });
  // >>> patch: toast notification when a subagent completes or fails
  const NOTIFY_DONE_ENABLED = (() => {
    const raw = String((typeof process !== "undefined" && process.env ? process.env.OPENCODE_SUBAGENT_NOTIFY : void 0) ?? "1").trim().toLowerCase();
    return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
  })();
  if (NOTIFY_DONE_ENABLED && api?.ui?.toast) {
    const notifiedStatus = /* @__PURE__ */ new Map();
    let notifySeeded = false;
    createEffect(() => {
      const children = state().children;
      if (!notifySeeded) {
        for (const child of Object.values(children)) notifiedStatus.set(child.id, child.status);
        notifySeeded = true;
        return;
      }
      for (const child of Object.values(children)) {
        const previous = notifiedStatus.get(child.id);
        notifiedStatus.set(child.id, child.status);
        if (previous === child.status) continue;
        if (child.status !== "done" && child.status !== "error") continue;
        const label = String(child.title || child.agentName || "subagent").replace(/\s+/g, " ").trim().slice(0, 60);
        const ok = child.status === "done";
        try {
          api.ui.toast({
            variant: ok ? "success" : "error",
            message: ok ? `Subagent done: ${label}` : `Subagent failed: ${label}`,
            duration: ok ? 4e3 : 6e3
          });
        } catch {
        }
      }
    });
  }
  // <<< patch: toast notification when a subagent completes or fails
  const applyEvent = (event) => {
    debugEvent(event);
    snapshotSidebarScrollOffsets();
    setState((current) => {
      const next = cloneState(current);
      const changed = applySubagentEvent(next, event);
      const hydrated = hydrateStateTokensFromTuiState(api, next);
      if (changed) {
        debugLog({
          kind: "state.changed",
          children: Object.values(next.children).map((child) => ({
            id: child.id,
            parentID: child.parentID,
            title: child.title,
            status: child.status,
            source: child.source
          }))
        });
      }
      const refreshed = refreshLiveState(next);
      if (!changed && !hydrated && !refreshed) return current;
      persistStateSnapshot(statePath, textPath, next);
      return next;
    });
  };
  const disposers = [api.event.on("session.created", applyEvent), api.event.on("session.updated", applyEvent), api.event.on("session.status", applyEvent), api.event.on("session.idle", applyEvent), api.event.on("session.error", applyEvent), api.event.on("message.updated", applyEvent), api.event.on("message.part.updated", applyEvent)];
  api.lifecycle.onDispose(() => {
    disposed = true;
    timers.dispose();
    for (const timeout of hydrateRetryTimeouts.values()) {
      clearTimeout(timeout);
    }
    hydrateRetryTimeouts.clear();
    commandDispose();
    for (const dispose of disposers) {
      dispose();
    }
    disposeRoot();
  });
  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(ctx) {
        const routeSessionID = resolveRouteSessionID(api);
        const sessionID = ctx.session_id ?? routeSessionID ?? "";
        debugLog({
          kind: "slot.sidebar_content",
          ctxSessionID: ctx.session_id,
          resolvedSessionID: sessionID,
          route: api.route.current,
          childCount: Object.keys(state().children).length
        });
        const restoreFromChild = (() => {
          const pending = consumePendingSidebarRefocus();
          if (pending?.parentSessionID !== sessionID) return void 0;
          return {
            childRowID: pending.childRowID,
            showCompletedHistory: pending.showCompletedHistory ?? false
          };
        })();
        return _$createComponent(Show, {
          get when() {
            return subagentsSectionEnabled();
          },
          get children() {
            return _$createComponent(SidebarSubagents, {
              api,
              sessionID,
              state,
              nowMs,
              expanded: subagentsExpanded,
              onToggleExpanded: () => setSubagentsExpandedPreference(!subagentsExpanded()),
              onSetExpanded: setSubagentsExpandedSilently,
              onReturnFocus: focusActivePrompt,
              onToggleListFocus: toggleSidebarListFocus,
              onNavigateToChild: rememberSidebarChildNavigation,
              sidebarWidth: () => resolveSidebarWidth(ctx),
              get theme() {
                return ctx.theme.current;
              },
              restoreFromChild
            });
          }
        });
      },
      home_bottom(ctx) {
        return _$createComponent(HomeBottomStatus, {
          state,
          get theme() {
            return ctx.theme.current;
          }
        });
      },
      app_bottom(ctx) {
        return _$createComponent(AppBottomStatus, {
          state,
          get theme() {
            return ctx.theme.current;
          }
        });
      },
      home_prompt(_ctx, props) {
        const promptProps = {
          ...props,
          ...props.workspaceID === void 0 && props.workspace_id !== void 0 ? {
            workspaceID: props.workspace_id
          } : {},
          ref: composePromptRef(props.ref)
        };
        return _$createComponent(api.ui.Prompt, promptProps);
      },
      session_prompt(_ctx, props) {
        const sessionID = props.sessionID ?? props.session_id;
        const promptProps = {
          ...props,
          ...props.sessionID === void 0 && props.session_id !== void 0 ? {
            sessionID: props.session_id
          } : {},
          ...props.onSubmit === void 0 && props.on_submit !== void 0 ? {
            onSubmit: props.on_submit
          } : {},
          right: props.right ?? (sessionID ? _$createComponent(api.ui.Slot, {
            name: "session_prompt_right",
            session_id: sessionID
          }) : void 0),
          ref: composePromptRef(props.ref)
        };
        return _$createComponent(api.ui.Prompt, promptProps);
      }
    }
  });
}
var tui = async (api) => {
  createRoot((disposeRoot) => initializeTui(api, disposeRoot));
};
var plugin = {
  id: TUI_PLUGIN_ID,
  tui
};
var tui_default = plugin;
export {
  backfillHydratedTargetSessionIDs,
  createTuiMaintenanceTimers,
  tui_default as default,
  formatChildModelLine,
  hydratePreviousSubagents,
  preservedSidebarAnchorScrollTop,
  preservedSidebarScrollTop,
  probeRunningEvidence,
  resolveSidebarSubagentSnapshot,
  resolveTuiSubagentSnapshot,
  runTuiStateMaintenance,
  subagentRowHeight,
  wrapCompactText
};
