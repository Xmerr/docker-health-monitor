import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ContainerAlert, DockerStatusReport } from "../types/index.js";
import { DockerPublisher } from "./docker.publisher.js";

function createMockChannel() {
	return {
		assertExchange: mock(() => Promise.resolve()),
		bindExchange: mock(() => Promise.resolve()),
		publish: mock(() => true),
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

describe("DockerPublisher", () => {
	let publisher: DockerPublisher;
	let mockChannel: ReturnType<typeof createMockChannel>;
	let mockLogger: ReturnType<typeof createMockLogger>;

	beforeEach(() => {
		mockChannel = createMockChannel();
		mockLogger = createMockLogger();
		publisher = new DockerPublisher({
			channel: mockChannel as unknown as import("amqplib").Channel,
			exchange: "docker",
			notificationsExchange: "notifications",
			logger: mockLogger,
		});
	});

	describe("publishAlert", () => {
		it("should publish unhealthy alert with correct routing key", async () => {
			// Arrange
			const alert: ContainerAlert = {
				container_id: "abc123",
				container_name: "test-container",
				image: "test-image:latest",
				event: "unhealthy",
				health_status: "Connection refused",
				timestamp: new Date().toISOString(),
			};

			// Act
			await publisher.publishAlert(alert);

			// Assert
			expect(mockChannel.publish).toHaveBeenCalledWith(
				"docker",
				"container.unhealthy",
				expect.any(Buffer),
				{ persistent: true, contentType: "application/json" },
			);
		});

		it("should publish died alert with correct routing key", async () => {
			// Arrange
			const alert: ContainerAlert = {
				container_id: "abc123",
				container_name: "test-container",
				image: "test-image:latest",
				event: "died",
				exit_code: 1,
				timestamp: new Date().toISOString(),
			};

			// Act
			await publisher.publishAlert(alert);

			// Assert
			expect(mockChannel.publish).toHaveBeenCalledWith(
				"docker",
				"container.died",
				expect.any(Buffer),
				expect.any(Object),
			);
		});

		it("should publish restarting alert with correct routing key", async () => {
			// Arrange
			const alert: ContainerAlert = {
				container_id: "abc123",
				container_name: "test-container",
				image: "test-image:latest",
				event: "restarting",
				restart_count: 3,
				timestamp: new Date().toISOString(),
			};

			// Act
			await publisher.publishAlert(alert);

			// Assert
			expect(mockChannel.publish).toHaveBeenCalledWith(
				"docker",
				"container.restarting",
				expect.any(Buffer),
				expect.any(Object),
			);
		});

		it("should publish oom_killed alert with correct routing key", async () => {
			// Arrange
			const alert: ContainerAlert = {
				container_id: "abc123",
				container_name: "test-container",
				image: "test-image:latest",
				event: "oom_killed",
				timestamp: new Date().toISOString(),
			};

			// Act
			await publisher.publishAlert(alert);

			// Assert
			expect(mockChannel.publish).toHaveBeenCalledWith(
				"docker",
				"container.oom",
				expect.any(Buffer),
				expect.any(Object),
			);
		});

		it("should publish recovered alert with correct routing key", async () => {
			// Arrange
			const alert: ContainerAlert = {
				container_id: "abc123",
				container_name: "test-container",
				image: "test-image:latest",
				event: "recovered",
				timestamp: new Date().toISOString(),
			};

			// Act
			await publisher.publishAlert(alert);

			// Assert
			expect(mockChannel.publish).toHaveBeenCalledWith(
				"docker",
				"container.recovered",
				expect.any(Buffer),
				expect.any(Object),
			);
		});

		it("should assert exchanges and bindings on first publish", async () => {
			// Arrange
			const alert: ContainerAlert = {
				container_id: "abc123",
				container_name: "test-container",
				image: "test-image:latest",
				event: "unhealthy",
				timestamp: new Date().toISOString(),
			};

			// Act
			await publisher.publishAlert(alert);

			// Assert
			expect(mockChannel.assertExchange).toHaveBeenCalledWith(
				"docker",
				"topic",
				{ durable: true },
			);
			expect(mockChannel.assertExchange).toHaveBeenCalledWith(
				"notifications",
				"topic",
				{ durable: true },
			);
			// Should bind 5 routing keys
			expect(mockChannel.bindExchange).toHaveBeenCalledTimes(5);
		});

		it("should not re-assert exchanges on subsequent publishes", async () => {
			// Arrange
			const alert: ContainerAlert = {
				container_id: "abc123",
				container_name: "test-container",
				image: "test-image:latest",
				event: "unhealthy",
				timestamp: new Date().toISOString(),
			};

			// Act
			await publisher.publishAlert(alert);
			await publisher.publishAlert(alert);

			// Assert
			expect(mockChannel.assertExchange).toHaveBeenCalledTimes(2); // Once for each exchange
		});

		it("should serialize alert as JSON", async () => {
			// Arrange
			const alert: ContainerAlert = {
				container_id: "abc123",
				container_name: "test-container",
				image: "test-image:latest",
				event: "unhealthy",
				health_status: "Connection refused",
				logs_tail: "Error: ECONNREFUSED",
				timestamp: "2026-01-30T00:00:00.000Z",
			};

			// Act
			await publisher.publishAlert(alert);

			// Assert
			const publishCall = mockChannel.publish.mock.calls[0];
			const buffer = publishCall?.[2] as Buffer;
			const parsed = JSON.parse(buffer.toString());
			expect(parsed).toEqual(alert);
		});
	});

	describe("publishStatusReport", () => {
		it("should publish status report with correct routing key", async () => {
			// Arrange
			const report: DockerStatusReport = {
				containers: [
					{
						container_id: "abc123",
						container_name: "test-container",
						image: "test-image:latest",
						status: "healthy",
						uptime_seconds: 3600,
						restart_count: 0,
					},
				],
				timestamp: new Date().toISOString(),
			};

			// Act
			await publisher.publishStatusReport(report);

			// Assert
			expect(mockChannel.publish).toHaveBeenCalledWith(
				"docker",
				"status.report",
				expect.any(Buffer),
				{ persistent: true, contentType: "application/json" },
			);
		});

		it("should log container count", async () => {
			// Arrange
			const report: DockerStatusReport = {
				containers: [
					{
						container_id: "abc123",
						container_name: "container-1",
						image: "image:latest",
						status: "running",
						uptime_seconds: 100,
						restart_count: 0,
					},
					{
						container_id: "def456",
						container_name: "container-2",
						image: "image:latest",
						status: "healthy",
						uptime_seconds: 200,
						restart_count: 1,
					},
				],
				timestamp: new Date().toISOString(),
			};

			// Act
			await publisher.publishStatusReport(report);

			// Assert
			expect(mockLogger._childLogger.info).toHaveBeenCalledWith(
				"Status report published",
				{ containerCount: 2 },
			);
		});
	});
});
