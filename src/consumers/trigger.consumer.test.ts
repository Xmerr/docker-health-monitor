import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ConsumeMessage } from "amqplib";
import { TriggerConsumer } from "./trigger.consumer.js";

function createMockChannel() {
	return {
		prefetch: mock(() => Promise.resolve()),
		assertExchange: mock(() => Promise.resolve()),
		assertQueue: mock(() => Promise.resolve()),
		bindQueue: mock(() => Promise.resolve()),
		consume: mock(() => Promise.resolve({ consumerTag: "test-tag" })),
		cancel: mock(() => Promise.resolve()),
		ack: mock(() => {}),
		nack: mock(() => {}),
	};
}

function createMockLogger() {
	const childLogger = {
		debug: mock(() => {}),
		info: mock(() => {}),
		warn: mock(() => {}),
		error: mock(() => {}),
		child: mock(() => childLogger),
	};
	return {
		debug: mock(() => {}),
		info: mock(() => {}),
		warn: mock(() => {}),
		error: mock(() => {}),
		child: mock(() => childLogger),
		_childLogger: childLogger,
	};
}

function createMockDlqHandler() {
	return {
		setup: mock(() => Promise.resolve()),
		handleRetryableError: mock(() => Promise.resolve()),
		handleNonRetryableError: mock(() => Promise.resolve()),
	};
}

function createMockHealthChecker() {
	return {
		start: mock(() => {}),
		stop: mock(() => {}),
		pollContainers: mock(() => Promise.resolve()),
		checkSingleContainer: mock(() => Promise.resolve()),
		generateStatusReport: mock(() =>
			Promise.resolve({
				containers: [],
				timestamp: new Date().toISOString(),
			}),
		),
		handleDockerEvent: mock(() => Promise.resolve()),
	};
}

function createMockMessage(content: object): ConsumeMessage {
	return {
		content: Buffer.from(JSON.stringify(content)),
		fields: {
			deliveryTag: 1,
			redelivered: false,
			exchange: "docker",
			routingKey: "trigger",
			messageCount: 0,
			consumerTag: "test-tag",
		},
		properties: {
			contentType: "application/json",
			headers: {},
			deliveryMode: 2,
			priority: 0,
			correlationId: undefined,
			replyTo: undefined,
			expiration: undefined,
			messageId: undefined,
			timestamp: undefined,
			type: undefined,
			userId: undefined,
			appId: undefined,
			clusterId: undefined,
		},
	} as ConsumeMessage;
}

describe("TriggerConsumer", () => {
	let consumer: TriggerConsumer;
	let mockChannel: ReturnType<typeof createMockChannel>;
	let mockLogger: ReturnType<typeof createMockLogger>;
	let mockDlqHandler: ReturnType<typeof createMockDlqHandler>;
	let mockHealthChecker: ReturnType<typeof createMockHealthChecker>;
	let messageHandler: ((msg: ConsumeMessage | null) => void) | null;

	beforeEach(() => {
		mockChannel = createMockChannel();
		mockLogger = createMockLogger();
		mockDlqHandler = createMockDlqHandler();
		mockHealthChecker = createMockHealthChecker();
		messageHandler = null;

		// Capture the message handler when consume is called
		mockChannel.consume.mockImplementation((_queue, handler) => {
			messageHandler = handler as (msg: ConsumeMessage | null) => void;
			return Promise.resolve({ consumerTag: "test-tag" });
		});

		consumer = new TriggerConsumer({
			channel: mockChannel as unknown as import("amqplib").Channel,
			exchange: "docker",
			queue: "docker.trigger",
			routingKey: "trigger",
			dlqHandler: mockDlqHandler,
			logger: mockLogger,
			healthChecker: mockHealthChecker,
		});
	});

	describe("start", () => {
		it("should setup exchange, queue, and bindings", async () => {
			// Act
			await consumer.start();

			// Assert
			expect(mockChannel.assertExchange).toHaveBeenCalledWith(
				"docker",
				"topic",
				{ durable: true },
			);
			expect(mockChannel.assertQueue).toHaveBeenCalledWith("docker.trigger", {
				durable: true,
			});
			expect(mockChannel.bindQueue).toHaveBeenCalledWith(
				"docker.trigger",
				"docker",
				"trigger",
			);
			expect(mockDlqHandler.setup).toHaveBeenCalled();
		});

		it("should start consuming messages", async () => {
			// Act
			await consumer.start();

			// Assert
			expect(mockChannel.consume).toHaveBeenCalledWith(
				"docker.trigger",
				expect.any(Function),
				{ noAck: false },
			);
		});
	});

	describe("stop", () => {
		it("should cancel consumer", async () => {
			// Arrange
			await consumer.start();

			// Act
			await consumer.stop();

			// Assert
			expect(mockChannel.cancel).toHaveBeenCalledWith("test-tag");
		});
	});

	describe("message handling", () => {
		beforeEach(async () => {
			await consumer.start();
		});

		it("should handle status_report action", async () => {
			// Arrange
			const msg = createMockMessage({ action: "status_report" });

			// Act
			messageHandler?.(msg);
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Assert
			expect(mockHealthChecker.generateStatusReport).toHaveBeenCalled();
			expect(mockChannel.ack).toHaveBeenCalledWith(msg);
		});

		it("should handle check_container action", async () => {
			// Arrange
			const msg = createMockMessage({
				action: "check_container",
				container_id: "abc123",
				force_notify: true,
			});

			// Act
			messageHandler?.(msg);
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Assert
			expect(mockHealthChecker.checkSingleContainer).toHaveBeenCalledWith(
				"abc123",
				true,
			);
			expect(mockChannel.ack).toHaveBeenCalledWith(msg);
		});

		it("should handle check_all action", async () => {
			// Arrange
			const msg = createMockMessage({
				action: "check_all",
				force_notify: true,
			});

			// Act
			messageHandler?.(msg);
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Assert
			expect(mockHealthChecker.pollContainers).toHaveBeenCalledWith(true);
			expect(mockChannel.ack).toHaveBeenCalledWith(msg);
		});

		it("should handle check_all without force_notify", async () => {
			// Arrange
			const msg = createMockMessage({ action: "check_all" });

			// Act
			messageHandler?.(msg);
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Assert
			expect(mockHealthChecker.pollContainers).toHaveBeenCalledWith(undefined);
		});

		it("should reject invalid action", async () => {
			// Arrange
			const msg = createMockMessage({ action: "invalid_action" });

			// Act
			messageHandler?.(msg);
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Assert
			expect(mockDlqHandler.handleNonRetryableError).toHaveBeenCalled();
		});

		it("should reject check_container without container_id", async () => {
			// Arrange
			const msg = createMockMessage({ action: "check_container" });

			// Act
			messageHandler?.(msg);
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Assert
			expect(mockDlqHandler.handleNonRetryableError).toHaveBeenCalled();
		});

		it("should handle null message", async () => {
			// Act
			messageHandler?.(null);
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Assert
			expect(mockLogger._childLogger.warn).toHaveBeenCalledWith(
				"Received null message",
			);
		});

		it("should handle JSON parse error", async () => {
			// Arrange
			const msg = {
				...createMockMessage({}),
				content: Buffer.from("invalid json"),
			} as ConsumeMessage;

			// Act
			messageHandler?.(msg);
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Assert
			expect(mockDlqHandler.handleRetryableError).toHaveBeenCalled();
		});

		it("should handle DLQ handler failure", async () => {
			// Arrange
			mockDlqHandler.handleNonRetryableError.mockRejectedValue(
				new Error("DLQ failed"),
			);
			const msg = createMockMessage({ action: "invalid_action" });

			// Act
			messageHandler?.(msg);
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Assert
			expect(mockChannel.nack).toHaveBeenCalledWith(msg, false, false);
		});
	});
});
