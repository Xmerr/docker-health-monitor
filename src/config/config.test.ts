import { describe, expect, it } from "bun:test";
import { ConfigurationError } from "@xmer/consumer-shared";
import { createConfig } from "./config.js";

describe("createConfig", () => {
	it("should throw when RABBITMQ_URL is missing", () => {
		// Arrange
		const env = {};

		// Act & Assert
		expect(() => createConfig(env)).toThrow(ConfigurationError);
	});

	it("should create config with required and default values", () => {
		// Arrange
		const env = {
			RABBITMQ_URL: "amqp://localhost:5672",
		};

		// Act
		const config = createConfig(env);

		// Assert
		expect(config.rabbitmqUrl).toBe("amqp://localhost:5672");
		expect(config.dockerHost).toBe("unix:///var/run/docker.sock");
		expect(config.pollIntervalSeconds).toBe(60);
		expect(config.includePatterns).toEqual([]);
		expect(config.excludePatterns).toEqual([]);
		expect(config.requiredLabels).toEqual({});
		expect(config.logTailLines).toBe(10);
		expect(config.lokiHost).toBeUndefined();
		expect(config.logLevel).toBe("info");
		expect(config.exchangeName).toBe("docker");
		expect(config.notificationsExchange).toBe("notifications");
		expect(config.triggerQueueName).toBe("docker.trigger");
		expect(config.triggerRoutingKey).toBe("trigger");
	});

	it("should parse DOCKER_HOST", () => {
		// Arrange
		const env = {
			RABBITMQ_URL: "amqp://localhost:5672",
			DOCKER_HOST: "tcp://192.168.1.100:2375",
		};

		// Act
		const config = createConfig(env);

		// Assert
		expect(config.dockerHost).toBe("tcp://192.168.1.100:2375");
	});

	it("should parse POLL_INTERVAL_SECONDS", () => {
		// Arrange
		const env = {
			RABBITMQ_URL: "amqp://localhost:5672",
			POLL_INTERVAL_SECONDS: "30",
		};

		// Act
		const config = createConfig(env);

		// Assert
		expect(config.pollIntervalSeconds).toBe(30);
	});

	it("should use default for invalid POLL_INTERVAL_SECONDS", () => {
		// Arrange
		const env = {
			RABBITMQ_URL: "amqp://localhost:5672",
			POLL_INTERVAL_SECONDS: "invalid",
		};

		// Act
		const config = createConfig(env);

		// Assert
		expect(config.pollIntervalSeconds).toBe(60);
	});

	it("should use default for negative POLL_INTERVAL_SECONDS", () => {
		// Arrange
		const env = {
			RABBITMQ_URL: "amqp://localhost:5672",
			POLL_INTERVAL_SECONDS: "-10",
		};

		// Act
		const config = createConfig(env);

		// Assert
		expect(config.pollIntervalSeconds).toBe(60);
	});

	it("should parse INCLUDE_PATTERNS", () => {
		// Arrange
		const env = {
			RABBITMQ_URL: "amqp://localhost:5672",
			INCLUDE_PATTERNS: "*-consumer, notification-*, my-app",
		};

		// Act
		const config = createConfig(env);

		// Assert
		expect(config.includePatterns).toEqual([
			"*-consumer",
			"notification-*",
			"my-app",
		]);
	});

	it("should parse EXCLUDE_PATTERNS", () => {
		// Arrange
		const env = {
			RABBITMQ_URL: "amqp://localhost:5672",
			EXCLUDE_PATTERNS: "*-test, temp-*",
		};

		// Act
		const config = createConfig(env);

		// Assert
		expect(config.excludePatterns).toEqual(["*-test", "temp-*"]);
	});

	it("should parse REQUIRED_LABELS", () => {
		// Arrange
		const env = {
			RABBITMQ_URL: "amqp://localhost:5672",
			REQUIRED_LABELS: "monitor=true, env=production",
		};

		// Act
		const config = createConfig(env);

		// Assert
		expect(config.requiredLabels).toEqual({
			monitor: "true",
			env: "production",
		});
	});

	it("should handle malformed REQUIRED_LABELS gracefully", () => {
		// Arrange
		const env = {
			RABBITMQ_URL: "amqp://localhost:5672",
			REQUIRED_LABELS: "valid=value, invalid, also=good",
		};

		// Act
		const config = createConfig(env);

		// Assert
		expect(config.requiredLabels).toEqual({
			valid: "value",
			also: "good",
		});
	});

	it("should parse LOG_TAIL_LINES", () => {
		// Arrange
		const env = {
			RABBITMQ_URL: "amqp://localhost:5672",
			LOG_TAIL_LINES: "25",
		};

		// Act
		const config = createConfig(env);

		// Assert
		expect(config.logTailLines).toBe(25);
	});

	it("should parse LOKI_HOST", () => {
		// Arrange
		const env = {
			RABBITMQ_URL: "amqp://localhost:5672",
			LOKI_HOST: "http://loki:3100",
		};

		// Act
		const config = createConfig(env);

		// Assert
		expect(config.lokiHost).toBe("http://loki:3100");
	});

	it("should parse custom exchange and queue names", () => {
		// Arrange
		const env = {
			RABBITMQ_URL: "amqp://localhost:5672",
			EXCHANGE_NAME: "custom-docker",
			NOTIFICATIONS_EXCHANGE: "custom-notifications",
			TRIGGER_QUEUE_NAME: "custom-docker.trigger",
			TRIGGER_ROUTING_KEY: "custom-trigger",
		};

		// Act
		const config = createConfig(env);

		// Assert
		expect(config.exchangeName).toBe("custom-docker");
		expect(config.notificationsExchange).toBe("custom-notifications");
		expect(config.triggerQueueName).toBe("custom-docker.trigger");
		expect(config.triggerRoutingKey).toBe("custom-trigger");
	});
});
