# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

RabbitMQ consumer service that monitors Docker container health via the Docker API. Publishes alerts when containers become unhealthy, restart unexpectedly, or exit with errors. Supports three monitoring modes: event-driven (real-time Docker events), polling (periodic health checks), and manual triggers (on-demand via queue).

Uses [`@xmer/consumer-shared`](../consumer-shared/) for RabbitMQ connection management, base consumer/publisher abstractions, DLQ retry logic, logging, and common error classes.

## Commands

```bash
bun install              # Install dependencies
bun run build            # Compile TypeScript to dist/
bun run lint             # Run Biome linter/formatter
bun run lint:fix         # Auto-fix lint issues
bun test                 # Run all tests
bun run test:coverage    # Run tests with coverage (95% threshold)
bun run start            # Run service (requires .env file)
```

Run a single test file:
```bash
bun test src/services/health-checker.service.test.ts
```

## Architecture

```
Message Flow:

Docker API ──────────────▶ docker-health-monitor ──────────▶ container.unhealthy
  (events)               │                                   container.died
                         │                                   container.restarting
trigger ─────────────────┤                                   container.oom
(docker exchange)        │                                   container.recovered
                         │                                   status.report
                         ▼                                   (docker exchange)
              ┌──────────────────────┐                            │
              │  EventListenerService │                           │
              │  (Docker event stream)│                           ▼
              └──────────────────────┘                   ┌────────────────┐
              ┌──────────────────────┐                   │  notifications │
              │  HealthCheckerService │────────────────▶ │    exchange    │
              │  (polling + events)   │                  └────────────────┘
              └──────────────────────┘
              ┌──────────────────────┐
              │    TriggerConsumer   │
              │  (manual triggers)    │
              └──────────────────────┘
```

### Key Components

- **`src/index.ts`**: Service orchestration. Wires together all dependencies, starts all services, and registers graceful shutdown handlers (SIGTERM/SIGINT).

- **`src/consumers/trigger.consumer.ts`**: Handles manual trigger messages. Implements `status_report`, `check_container`, and `check_all` actions with optional `force_notify` to bypass deduplication.

- **`src/services/event-listener.service.ts`**: Subscribes to Docker event stream for real-time container events (die, restart, health_status, oom, start).

- **`src/services/health-checker.service.ts`**: Core health checking logic. Handles both polling-based checks and Docker event processing. Detects status transitions and publishes alerts via DockerPublisher.

- **`src/services/log-fetcher.service.ts`**: Fetches last N lines of container logs for inclusion in alerts.

- **`src/publishers/docker.publisher.ts`**: Publishes alerts and status reports to `docker` exchange. Sets up exchange-to-exchange bindings to forward alerts to `notifications` exchange.

- **`src/state/container-state.store.ts`**: In-memory state tracking for deduplication. Implements restart window tracking (10 min) and unhealthy re-alert timing (15 min).

- **`src/filters/container-filter.ts`**: Determines which containers to monitor based on include/exclude patterns, required labels, and restart policies.

- **`src/config/config.ts`**: Environment variable parsing with validation.

### Dependency Injection Pattern

All components receive dependencies via constructor options, matching the pattern from `@xmer/consumer-shared`.

## RabbitMQ Topology

| Resource | Name |
|----------|------|
| Exchange | `docker` (topic, durable) |
| Queue | `docker.trigger` (durable) |
| Binding | `docker` -> `docker.trigger` with key `trigger` |
| DLQ exchange | `docker.dlq` (topic, durable) |
| DLQ queue | `docker.trigger.dlq` |
| Delay exchange | `docker.delay` (x-delayed-message) |
| Alert routing keys | `container.unhealthy`, `container.died`, `container.restarting`, `container.oom`, `container.recovered` |
| Status routing key | `status.report` |
| DLQ alert routing key | `notifications.dlq.docker-health-monitor` on `notifications` exchange |

### Exchange-to-Exchange Bindings

All alert routing keys (`container.*`) are bound from `docker` exchange to `notifications` exchange for automatic notification forwarding.

## Message Contracts

### Consumed: `trigger`

```json
{
  "action": "status_report" | "check_container" | "check_all",
  "container_id": "abc123",
  "force_notify": true
}
```

- `action` (required): One of `status_report`, `check_container`, `check_all`
- `container_id` (required for `check_container`): Container ID to check
- `force_notify` (optional): When `true`, bypasses deduplication

### Produced: `container.unhealthy`, `container.died`, `container.restarting`, `container.oom`, `container.recovered`

```json
{
  "container_id": "abc123def456",
  "container_name": "my-service",
  "image": "my-image:latest",
  "event": "unhealthy",
  "exit_code": 1,
  "restart_count": 3,
  "health_status": "Connection refused",
  "logs_tail": "Error: ECONNREFUSED...",
  "timestamp": "2026-01-30T00:00:00.000Z"
}
```

### Produced: `status.report`

```json
{
  "containers": [
    {
      "container_id": "abc123def456",
      "container_name": "my-service",
      "image": "my-image:latest",
      "status": "healthy",
      "uptime_seconds": 3600,
      "restart_count": 0
    }
  ],
  "timestamp": "2026-01-30T00:00:00.000Z"
}
```

## Alert Deduplication Rules

| Event | Rule |
|-------|------|
| Restart | Alert on 1st, 3rd, 5th restart within 10-min window, then every 5th |
| Unhealthy | Alert on transition to unhealthy, re-alert every 15 minutes if still unhealthy |
| Recovery | Always alert (good news) |
| Died | Always alert |
| OOM | Always alert |

`force_notify: true` in trigger messages bypasses all deduplication rules.

## Docker Events Monitored

| Event | Trigger |
|-------|---------|
| `die` | Container exited (includes exit code) |
| `restart` | Container restarted |
| `health_status` | Health check passed/failed |
| `oom` | Out of memory kill |
| `start` | Container started (for recovery tracking) |

## Container Filtering

Default: Monitor containers with restart policy (`always`, `unless-stopped`, `on-failure`).

Configurable via:
- `INCLUDE_PATTERNS`: Glob patterns for container names to include
- `EXCLUDE_PATTERNS`: Glob patterns for container names to exclude (takes priority)
- `REQUIRED_LABELS`: Label key=value pairs that must be present

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RABBITMQ_URL` | Yes | - | AMQP connection URI |
| `DOCKER_HOST` | No | `unix:///var/run/docker.sock` | Docker socket path |
| `POLL_INTERVAL_SECONDS` | No | `60` | Health check polling interval |
| `INCLUDE_PATTERNS` | No | - | Container patterns to include |
| `EXCLUDE_PATTERNS` | No | - | Container patterns to exclude |
| `REQUIRED_LABELS` | No | - | Required labels (`key=value,...`) |
| `LOG_TAIL_LINES` | No | `10` | Log lines in alerts |
| `LOKI_HOST` | No | - | Grafana Loki endpoint |
| `LOG_LEVEL` | No | `info` | Log level |

## Docker Setup

The container requires read-only access to the Docker socket:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock:ro
```
