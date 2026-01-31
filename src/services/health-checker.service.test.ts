import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type Docker from "dockerode";
import { ContainerNotFoundError } from "../errors/index.js";
import { ContainerStateStore } from "../state/container-state.store.js";
import type { DockerEvent } from "../types/index.js";
import { HealthCheckerService } from "./health-checker.service.js";

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

function createMockDocker() {
	return {
		listContainers: mock(() => Promise.resolve([])),
		getContainer: mock(() => ({
			inspect: mock(() => Promise.resolve({})),
		})),
	};
}

function createMockFilter() {
	return {
		shouldMonitor: mock(() => true),
	};
}

function createMockPublisher() {
	return {
		publishAlert: mock(() => Promise.resolve()),
		publishStatusReport: mock(() => Promise.resolve()),
	};
}

function createMockLogFetcher() {
	return {
		fetchLogs: mock(() => Promise.resolve("Sample logs")),
	};
}

function createMockContainer(
	overrides: Partial<Docker.ContainerInfo> = {},
): Docker.ContainerInfo {
	return {
		Id: "abc123def456789",
		Names: ["/test-container"],
		Image: "test-image:latest",
		ImageID: "sha256:abc123",
		Command: "node index.js",
		Created: Math.floor(Date.now() / 1000) - 3600,
		Ports: [],
		Labels: {},
		State: "running",
		Status: "Up 1 hour (healthy)",
		HostConfig: {
			NetworkMode: "bridge",
			RestartPolicy: { Name: "always", MaximumRetryCount: 0 },
		},
		NetworkSettings: { Networks: {} },
		Mounts: [],
		...overrides,
	} as Docker.ContainerInfo;
}

describe("HealthCheckerService", () => {
	let service: HealthCheckerService;
	let mockDocker: ReturnType<typeof createMockDocker>;
	let mockLogger: ReturnType<typeof createMockLogger>;
	let mockFilter: ReturnType<typeof createMockFilter>;
	let mockPublisher: ReturnType<typeof createMockPublisher>;
	let mockLogFetcher: ReturnType<typeof createMockLogFetcher>;
	let stateStore: ContainerStateStore;

	beforeEach(() => {
		mockDocker = createMockDocker();
		mockLogger = createMockLogger();
		mockFilter = createMockFilter();
		mockPublisher = createMockPublisher();
		mockLogFetcher = createMockLogFetcher();
		stateStore = new ContainerStateStore();

		service = new HealthCheckerService({
			docker: mockDocker as unknown as Docker,
			logger: mockLogger,
			containerFilter: mockFilter,
			stateStore,
			publisher: mockPublisher,
			logFetcher: mockLogFetcher,
			pollIntervalSeconds: 60,
		});
	});

	afterEach(() => {
		service.stop();
	});

	describe("start/stop", () => {
		it("should start polling", () => {
			// Act
			service.start();

			// Assert
			expect(mockLogger._childLogger.info).toHaveBeenCalledWith(
				"Health checker started",
				{ pollIntervalSeconds: 60 },
			);
		});

		it("should warn if already running", () => {
			// Arrange
			service.start();

			// Act
			service.start();

			// Assert
			expect(mockLogger._childLogger.warn).toHaveBeenCalledWith(
				"Health checker already running",
			);
		});

		it("should stop polling", () => {
			// Arrange
			service.start();

			// Act
			service.stop();

			// Assert
			expect(mockLogger._childLogger.info).toHaveBeenCalledWith(
				"Health checker stopped",
			);
		});
	});

	describe("pollContainers", () => {
		it("should poll all monitored containers", async () => {
			// Arrange
			const containers = [
				createMockContainer({ Id: "abc123" }),
				createMockContainer({ Id: "def456", Names: ["/container-2"] }),
			];
			mockDocker.listContainers.mockResolvedValue(containers);

			// Act
			await service.pollContainers();

			// Assert
			expect(mockDocker.listContainers).toHaveBeenCalledWith({ all: true });
			expect(mockFilter.shouldMonitor).toHaveBeenCalledTimes(2);
		});

		it("should skip filtered containers", async () => {
			// Arrange
			const containers = [createMockContainer()];
			mockDocker.listContainers.mockResolvedValue(containers);
			mockFilter.shouldMonitor.mockReturnValue(false);

			// Act
			await service.pollContainers();

			// Assert
			expect(mockPublisher.publishAlert).not.toHaveBeenCalled();
		});

		it("should detect unhealthy containers", async () => {
			// Arrange
			const containers = [
				createMockContainer({
					State: "running",
					Status: "Up 1 hour (unhealthy)",
				}),
			];
			mockDocker.listContainers.mockResolvedValue(containers);

			// Act
			await service.pollContainers();

			// Assert
			expect(mockPublisher.publishAlert).toHaveBeenCalledWith(
				expect.objectContaining({
					event: "unhealthy",
					container_name: "test-container",
				}),
			);
		});

		it("should detect recovery from unhealthy", async () => {
			// Arrange
			const containerId = "abc123def456789";
			stateStore.initializeState(containerId, "test-container", "unhealthy");

			const containers = [
				createMockContainer({
					Id: containerId,
					State: "running",
					Status: "Up 1 hour (healthy)",
				}),
			];
			mockDocker.listContainers.mockResolvedValue(containers);

			// Act
			await service.pollContainers();

			// Assert
			expect(mockPublisher.publishAlert).toHaveBeenCalledWith(
				expect.objectContaining({
					event: "recovered",
				}),
			);
		});

		it("should force notify when forceNotify is true", async () => {
			// Arrange
			const containers = [
				createMockContainer({
					State: "running",
					Status: "Up 1 hour (unhealthy)",
				}),
			];
			mockDocker.listContainers.mockResolvedValue(containers);

			// First poll to set initial state
			await service.pollContainers();
			mockPublisher.publishAlert.mockClear();

			// Set last alert time recently (within dedup window)
			const state = stateStore.getState("abc123def456789");
			if (state) {
				state.last_alert_time = new Date().toISOString();
			}

			// Act - force notify should bypass deduplication
			await service.pollContainers(true);

			// Assert
			expect(mockPublisher.publishAlert).toHaveBeenCalled();
		});

		it("should handle errors gracefully", async () => {
			// Arrange
			mockDocker.listContainers.mockRejectedValue(new Error("API error"));

			// Act
			await service.pollContainers();

			// Assert
			expect(mockLogger._childLogger.error).toHaveBeenCalledWith(
				"Failed to poll containers",
				{ error: "API error" },
			);
		});
	});

	describe("checkSingleContainer", () => {
		it("should check specific container", async () => {
			// Arrange
			const containers = [
				createMockContainer({
					Id: "abc123def456789",
					State: "running",
					Status: "Up 1 hour (unhealthy)",
				}),
			];
			mockDocker.listContainers.mockResolvedValue(containers);

			// Act
			await service.checkSingleContainer("abc123");

			// Assert
			expect(mockDocker.listContainers).toHaveBeenCalledWith({
				all: true,
				filters: { id: ["abc123"] },
			});
			expect(mockPublisher.publishAlert).toHaveBeenCalled();
		});

		it("should throw ContainerNotFoundError for unknown container", async () => {
			// Arrange
			mockDocker.listContainers.mockResolvedValue([]);

			// Act & Assert
			await expect(service.checkSingleContainer("unknown")).rejects.toThrow(
				ContainerNotFoundError,
			);
		});
	});

	describe("generateStatusReport", () => {
		it("should generate and publish status report", async () => {
			// Arrange
			const containers = [
				createMockContainer({
					Id: "abc123def456789",
					Names: ["/container-1"],
					Image: "image-1:latest",
					State: "running",
					Status: "Up 1 hour (healthy)",
				}),
				createMockContainer({
					Id: "def456ghi789012",
					Names: ["/container-2"],
					Image: "image-2:latest",
					State: "running",
					Status: "Up 2 hours",
				}),
			];
			mockDocker.listContainers.mockResolvedValue(containers);

			// Act
			const report = await service.generateStatusReport();

			// Assert
			expect(report.containers).toHaveLength(2);
			expect(report.containers[0]).toMatchObject({
				container_id: "abc123def456",
				container_name: "container-1",
				status: "healthy",
			});
			expect(mockPublisher.publishStatusReport).toHaveBeenCalledWith(report);
		});

		it("should skip filtered containers in report", async () => {
			// Arrange
			mockFilter.shouldMonitor.mockReturnValue(false);
			mockDocker.listContainers.mockResolvedValue([createMockContainer()]);

			// Act
			const report = await service.generateStatusReport();

			// Assert
			expect(report.containers).toHaveLength(0);
		});
	});

	describe("handleDockerEvent", () => {
		describe("die event", () => {
			it("should publish died alert with exit code", async () => {
				// Arrange
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
				await service.handleDockerEvent(event);

				// Assert
				expect(mockPublisher.publishAlert).toHaveBeenCalledWith(
					expect.objectContaining({
						event: "died",
						exit_code: 1,
						container_name: "test-container",
						logs_tail: "Sample logs",
					}),
				);
			});
		});

		describe("restart event", () => {
			it("should track restarts and alert on 1st restart", async () => {
				// Arrange
				const event: DockerEvent = {
					Type: "container",
					Action: "restart",
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
				await service.handleDockerEvent(event);

				// Assert
				expect(mockPublisher.publishAlert).toHaveBeenCalledWith(
					expect.objectContaining({
						event: "restarting",
						restart_count: 1,
					}),
				);
			});

			it("should not alert on 2nd restart within window", async () => {
				// Arrange
				const event: DockerEvent = {
					Type: "container",
					Action: "restart",
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
				await service.handleDockerEvent(event); // 1st restart
				mockPublisher.publishAlert.mockClear();
				await service.handleDockerEvent(event); // 2nd restart

				// Assert
				expect(mockPublisher.publishAlert).not.toHaveBeenCalled();
			});
		});

		describe("health_status event", () => {
			it("should publish unhealthy alert", async () => {
				// Arrange
				const event: DockerEvent = {
					Type: "container",
					Action: "health_status",
					Actor: {
						ID: "abc123def456789",
						Attributes: {
							name: "test-container",
							image: "test-image:latest",
							health_status: "unhealthy",
						},
					},
					time: Date.now() / 1000,
					timeNano: Date.now() * 1000000,
				};

				// Act
				await service.handleDockerEvent(event);

				// Assert
				expect(mockPublisher.publishAlert).toHaveBeenCalledWith(
					expect.objectContaining({
						event: "unhealthy",
						health_status: "unhealthy",
					}),
				);
			});

			it("should publish recovered alert when healthy after unhealthy", async () => {
				// Arrange
				stateStore.initializeState(
					"abc123def456789",
					"test-container",
					"unhealthy",
				);
				const event: DockerEvent = {
					Type: "container",
					Action: "health_status",
					Actor: {
						ID: "abc123def456789",
						Attributes: {
							name: "test-container",
							image: "test-image:latest",
							health_status: "healthy",
						},
					},
					time: Date.now() / 1000,
					timeNano: Date.now() * 1000000,
				};

				// Act
				await service.handleDockerEvent(event);

				// Assert
				expect(mockPublisher.publishAlert).toHaveBeenCalledWith(
					expect.objectContaining({
						event: "recovered",
					}),
				);
			});
		});

		describe("oom event", () => {
			it("should always publish OOM alert", async () => {
				// Arrange
				const event: DockerEvent = {
					Type: "container",
					Action: "oom",
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
				await service.handleDockerEvent(event);

				// Assert
				expect(mockPublisher.publishAlert).toHaveBeenCalledWith(
					expect.objectContaining({
						event: "oom_killed",
						logs_tail: "Sample logs",
					}),
				);
			});
		});

		describe("start event", () => {
			it("should initialize state on start", async () => {
				// Arrange
				const event: DockerEvent = {
					Type: "container",
					Action: "start",
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
				await service.handleDockerEvent(event);

				// Assert
				const state = stateStore.getState("abc123def456789");
				expect(state?.last_status).toBe("running");
			});
		});
	});
});
