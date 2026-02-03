import { ConfigurationError } from "@xmer/consumer-shared";
import type { Config } from "../types/index.js";

export function createConfig(
	env: Record<string, string | undefined> = process.env,
): Config {
	const rabbitmqUrl = requireEnv(env, "RABBITMQ_URL");

	const dockerHost = env.DOCKER_HOST ?? "unix:///var/run/docker.sock";

	const pollIntervalSeconds = parsePositiveInt(env.POLL_INTERVAL_SECONDS, 60);

	const includePatterns = parseCommaSeparated(env.INCLUDE_PATTERNS);
	const excludePatterns = parseCommaSeparated(env.EXCLUDE_PATTERNS);
	const requiredLabels = parseLabels(env.REQUIRED_LABELS);

	const logTailLines = parsePositiveInt(env.LOG_TAIL_LINES, 10);

	const lokiHost = env.LOKI_HOST;
	const logLevel = env.LOG_LEVEL ?? "info";

	const exchangeName = env.EXCHANGE_NAME ?? "docker";
	const notificationsExchange = env.NOTIFICATIONS_EXCHANGE ?? "notifications";
	const triggerQueueName = env.TRIGGER_QUEUE_NAME ?? "docker.trigger";
	const triggerRoutingKey = env.TRIGGER_ROUTING_KEY ?? "trigger";

	const graphqlPort = parsePositiveInt(env.GRAPHQL_PORT, 4002);
	const graphqlWsPort = parsePositiveInt(env.GRAPHQL_WS_PORT, 4003);

	return {
		rabbitmqUrl,
		dockerHost,
		pollIntervalSeconds,
		includePatterns,
		excludePatterns,
		requiredLabels,
		logTailLines,
		lokiHost,
		logLevel,
		exchangeName,
		notificationsExchange,
		triggerQueueName,
		triggerRoutingKey,
		graphqlPort,
		graphqlWsPort,
	};
}

function requireEnv(
	env: Record<string, string | undefined>,
	key: string,
): string {
	const value = env[key];
	if (!value) {
		throw new ConfigurationError(
			`Missing required environment variable: ${key}`,
			key,
		);
	}
	return value;
}

function parsePositiveInt(
	value: string | undefined,
	defaultValue: number,
): number {
	if (!value) return defaultValue;
	const parsed = Number.parseInt(value, 10);
	if (Number.isNaN(parsed) || parsed <= 0) {
		return defaultValue;
	}
	return parsed;
}

function parseCommaSeparated(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
}

function parseLabels(value: string | undefined): Record<string, string> {
	if (!value) return {};
	const labels: Record<string, string> = {};
	const pairs = value.split(",").map((p) => p.trim());
	for (const pair of pairs) {
		const [key, val] = pair.split("=").map((s) => s.trim());
		if (key && val) {
			labels[key] = val;
		}
	}
	return labels;
}
