# Docker Health Monitor

Monitors Docker container health via the Docker API and publishes alerts to RabbitMQ when containers become unhealthy, restart unexpectedly, or exit with errors. Exposes a GraphQL API for querying container status and subscribing to real-time updates.

## Links

- [GitHub](https://github.com/Xmerr/docker-health-monitor)
- [Docker Hub](https://hub.docker.com/r/xmer/docker-health-monitor)

## Quick Start

```bash
docker run -d \
  --name docker-health-monitor \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  -e RABBITMQ_URL=amqp://user:pass@host:5672 \
  -p 4002:4002 \
  -p 4003:4003 \
  xmer/docker-health-monitor:latest
```

## Docker Compose Example

```yaml
services:
  docker-health-monitor:
    image: xmer/docker-health-monitor:latest
    container_name: docker-health-monitor
    restart: unless-stopped
    environment:
      - RABBITMQ_URL=amqp://user:pass@host:5672
      - POLL_INTERVAL_SECONDS=60
      - INCLUDE_PATTERNS=*-consumer,*-service
      - EXCLUDE_PATTERNS=*-test
      - LOG_TAIL_LINES=10
      - LOKI_HOST=http://loki:3100
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - network

networks:
  network:
    external: true
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RABBITMQ_URL` | Yes | - | AMQP connection URI |
| `DOCKER_HOST` | No | `unix:///var/run/docker.sock` | Docker socket path |
| `POLL_INTERVAL_SECONDS` | No | `60` | Health check polling interval |
| `INCLUDE_PATTERNS` | No | - | Container name patterns to include (comma-separated) |
| `EXCLUDE_PATTERNS` | No | - | Container name patterns to exclude (comma-separated) |
| `REQUIRED_LABELS` | No | - | Required container labels (`key=value,...`) |
| `LOG_TAIL_LINES` | No | `10` | Lines of logs to include in alerts |
| `LOKI_HOST` | No | - | Grafana Loki endpoint |
| `LOG_LEVEL` | No | `info` | Log level |
| `GRAPHQL_PORT` | No | `4002` | GraphQL HTTP server port |
| `GRAPHQL_WS_PORT` | No | `4003` | GraphQL WebSocket server port |

## Volumes

| Volume | Required | Description |
|--------|----------|-------------|
| `/var/run/docker.sock` | Yes | Docker socket (read-only access) |

## Ports

| Port | Protocol | Description |
|------|----------|-------------|
| 4002 | HTTP | GraphQL queries and mutations |
| 4003 | WebSocket | GraphQL subscriptions |

## Monitoring Modes

### 1. Event-Driven
Subscribes to Docker event stream for real-time notifications:
- `die` - Container exited
- `restart` - Container restarted
- `health_status` - Health check passed/failed
- `oom` - Out of memory kill
- `start` - Container started

### 2. Polling
Periodic health checks at the configured interval (default: 60 seconds).

### 3. Manual Trigger
Consume from `docker.trigger` queue for on-demand reports/checks.

## Alert Deduplication

To prevent notification spam:
- **Restart loops**: Alert on 1st, 3rd, 5th restart within 10 minutes, then every 5th
- **Unhealthy**: Alert on transition, re-alert every 15 minutes if still unhealthy
- **Recovery**: Always alert (good news)

## Message Payloads

### Container Alert

Published to `docker` exchange with routing keys:
- `container.unhealthy`
- `container.died`
- `container.restarting`
- `container.oom`
- `container.recovered`

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

### Status Report

Published to `docker` exchange with routing key `status.report`.

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

## Trigger Message Contract

Publish to `docker` exchange with routing key `trigger`:

```json
{
  "action": "status_report" | "check_container" | "check_all",
  "container_id": "abc123",
  "force_notify": true
}
```

| Action | Description |
|--------|-------------|
| `status_report` | Generate and publish a status report for all monitored containers |
| `check_container` | Check specific container (requires `container_id`) |
| `check_all` | Run immediate poll of all monitored containers |

`force_notify: true` bypasses deduplication and always publishes alerts.

## Container Filtering

By default, monitors containers with restart policies (`always`, `unless-stopped`, `on-failure`).

### Pattern Matching

```bash
# Include only specific containers
INCLUDE_PATTERNS=*-consumer,notification-*

# Exclude test containers
EXCLUDE_PATTERNS=*-test,temp-*
```

### Label Filtering

```bash
# Only monitor containers with specific labels
REQUIRED_LABELS=monitor=true,env=production
```

## Local Development

```bash
# Install dependencies
bun install

# Run locally
bun run start

# Run tests
bun test

# Run tests with coverage
bun run test:coverage

# Lint
bun run lint
```
