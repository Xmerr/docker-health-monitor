import { describe, expect, it } from "bun:test";
import {
	ContainerNotFoundError,
	DockerConnectionError,
	InvalidTriggerActionError,
} from "./index.js";

describe("DockerConnectionError", () => {
	it("should create error with message", () => {
		// Arrange & Act
		const error = new DockerConnectionError("Connection refused");

		// Assert
		expect(error.message).toBe("Connection refused");
		expect(error.name).toBe("DockerConnectionError");
		expect(error.errorCause).toBeUndefined();
	});

	it("should create error with cause", () => {
		// Arrange
		const cause = new Error("ECONNREFUSED");

		// Act
		const error = new DockerConnectionError("Connection refused", cause);

		// Assert
		expect(error.message).toBe("Connection refused");
		expect(error.errorCause).toBe(cause);
	});
});

describe("ContainerNotFoundError", () => {
	it("should create error with container id", () => {
		// Arrange & Act
		const error = new ContainerNotFoundError("abc123");

		// Assert
		expect(error.message).toBe("Container not found: abc123");
		expect(error.name).toBe("ContainerNotFoundError");
		expect(error.containerId).toBe("abc123");
	});
});

describe("InvalidTriggerActionError", () => {
	it("should create error with action", () => {
		// Arrange & Act
		const error = new InvalidTriggerActionError("invalid_action");

		// Assert
		expect(error.message).toBe("Invalid trigger action: invalid_action");
		expect(error.name).toBe("InvalidTriggerActionError");
		expect(error.action).toBe("invalid_action");
	});
});
