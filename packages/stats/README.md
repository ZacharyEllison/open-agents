# @open-agents/stats

Local observability dashboard for AI usage statistics.

## Features

- **Session log parsing**: Reads JSONL session logs from `~/.open-agent/agent/sessions/`
- **SQLite aggregation**: Efficient stats storage and querying using `bun:sqlite`
- **Web dashboard**: Real-time metrics visualization with Chart.js
- **Incremental sync**: Only processes new/modified log entries

## Metrics Tracked

| Metric | Calculation |
|--------|-------------|
| Tokens/s | `output_tokens / (duration / 1000)` |
| Cache Rate | `cache_read / (input + cache_read) * 100` |
| Error Rate | `count(stopReason=error) / total_calls * 100` |
| Total Cost | Sum of `usage.cost.total` |
| Avg Latency | Mean of `duration` |
| TTFT | Mean of `ttft` (time to first token) |

## Usage

### Via CLI

```bash
# Start dashboard server (default: http://localhost:3847)
open-agent stats

# Custom port
open-agent stats --port 8080

# Print summary to console
open-agent stats --summary

# Output as JSON (for scripting)
open-agent stats --json
```

### Programmatic

```typescript
import { getDashboardStats, syncAllSessions } from "@open-agents/stats";

// Sync session logs to database
const { processed, files } = await syncAllSessions();

// Get aggregated stats
const stats = await getDashboardStats();
console.log(stats.overall.totalCost);
console.log(stats.byModel[0].avgTokensPerSecond);
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/stats` | Overall stats with all breakdowns |
| `GET /api/stats/models` | Per-model statistics |
| `GET /api/stats/folders` | Per-folder/project statistics |
| `GET /api/stats/timeseries` | Hourly time series data |
| `GET /api/sync` | Trigger sync and return counts |

## Data Storage

- **Session logs**: `~/.open-agent/agent/sessions/` (JSONL files)
- **Stats database**: `~/.open-agent/stats.db` (SQLite)

## Dashboard

The web dashboard provides:

- Overall metrics cards (requests, cost, cache rate, error rate, duration, tokens/s)
- Time series chart showing requests and errors over time
- Per-model breakdown table
- Per-folder breakdown table
- Auto-refresh every 30 seconds

## License

AGPL-3.0-or-later. See [LICENSE](../../LICENSE).
