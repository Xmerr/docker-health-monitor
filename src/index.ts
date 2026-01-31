import {
	ConnectionManager,
	DlqHandler,
	createLogger,
} from "@xmer/consumer-shared";
import Docker from "dockerode";
import { createConfig } from "./config/config.js";
import { TriggerConsumer } from "./consumers/trigger.consumer.js";
import { ContainerFilter } from "./filters/container-filter.js";
import { DockerPublisher } from "./publishers/docker.publisher.js";
import { EventListenerService } from "./services/event-listener.service.js";
import { HealthCheckerService } from "./services/health-checker.service.js";
import { LogFetcherService } from "./services/log-fetcher.service.js";
import { ContainerStateStore } from "./state/container-state.store.js";

async function main(): Promise<void> {
	const config = createConfig();

	const logger = createLogger({
		job: "docker-health-monitor",
		environment: process.env.NODE_ENV ?? "production",
		level: config.logLevel as "debug" | "info" | "warn" | "error",
		loki: config.lokiHost ? { host: config.lokiHost } : undefined,
	});

	logger.info("Starting docker-health-monitor");

	// Initialize Docker client
	const docker = new Docker({
		socketPath: config.dockerHost.startsWith("unix://")
			? config.dockerHost.slice(7)
			: undefined,
		host: config.dockerHost.startsWith("tcp://")
			? config.dockerHost.slice(6).split(":")[0]
			: undefined,
		port: config.dockerHost.startsWith("tcp://")
			? Number.parseInt(config.dockerHost.split(":")[2] ?? "2375", 10)
			: undefined,
	});

	// Test Docker connection
	try {
		await docker.ping();
		logger.info("Docker connection established", {
			dockerHost: config.dockerHost,
		});
	} catch (error) {
		logger.error("Failed to connect to Docker", {
			error: (error as Error).message,
			dockerHost: config.dockerHost,
		});
		process.exit(1);
	}

	// Connect to RabbitMQ
	const connectionManager = new ConnectionManager({
		url: config.rabbitmqUrl,
		logger,
	});
	await connectionManager.connect();

	const channel = connectionManager.getChannel();

	// Initialize components
	const containerFilter = new ContainerFilter({
		include_patterns: config.includePatterns,
		exclude_patterns: config.excludePatterns,
		required_labels: config.requiredLabels,
	});

	const stateStore = new ContainerStateStore();

	const publisher = new DockerPublisher({
		channel,
		exchange: config.exchangeName,
		notificationsExchange: config.notificationsExchange,
		logger,
	});

	const logFetcher = new LogFetcherService({
		docker,
		logger,
		tailLines: config.logTailLines,
	});

	const healthChecker = new HealthCheckerService({
		docker,
		logger,
		containerFilter,
		stateStore,
		publisher,
		logFetcher,
		pollIntervalSeconds: config.pollIntervalSeconds,
	});

	const eventListener = new EventListenerService({
		docker,
		logger,
		onEvent: (event) => healthChecker.handleDockerEvent(event),
		containerFilter,
	});

	const dlqHandler = new DlqHandler({
		channel,
		exchange: config.exchangeName,
		queue: config.triggerQueueName,
		serviceName: "docker-health-monitor",
		logger,
	});

	const triggerConsumer = new TriggerConsumer({
		channel,
		exchange: config.exchangeName,
		queue: config.triggerQueueName,
		routingKey: config.triggerRoutingKey,
		dlqHandler,
		logger,
		healthChecker,
	});

	// Start services
	await triggerConsumer.start();
	await eventListener.start();
	healthChecker.start();

	logger.info("docker-health-monitor is running", {
		pollIntervalSeconds: config.pollIntervalSeconds,
		includePatterns: config.includePatterns,
		excludePatterns: config.excludePatterns,
	});

	// Graceful shutdown
	const shutdown = async (): Promise<void> => {
		logger.info("Shutting down...");

		healthChecker.stop();
		eventListener.stop();
		await triggerConsumer.stop();

		// Wait for in-flight messages
		await new Promise((resolve) => setTimeout(resolve, 2000));

		await connectionManager.close();
		logger.info("Shutdown complete");
		process.exit(0);
	};

	process.on("SIGTERM", () => void shutdown());
	process.on("SIGINT", () => void shutdown());
}

main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
