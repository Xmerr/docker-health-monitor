import type {
	AlertEvent,
	ContainerState,
	ContainerStatus,
	IContainerStateStore,
} from "../types/index.js";

const RESTART_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const UNHEALTHY_REALERT_MS = 15 * 60 * 1000; // 15 minutes

export class ContainerStateStore implements IContainerStateStore {
	private readonly states = new Map<string, ContainerState>();

	getState(containerId: string): ContainerState | undefined {
		return this.states.get(containerId);
	}

	setState(state: ContainerState): void {
		this.states.set(state.container_id, state);
	}

	deleteState(containerId: string): void {
		this.states.delete(containerId);
	}

	getAllStates(): Map<string, ContainerState> {
		return new Map(this.states);
	}

	shouldAlert(
		containerId: string,
		event: AlertEvent,
		restartCount: number,
		forceNotify = false,
	): boolean {
		// Force notify always triggers an alert
		if (forceNotify) {
			return true;
		}

		const state = this.states.get(containerId);

		// No state means first time seeing this container - always alert
		if (!state) {
			return true;
		}

		switch (event) {
			case "recovered":
				// Always alert on recovery
				return true;

			case "restarting":
				return this.shouldAlertRestart(state, restartCount);

			case "unhealthy":
				return this.shouldAlertUnhealthy(state);

			case "died":
			case "oom_killed":
				// Always alert on these critical events
				return true;

			default:
				return true;
		}
	}

	updateAlertTime(containerId: string, restartCount: number): void {
		const state = this.states.get(containerId);
		if (state) {
			state.last_alert_time = new Date().toISOString();
			state.restart_count_at_last_alert = restartCount;
		}
	}

	initializeState(
		containerId: string,
		containerName: string,
		status: ContainerStatus,
	): ContainerState {
		const state: ContainerState = {
			container_id: containerId,
			container_name: containerName,
			last_status: status,
			last_alert_time: null,
			restart_count_at_last_alert: 0,
			consecutive_restarts: 0,
			first_restart_in_window: null,
		};
		this.states.set(containerId, state);
		return state;
	}

	recordRestart(containerId: string): void {
		const state = this.states.get(containerId);
		if (!state) return;

		const now = Date.now();
		const firstRestartTime = state.first_restart_in_window
			? new Date(state.first_restart_in_window).getTime()
			: null;

		// Reset window if first restart was more than 10 minutes ago
		if (firstRestartTime && now - firstRestartTime > RESTART_WINDOW_MS) {
			state.consecutive_restarts = 1;
			state.first_restart_in_window = new Date().toISOString();
		} else {
			state.consecutive_restarts += 1;
			if (!state.first_restart_in_window) {
				state.first_restart_in_window = new Date().toISOString();
			}
		}
	}

	updateStatus(containerId: string, status: ContainerStatus): void {
		const state = this.states.get(containerId);
		if (state) {
			state.last_status = status;
		}
	}

	private shouldAlertRestart(
		state: ContainerState,
		restartCount: number,
	): boolean {
		const now = Date.now();
		const firstRestartTime = state.first_restart_in_window
			? new Date(state.first_restart_in_window).getTime()
			: null;

		// If we're outside the window, this is effectively a fresh restart
		if (!firstRestartTime || now - firstRestartTime > RESTART_WINDOW_MS) {
			return true;
		}

		const restartsInWindow = state.consecutive_restarts;

		// Alert on 1st, 3rd, 5th restart, then every 5th
		if (restartsInWindow <= 5) {
			return (
				restartsInWindow === 1 ||
				restartsInWindow === 3 ||
				restartsInWindow === 5
			);
		}

		// After 5, alert every 5th restart
		return restartsInWindow % 5 === 0;
	}

	private shouldAlertUnhealthy(state: ContainerState): boolean {
		const now = Date.now();
		const lastAlertTime = state.last_alert_time
			? new Date(state.last_alert_time).getTime()
			: null;

		// First unhealthy alert
		if (!lastAlertTime) {
			return true;
		}

		// Re-alert if it's been more than 15 minutes
		return now - lastAlertTime > UNHEALTHY_REALERT_MS;
	}
}
