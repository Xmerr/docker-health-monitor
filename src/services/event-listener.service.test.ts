import { beforeEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import type { DockerEvent } from "../types/index.js";
import { EventListenerService } from "./event-listener.service.js";

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

function createMockEventStream() {
	const emitter = new EventEmitter();
	return Object.assign(emitter, {
		destroy: mock(() => {
			emitter.emit("end");
		}),
	});
}

function createMockDocker(
	eventStream: ReturnType<typeof createMockEventStream>,
) {
	return {
		getEvents: mock(() => Promise.resolve(eventStream)),
		listContainers: mock(() =>
			Promise.resolve([
				{
					Id: "abc123def456789",
					Names: ["/test-container"],
					HostConfig: {
						RestartPolicy: { Name: "always", MaximumRetryCount: 0 },
					},
					Labels: {},
				},
			]),
		),
	};
}

function createMockFilter() {
	return {
		shouldMonitor: mock(() => true),
	};
}

describe("EventListenerService", () => {
	let service: EventListenerService;
	let mockDocker: ReturnType<typeof createMockDocker>;
	let mockLogger: ReturnType<typeof createMockLogger>;
	let mockFilter: ReturnType<typeof createMockFilter>;
	let mockEventStream: ReturnType<typeof createMockEventStream>;
	let onEvent: ReturnType<typeof mock>;

	beforeEach(() => {
		mockEventStream = createMockEventStream();
		mockDocker = createMockDocker(mockEventStream);
		mockLogger = createMockLogger();
		mockFilter = createMockFilter();
		onEvent = mock(() => Promise.resolve());

		service = new EventListenerService({
			docker: mockDocker as unknown as import("dockerode").default,
			logger: mockLogger,
			onEvent,
			containerFilter: mockFilter,
		});
	});

	describe("start", () => {
		it("should connect to Docker event stream", async () => {
			// Act
			await service.start();

			// Assert
			expect(mockDocker.getEvents).toHaveBeenCalledWith({
				filters: {
					type: ["container"],
					event: ["die", "restart", "health_status", "oom", "start"],
				},
			});
		});

		it("should log when started", async () => {
			// Act
			await service.start();

			// Assert
			expect(mockLogger._childLogger.info).toHaveBeenCalledWith(
				"Docker event listener started",
				expect.any(Object),
			);
		});

		it("should warn if already running", async () => {
			// Arrange
			await service.start();

			// Act
			await service.start();

			// Assert
			expect(mockLogger._childLogger.warn).toHaveBeenCalledWith(
				"Event listener already running",
			);
		});
	});

	describe("stop", () => {
		it("should destroy event stream", async () => {
			// Arrange
			await service.start();

			// Act
			service.stop();

			// Assert
			expect(mockEventStream.destroy).toHaveBeenCalled();
		});

		it("should log when stopped", async () => {
			// Arrange
			await service.start();

			// Act
			service.stop();

			// Assert
			expect(mockLogger._childLogger.info).toHaveBeenCalledWith(
				"Docker event listener stopped",
			);
		});
	});

	describe("event handling", () => {
		it("should call onEvent for monitored container events", async () => {
			// Arrange
			await service.start();
			const event: DockerEvent = {
				Type: "container",
				Action: "die",
				Actor: {
					ID: "abc123def456789",
					Attributes: {
						name: "test-container",
						image: "test-image:latest",
						exitCode: "1",
					},
				},
				time: Date.now() / 1000,
				timeNano: Date.now() * 1000000,
			};

			// Act
			mockEventStream.emit("data", Buffer.from(JSON.stringify(event)));
			// Wait for async processing
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Assert
			expect(onEvent).toHaveBeenCalledWith(event);
		});

		it("should ignore events for filtered containers", async () => {
			// Arrange
			mockFilter.shouldMonitor.mockReturnValue(false);
			await service.start();
			const event: DockerEvent = {
				Type: "container",
				Action: "die",
				Actor: {
					ID: "abc123def456789",
					Attributes: {
						name: "filtered-container",
						image: "test-image:latest",
					},
				},
				time: Date.now() / 1000,
				timeNano: Date.now() * 1000000,
			};

			// Act
			mockEventStream.emit("data", Buffer.from(JSON.stringify(event)));
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Assert
			expect(onEvent).not.toHaveBeenCalled();
		});

		it("should ignore non-container events", async () => {
			// Arrange
			await service.start();
			const event = {
				Type: "network",
				Action: "create",
				Actor: { ID: "abc123", Attributes: { name: "test-network" } },
				time: Date.now() / 1000,
				timeNano: Date.now() * 1000000,
			};

			// Act
			mockEventStream.emit("data", Buffer.from(JSON.stringify(event)));
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Assert
			expect(onEvent).not.toHaveBeenCalled();
		});

		it("should ignore unmonitored event types", async () => {
			// Arrange
			await service.start();
			const event: DockerEvent = {
				Type: "container",
				Action: "create", // Not in monitored events
				Actor: {
					ID: "abc123def456789",
					Attributes: { name: "test-container", image: "test:latest" },
				},
				time: Date.now() / 1000,
				timeNano: Date.now() * 1000000,
			};

			// Act
			mockEventStream.emit("data", Buffer.from(JSON.stringify(event)));
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Assert
			expect(onEvent).not.toHaveBeenCalled();
		});

		it("should handle JSON parse errors", async () => {
			// Arrange
			await service.start();

			// Act
			mockEventStream.emit("data", Buffer.from("invalid json"));
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Assert
			expect(mockLogger._childLogger.error).toHaveBeenCalledWith(
				"Failed to process Docker event",
				expect.any(Object),
			);
			expect(onEvent).not.toHaveBeenCalled();
		});

		it("should handle stream errors", async () => {
			// Arrange
			await service.start();

			// Act
			mockEventStream.emit("error", new Error("Stream error"));

			// Assert
			expect(mockLogger._childLogger.error).toHaveBeenCalledWith(
				"Docker event stream error",
				{ error: "Stream error" },
			);
		});

		it("should monitor container if filter check fails", async () => {
			// Arrange
			mockDocker.listContainers.mockRejectedValue(new Error("API error"));
			await service.start();
			const event: DockerEvent = {
				Type: "container",
				Action: "die",
				Actor: {
					ID: "abc123def456789",
					Attributes: {
						name: "test-container",
						image: "test-image:latest",
					},
				},
				time: Date.now() / 1000,
				timeNano: Date.now() * 1000000,
			};

			// Act
			mockEventStream.emit("data", Buffer.from(JSON.stringify(event)));
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Assert
			expect(onEvent).toHaveBeenCalled();
		});
	});
});
