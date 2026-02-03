import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { DockerStatusReport, IHealthChecker } from "../types/index.js";
import type { GraphQLContext } from "./resolvers.js";
import { resolvers } from "./resolvers.js";

describe("GraphQL Resolvers", () => {
	let mockHealthChecker: { generateStatusReport: ReturnType<typeof mock> };
	let context: GraphQLContext;

	const mockReport: DockerStatusReport = {
		containers: [
			{
				container_id: "abc123",
				container_name: "test-container",
				image: "test-image:latest",
				status: "healthy",
				uptime_seconds: 3600,
				restart_count: 0,
			},
			{
				container_id: "def456",
				container_name: "another-container",
				image: "another-image:v1",
				status: "running",
				uptime_seconds: 7200,
				restart_count: 2,
			},
		],
		timestamp: "2026-01-30T00:00:00.000Z",
	};

	beforeEach(() => {
		mockHealthChecker = {
			generateStatusReport: mock(() => Promise.resolve(mockReport)),
		};
		context = {
			healthChecker: mockHealthChecker as unknown as IHealthChecker,
		};
	});

	describe("Query.containers", () => {
		it("should return all containers with mapped fields", async () => {
			// Act
			const result = await resolvers.Query.containers(
				undefined,
				undefined,
				context,
			);

			// Assert
			expect(mockHealthChecker.generateStatusReport).toHaveBeenCalledTimes(1);
			expect(result).toHaveLength(2);
			expect(result[0]).toEqual({
				id: "abc123",
				name: "test-container",
				image: "test-image:latest",
				status: "HEALTHY",
				uptimeSeconds: 3600,
				restartCount: 0,
			});
			expect(result[1]).toEqual({
				id: "def456",
				name: "another-container",
				image: "another-image:v1",
				status: "RUNNING",
				uptimeSeconds: 7200,
				restartCount: 2,
			});
		});

		it("should return empty array when no containers", async () => {
			// Arrange
			mockHealthChecker.generateStatusReport.mockResolvedValue({
				containers: [],
				timestamp: "2026-01-30T00:00:00.000Z",
			});

			// Act
			const result = await resolvers.Query.containers(
				undefined,
				undefined,
				context,
			);

			// Assert
			expect(result).toEqual([]);
		});
	});

	describe("Query.container", () => {
		it("should return a container by ID", async () => {
			// Act
			const result = await resolvers.Query.container(
				undefined,
				{ id: "abc123" },
				context,
			);

			// Assert
			expect(result).toEqual({
				id: "abc123",
				name: "test-container",
				image: "test-image:latest",
				status: "HEALTHY",
				uptimeSeconds: 3600,
				restartCount: 0,
			});
		});

		it("should return null when container not found", async () => {
			// Act
			const result = await resolvers.Query.container(
				undefined,
				{ id: "nonexistent" },
				context,
			);

			// Assert
			expect(result).toBeNull();
		});
	});

	describe("Container.__resolveReference", () => {
		it("should resolve container by reference ID", async () => {
			// Act
			const result = await resolvers.Container.__resolveReference(
				{ id: "def456" },
				context,
			);

			// Assert
			expect(result).toEqual({
				id: "def456",
				name: "another-container",
				image: "another-image:v1",
				status: "RUNNING",
				uptimeSeconds: 7200,
				restartCount: 2,
			});
		});

		it("should return null when reference container not found", async () => {
			// Act
			const result = await resolvers.Container.__resolveReference(
				{ id: "nonexistent" },
				context,
			);

			// Assert
			expect(result).toBeNull();
		});
	});

	describe("Status mapping", () => {
		it.each([
			["running", "RUNNING"],
			["healthy", "HEALTHY"],
			["unhealthy", "UNHEALTHY"],
			["exited", "EXITED"],
			["restarting", "RESTARTING"],
		] as const)("should map %s to %s", async (input, expected) => {
			// Arrange
			mockHealthChecker.generateStatusReport.mockResolvedValue({
				containers: [
					{
						container_id: "test",
						container_name: "test",
						image: "test",
						status: input,
						uptime_seconds: 0,
						restart_count: 0,
					},
				],
				timestamp: "2026-01-30T00:00:00.000Z",
			});

			// Act
			const result = await resolvers.Query.containers(
				undefined,
				undefined,
				context,
			);

			// Assert
			expect(result[0].status).toBe(expected);
		});
	});

	describe("Subscription.containerAlert.resolve", () => {
		it("should map alert payload to GraphQL format", () => {
			// Arrange
			const alert = {
				container_id: "abc123",
				container_name: "test-container",
				image: "test-image:latest",
				event: "unhealthy" as const,
				exit_code: 1,
				restart_count: 3,
				health_status: "Connection refused",
				logs_tail: "Error: ECONNREFUSED",
				timestamp: "2026-01-30T00:00:00.000Z",
			};

			// Act
			const result = resolvers.Subscription.containerAlert.resolve(alert);

			// Assert
			expect(result).toEqual({
				containerId: "abc123",
				containerName: "test-container",
				image: "test-image:latest",
				event: "UNHEALTHY",
				exitCode: 1,
				restartCount: 3,
				healthStatus: "Connection refused",
				logsTail: "Error: ECONNREFUSED",
				timestamp: "2026-01-30T00:00:00.000Z",
			});
		});

		it("should handle null optional fields", () => {
			// Arrange
			const alert = {
				container_id: "abc123",
				container_name: "test-container",
				image: "test-image:latest",
				event: "died" as const,
				timestamp: "2026-01-30T00:00:00.000Z",
			};

			// Act
			const result = resolvers.Subscription.containerAlert.resolve(alert);

			// Assert
			expect(result).toEqual({
				containerId: "abc123",
				containerName: "test-container",
				image: "test-image:latest",
				event: "DIED",
				exitCode: null,
				restartCount: null,
				healthStatus: null,
				logsTail: null,
				timestamp: "2026-01-30T00:00:00.000Z",
			});
		});
	});
});
