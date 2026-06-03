# Reducing Prefill Latency with Local KV Cache Stability

## The Problem

Every LLM request begins with **prefill** — the server processes the entire prompt (system prompt + conversation history + context) before generating the first output token. For a coding agent, this prompt is large: system instructions, tool definitions, file contents, prior turns. Prefill is the dominant source of time-to-first-token (TTFT) latency, often 2–10× longer than the actual generation.

Cloud providers offer prompt caching (Anthropic's cache control, OpenAI's automatic prefix caching), but these caches are:

- **Opaque** — you can't control eviction; the provider decides when your cache slot disappears.
- **Shared infrastructure** — cache pressure from other users evicts your entries.
- **Invalidated by any prefix change** — a single token difference in the prefix forces a full re-prefill.
- **Billed per-token** — cached reads are cheaper but not free; cache writes are expensive.

## The Local Advantage

A local model server (llama.cpp, vLLM, Ollama) eliminates all of these problems:

| Property | Cloud | Local |
|----------|-------|-------|
| Cache eviction | Provider-controlled, unpredictable | You control it — survives indefinitely |
| Cache sharing | Contended across all users | Dedicated to your session |
| Model swaps | Provider may rotate weights silently | Same weights until you change them |
| Prefix sensitivity | Any prefix byte change = miss | Same — but you control the prefix |
| Cost of cache miss | Billed tokens + latency spike | Only latency (no billing) |

The key insight: **with a local server, the KV cache is yours alone, the model never changes underneath you, and you decide when to invalidate.** This means a well-structured agent can achieve near-zero prefill on the vast majority of turns.

## Architecture: Stable Prefix Layering

The prompt sent to a local model should be structured as concentric layers of decreasing stability:

```
┌─────────────────────────────────────────────┐
│  Layer 0: System Prompt (never changes)     │  ← always cached
├─────────────────────────────────────────────┤
│  Layer 1: Tool Definitions (rarely changes) │  ← almost always cached
├─────────────────────────────────────────────┤
│  Layer 2: Project Context (changes on       │  ← cached within a session
│           file edits, not per turn)         │
├─────────────────────────────────────────────┤
│  Layer 3: Conversation History (grows)      │  ← prefix-cached up to last turn
├─────────────────────────────────────────────┤
│  Layer 4: Current Turn (new each request)   │  ← only this gets prefilled
└─────────────────────────────────────────────┘
```

If layers 0–3 are identical to the previous request, the server reuses their KV cache and only prefills layer 4 — typically a few hundred tokens instead of tens of thousands.

### Why This Doesn't Work Reliably on Cloud

Cloud prompt caching is prefix-match only: the cached region must be a **contiguous prefix** of the new prompt, and it must match **byte-for-byte**. Any of these common agent behaviors break the cache:

- Injecting timestamps or request IDs into the system prompt.
- Reordering tool definitions based on recent usage.
- Summarizing/compacting conversation history mid-session.
- Updating file contents inline after an edit.

Locally, none of these matter — you structure the prompt once and the server holds the KV state for as long as the slot lives.

## Strategies for open-agent

### 1. Immutable System Prompt Prefix

The system prompt and tool schema are rendered once at session start and frozen. No per-turn interpolation, no timestamps, no dynamic preamble. This guarantees the first N thousand tokens are a cache hit on every single request.

```
system_prompt = render_once(system.md + tool_definitions)
# Frozen for the session lifetime — never re-rendered
```

### 2. Tiered Context Loading

The 3-tier model architecture naturally reduces prefill per tier:

| Tier | What it receives | What it does NOT receive |
|------|-----------------|------------------------|
| **Interface** (small/fast) | System prompt, conversation, user query | Large file contents, deep code context |
| **Worker** (large) | System prompt, task description, focused file context | Full conversation history, unrelated files |
| **Compactor** (tiny) | Raw conversation turns to summarize | Tool definitions, project context |

The interface model stays fast because it never receives bulk file contents — it gathers references and delegates to the worker with only the relevant slices. The worker gets a **fresh, focused** context window per task rather than an ever-growing conversation.

This means:
- Interface prefill stays small and stable (high cache hit rate).
- Worker prefill is task-scoped (only the files and context for this specific task).
- Compactor prefill is conversation-only (no tools, no project context).

### 3. Slot Prompt Similarity (llama.cpp)

llama.cpp's `--slot-prompt-similarity` feature (used in `serve.sh`) enables **partial prefix reuse**: even when the prompt doesn't match byte-for-byte, the server finds the longest matching prefix in an existing slot and reuses that KV state.

With `--slot-prompt-similarity 0.0` (current default), the server reuses a slot if there's _any_ prefix overlap. This means:

- Turn N and turn N+1 share the system prompt + conversation up to turn N → only the new turn gets prefilled.
- A worker task that shares the same system prompt as the interface → system prompt KV is reused.
- After compaction rewrites history, the system prompt prefix still hits cache.

### 4. Compaction as a Cache-Friendly Operation

When conversation history grows past the context window, the compactor summarizes older turns. On cloud, this **destroys the cache** — the summarized prefix doesn't match the original. Locally:

- The KV cache for the **new** (post-compaction) prefix is built once.
- All subsequent turns reuse that new prefix — no external eviction will invalidate it.
- The compaction cost is paid exactly once, not repeatedly on cache misses.

The compactor tier can even run asynchronously — summarize in the background while the interface continues using the old (still-cached) prefix, then swap atomically.

### 5. Model Stability = Cache Stability

Cloud providers can silently update model weights, change quantization, or rotate serving infrastructure. Any of these can invalidate prompt caches without warning.

Locally, the model weights are a file on disk. The KV cache is valid as long as:
- The same model file is loaded.
- The same context parameters are set.

Both are under your control. A local KV cache can theoretically survive for days or weeks across sessions if the server stays running — no equivalent exists in cloud.

### 6. Prewarming

Since the local server is dedicated, open-agent can **prewarm** the KV cache before the user types:

- On session start: send the system prompt + tool definitions as a no-generation request to fill the cache slot.
- On file open/save: speculatively prefill the file contents into a worker slot.
- Between turns: if the interface is likely to delegate, prewarm the worker slot with the expected task context.

This shifts prefill latency from the critical path (user waiting for a response) to idle time (user typing, reading, thinking).

## Quantifying the Impact

For a typical coding session with ~8K system prompt + tools, ~4K project context, and ~12K conversation history:

| Scenario | Cloud (cache miss) | Cloud (cache hit) | Local (warm slot) |
|----------|-------------------|-------------------|-------------------|
| Prefill tokens | 24,000 | 24,000 (cheaper, not faster\*) | ~200 (current turn only) |
| TTFT | 2–5s | 1–3s | 50–200ms |

\* Cloud cache hits reduce cost but the server still reads the cached KV from storage; local KV is already in GPU memory.

## Implementation Checklist

- [ ] Freeze system prompt + tool schema at session init (no per-turn re-rendering)
- [ ] Structure prompt with stable-prefix layering (system → tools → project → history → turn)
- [ ] Pass `--slot-prompt-similarity` to llama-server for partial prefix reuse
- [ ] Route interface tier to a dedicated slot (small model, stable prefix)
- [ ] Route worker tasks to a pool of slots (focused context per task)
- [ ] Implement async compaction with atomic prefix swap
- [ ] Add prewarm on session start and between turns
- [ ] Expose prefill token count in `/metrics` for observability (`open-agent stats`)
