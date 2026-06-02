import type { ModelTier } from "@open-agents/agent";

/** Tools that only the worker tier may invoke (interface must delegate via `task`). */
export const WORKER_ONLY_TIERS: ModelTier[] = ["worker"];

/** Tools available to interface and worker tiers (not the compactor). */
export const INTERFACE_AND_WORKER_TIERS: ModelTier[] = ["interface", "worker"];
