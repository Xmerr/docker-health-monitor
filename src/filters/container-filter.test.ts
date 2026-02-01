import { describe, expect, it } from "bun:test";
import type Docker from "dockerode";
import { ContainerFilter } from "./container-filter.js";

function createMockContainer(
	overrides: Partial<Docker.ContainerInfo> = {},
): Docker.ContainerInfo {
	return {
		Id: "abc123def456789",
		Names: ["/test-container"],
		Image: "test-image:latest",
		ImageID: "sha256:abc123",
		Command: "node index.js",
		Created: Date.now() / 1000,
		Ports: [],
		Labels: {},
		State: "running",
		Status: "Up 5 minutes",
		HostConfig: {
			NetworkMode: "bridge",
			RestartPolicy: {
				Name: "always",
				MaximumRetryCount: 0,
			},
		},
		NetworkSettings: {
			Networks: {},
		},
		Mounts: [],
		...overrides,
	} as Docker.ContainerInfo;
}

describe("ContainerFilter", () => {
	describe("shouldMonitor with no config", () => {
		it("should monitor running container", () => {
			// Arrange
			const filter = new ContainerFilter({});
			const container = createMockContainer({
				State: "running",
			});

			// Act
			const result = filter.shouldMonitor(container);

			// Assert
			expect(result).toBe(true);
		});

		it("should monitor restarting container", () => {
			// Arrange
			const filter = new ContainerFilter({});
			const container = createMockContainer({
				State: "restarting",
			});

			// Act
			const result = filter.shouldMonitor(container);

			// Assert
			expect(result).toBe(true);
		});

		it("should not monitor exited container", () => {
			// Arrange
			const filter = new ContainerFilter({});
			const container = createMockContainer({
				State: "exited",
			});

			// Act
			const result = filter.shouldMonitor(container);

			// Assert
			expect(result).toBe(false);
		});

		it("should not monitor paused container", () => {
			// Arrange
			const filter = new ContainerFilter({});
			const container = createMockContainer({
				State: "paused",
			});

			// Act
			const result = filter.shouldMonitor(container);

			// Assert
			expect(result).toBe(false);
		});
	});

	describe("shouldMonitor with include patterns", () => {
		it("should monitor container matching include pattern", () => {
			// Arrange
			const filter = new ContainerFilter({
				include_patterns: ["*-consumer"],
			});
			const container = createMockContainer({
				Names: ["/notification-consumer"],
			});

			// Act
			const result = filter.shouldMonitor(container);

			// Assert
			expect(result).toBe(true);
		});

		it("should not monitor container not matching include pattern", () => {
			// Arrange
			const filter = new ContainerFilter({
				include_patterns: ["*-consumer"],
			});
			const container = createMockContainer({
				Names: ["/web-server"],
			});

			// Act
			const result = filter.shouldMonitor(container);

			// Assert
			expect(result).toBe(false);
		});

		it("should monitor container matching any include pattern", () => {
			// Arrange
			const filter = new ContainerFilter({
				include_patterns: ["*-consumer", "notification-*"],
			});
			const container = createMockContainer({
				Names: ["/notification-service"],
			});

			// Act
			const result = filter.shouldMonitor(container);

			// Assert
			expect(result).toBe(true);
		});

		it("should match pattern with leading wildcard", () => {
			// Arrange
			const filter = new ContainerFilter({
				include_patterns: ["*-service"],
			});
			const container = createMockContainer({
				Names: ["/notification-service"],
			});

			// Act
			const result = filter.shouldMonitor(container);

			// Assert
			expect(result).toBe(true);
		});

		it("should match pattern with trailing wildcard", () => {
			// Arrange
			const filter = new ContainerFilter({
				include_patterns: ["notification-*"],
			});
			const container = createMockContainer({
				Names: ["/notification-consumer"],
			});

			// Act
			const result = filter.shouldMonitor(container);

			// Assert
			expect(result).toBe(true);
		});

		it("should match exact pattern", () => {
			// Arrange
			const filter = new ContainerFilter({
				include_patterns: ["my-exact-service"],
			});
			const container = createMockContainer({
				Names: ["/my-exact-service"],
			});

			// Act
			const result = filter.shouldMonitor(container);

			// Assert
			expect(result).toBe(true);
		});
	});

	describe("shouldMonitor with exclude patterns", () => {
		it("should not monitor container matching exclude pattern", () => {
			// Arrange
			const filter = new ContainerFilter({
				exclude_patterns: ["*-test"],
			});
			const container = createMockContainer({
				Names: ["/notification-test"],
				HostConfig: {
					NetworkMode: "bridge",
					RestartPolicy: { Name: "always", MaximumRetryCount: 0 },
				},
			});

			// Act
			const result = filter.shouldMonitor(container);

			// Assert
			expect(result).toBe(false);
		});

		it("should exclude even if container matches include pattern", () => {
			// Arrange
			const filter = new ContainerFilter({
				include_patterns: ["*-consumer"],
				exclude_patterns: ["*-test-consumer"],
			});
			const container = createMockContainer({
				Names: ["/notification-test-consumer"],
			});

			// Act
			const result = filter.shouldMonitor(container);

			// Assert
			expect(result).toBe(false);
		});
	});

	describe("shouldMonitor with required labels", () => {
		it("should monitor container with required label", () => {
			// Arrange
			const filter = new ContainerFilter({
				required_labels: { monitor: "true" },
			});
			const container = createMockContainer({
				Labels: { monitor: "true" },
				HostConfig: {
					NetworkMode: "bridge",
					RestartPolicy: { Name: "always", MaximumRetryCount: 0 },
				},
			});

			// Act
			const result = filter.shouldMonitor(container);

			// Assert
			expect(result).toBe(true);
		});

		it("should not monitor container missing required label", () => {
			// Arrange
			const filter = new ContainerFilter({
				required_labels: { monitor: "true" },
			});
			const container = createMockContainer({
				Labels: {},
				HostConfig: {
					NetworkMode: "bridge",
					RestartPolicy: { Name: "always", MaximumRetryCount: 0 },
				},
			});

			// Act
			const result = filter.shouldMonitor(container);

			// Assert
			expect(result).toBe(false);
		});

		it("should not monitor container with wrong label value", () => {
			// Arrange
			const filter = new ContainerFilter({
				required_labels: { env: "production" },
			});
			const container = createMockContainer({
				Labels: { env: "development" },
				HostConfig: {
					NetworkMode: "bridge",
					RestartPolicy: { Name: "always", MaximumRetryCount: 0 },
				},
			});

			// Act
			const result = filter.shouldMonitor(container);

			// Assert
			expect(result).toBe(false);
		});

		it("should require all labels", () => {
			// Arrange
			const filter = new ContainerFilter({
				required_labels: { monitor: "true", env: "production" },
			});
			const container = createMockContainer({
				Labels: { monitor: "true" },
				HostConfig: {
					NetworkMode: "bridge",
					RestartPolicy: { Name: "always", MaximumRetryCount: 0 },
				},
			});

			// Act
			const result = filter.shouldMonitor(container);

			// Assert
			expect(result).toBe(false);
		});
	});

	describe("edge cases", () => {
		it("should handle container with no names", () => {
			// Arrange
			const filter = new ContainerFilter({
				include_patterns: ["abc123*"],
			});
			const container = createMockContainer({
				Id: "abc123def456789",
				Names: [],
			});

			// Act
			const result = filter.shouldMonitor(container);

			// Assert
			expect(result).toBe(true);
		});

		it("should handle case-insensitive pattern matching", () => {
			// Arrange
			const filter = new ContainerFilter({
				include_patterns: ["*-Consumer"],
			});
			const container = createMockContainer({
				Names: ["/notification-consumer"],
			});

			// Act
			const result = filter.shouldMonitor(container);

			// Assert
			expect(result).toBe(true);
		});
	});
});
