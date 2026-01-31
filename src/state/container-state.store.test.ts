import { beforeEach, describe, expect, it } from "bun:test";
import type { ContainerState } from "../types/index.js";
import { ContainerStateStore } from "./container-state.store.js";

describe("ContainerStateStore", () => {
	let store: ContainerStateStore;

	beforeEach(() => {
		store = new ContainerStateStore();
	});

	describe("basic operations", () => {
		it("should return undefined for unknown container", () => {
			// Act
			const state = store.getState("unknown");

			// Assert
			expect(state).toBeUndefined();
		});

		it("should store and retrieve state", () => {
			// Arrange
			const state: ContainerState = {
				container_id: "abc123",
				container_name: "test-container",
				last_status: "running",
				last_alert_time: null,
				restart_count_at_last_alert: 0,
				consecutive_restarts: 0,
				first_restart_in_window: null,
			};

			// Act
			store.setState(state);
			const retrieved = store.getState("abc123");

			// Assert
			expect(retrieved).toEqual(state);
		});

		it("should delete state", () => {
			// Arrange
			const state: ContainerState = {
				container_id: "abc123",
				container_name: "test-container",
				last_status: "running",
				last_alert_time: null,
				restart_count_at_last_alert: 0,
				consecutive_restarts: 0,
				first_restart_in_window: null,
			};
			store.setState(state);

			// Act
			store.deleteState("abc123");

			// Assert
			expect(store.getState("abc123")).toBeUndefined();
		});

		it("should return all states", () => {
			// Arrange
			store.initializeState("abc123", "container-1", "running");
			store.initializeState("def456", "container-2", "healthy");

			// Act
			const allStates = store.getAllStates();

			// Assert
			expect(allStates.size).toBe(2);
			expect(allStates.get("abc123")?.container_name).toBe("container-1");
			expect(allStates.get("def456")?.container_name).toBe("container-2");
		});
	});

	describe("initializeState", () => {
		it("should create and store new state", () => {
			// Act
			const state = store.initializeState(
				"abc123",
				"test-container",
				"running",
			);

			// Assert
			expect(state.container_id).toBe("abc123");
			expect(state.container_name).toBe("test-container");
			expect(state.last_status).toBe("running");
			expect(state.last_alert_time).toBeNull();
			expect(state.consecutive_restarts).toBe(0);
			expect(store.getState("abc123")).toBe(state);
		});
	});

	describe("shouldAlert", () => {
		describe("force notify", () => {
			it("should always alert when force_notify is true", () => {
				// Arrange
				store.initializeState("abc123", "test", "running");
				store.updateAlertTime("abc123", 0);

				// Act
				const result = store.shouldAlert("abc123", "unhealthy", 0, true);

				// Assert
				expect(result).toBe(true);
			});
		});

		describe("no existing state", () => {
			it("should alert on first occurrence", () => {
				// Act
				const result = store.shouldAlert("unknown", "unhealthy", 0);

				// Assert
				expect(result).toBe(true);
			});
		});

		describe("recovered event", () => {
			it("should always alert on recovery", () => {
				// Arrange
				store.initializeState("abc123", "test", "unhealthy");

				// Act
				const result = store.shouldAlert("abc123", "recovered", 0);

				// Assert
				expect(result).toBe(true);
			});
		});

		describe("died event", () => {
			it("should always alert on container death", () => {
				// Arrange
				store.initializeState("abc123", "test", "running");

				// Act
				const result = store.shouldAlert("abc123", "died", 0);

				// Assert
				expect(result).toBe(true);
			});
		});

		describe("oom_killed event", () => {
			it("should always alert on OOM kill", () => {
				// Arrange
				store.initializeState("abc123", "test", "running");

				// Act
				const result = store.shouldAlert("abc123", "oom_killed", 0);

				// Assert
				expect(result).toBe(true);
			});
		});

		describe("restarting event", () => {
			it("should alert on 1st restart in window", () => {
				// Arrange
				store.initializeState("abc123", "test", "running");
				store.recordRestart("abc123");

				// Act
				const result = store.shouldAlert("abc123", "restarting", 1);

				// Assert
				expect(result).toBe(true);
			});

			it("should not alert on 2nd restart in window", () => {
				// Arrange
				store.initializeState("abc123", "test", "running");
				store.recordRestart("abc123");
				store.recordRestart("abc123");

				// Act
				const result = store.shouldAlert("abc123", "restarting", 2);

				// Assert
				expect(result).toBe(false);
			});

			it("should alert on 3rd restart in window", () => {
				// Arrange
				store.initializeState("abc123", "test", "running");
				store.recordRestart("abc123");
				store.recordRestart("abc123");
				store.recordRestart("abc123");

				// Act
				const result = store.shouldAlert("abc123", "restarting", 3);

				// Assert
				expect(result).toBe(true);
			});

			it("should not alert on 4th restart in window", () => {
				// Arrange
				store.initializeState("abc123", "test", "running");
				for (let i = 0; i < 4; i++) {
					store.recordRestart("abc123");
				}

				// Act
				const result = store.shouldAlert("abc123", "restarting", 4);

				// Assert
				expect(result).toBe(false);
			});

			it("should alert on 5th restart in window", () => {
				// Arrange
				store.initializeState("abc123", "test", "running");
				for (let i = 0; i < 5; i++) {
					store.recordRestart("abc123");
				}

				// Act
				const result = store.shouldAlert("abc123", "restarting", 5);

				// Assert
				expect(result).toBe(true);
			});

			it("should alert every 5th restart after 5", () => {
				// Arrange
				store.initializeState("abc123", "test", "running");
				for (let i = 0; i < 10; i++) {
					store.recordRestart("abc123");
				}

				// Act
				const result = store.shouldAlert("abc123", "restarting", 10);

				// Assert
				expect(result).toBe(true);
			});

			it("should not alert on non-5th restart after 5", () => {
				// Arrange
				store.initializeState("abc123", "test", "running");
				for (let i = 0; i < 7; i++) {
					store.recordRestart("abc123");
				}

				// Act
				const result = store.shouldAlert("abc123", "restarting", 7);

				// Assert
				expect(result).toBe(false);
			});
		});

		describe("unhealthy event", () => {
			it("should alert on first unhealthy", () => {
				// Arrange
				store.initializeState("abc123", "test", "healthy");

				// Act
				const result = store.shouldAlert("abc123", "unhealthy", 0);

				// Assert
				expect(result).toBe(true);
			});

			it("should not re-alert within 15 minutes", () => {
				// Arrange
				store.initializeState("abc123", "test", "unhealthy");
				store.updateAlertTime("abc123", 0);

				// Act
				const result = store.shouldAlert("abc123", "unhealthy", 0);

				// Assert
				expect(result).toBe(false);
			});

			it("should re-alert after 15 minutes", () => {
				// Arrange
				store.initializeState("abc123", "test", "unhealthy");
				const state = store.getState("abc123");
				if (state) {
					// Set last alert time to 16 minutes ago
					const sixteenMinutesAgo = new Date(
						Date.now() - 16 * 60 * 1000,
					).toISOString();
					state.last_alert_time = sixteenMinutesAgo;
				}

				// Act
				const result = store.shouldAlert("abc123", "unhealthy", 0);

				// Assert
				expect(result).toBe(true);
			});
		});
	});

	describe("recordRestart", () => {
		it("should increment consecutive restarts", () => {
			// Arrange
			store.initializeState("abc123", "test", "running");

			// Act
			store.recordRestart("abc123");

			// Assert
			const state = store.getState("abc123");
			expect(state?.consecutive_restarts).toBe(1);
			expect(state?.first_restart_in_window).not.toBeNull();
		});

		it("should reset window after 10 minutes", () => {
			// Arrange
			store.initializeState("abc123", "test", "running");
			const state = store.getState("abc123");
			if (state) {
				state.consecutive_restarts = 5;
				// Set first restart to 11 minutes ago
				state.first_restart_in_window = new Date(
					Date.now() - 11 * 60 * 1000,
				).toISOString();
			}

			// Act
			store.recordRestart("abc123");

			// Assert
			const updatedState = store.getState("abc123");
			expect(updatedState?.consecutive_restarts).toBe(1);
		});

		it("should do nothing for unknown container", () => {
			// Act & Assert (should not throw)
			store.recordRestart("unknown");
		});
	});

	describe("updateAlertTime", () => {
		it("should update alert time and restart count", () => {
			// Arrange
			store.initializeState("abc123", "test", "running");

			// Act
			store.updateAlertTime("abc123", 3);

			// Assert
			const state = store.getState("abc123");
			expect(state?.last_alert_time).not.toBeNull();
			expect(state?.restart_count_at_last_alert).toBe(3);
		});

		it("should do nothing for unknown container", () => {
			// Act & Assert (should not throw)
			store.updateAlertTime("unknown", 3);
		});
	});

	describe("updateStatus", () => {
		it("should update container status", () => {
			// Arrange
			store.initializeState("abc123", "test", "running");

			// Act
			store.updateStatus("abc123", "unhealthy");

			// Assert
			const state = store.getState("abc123");
			expect(state?.last_status).toBe("unhealthy");
		});

		it("should do nothing for unknown container", () => {
			// Act & Assert (should not throw)
			store.updateStatus("unknown", "unhealthy");
		});
	});
});
