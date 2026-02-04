import type { ILogger } from "@xmer/consumer-shared";
import type Docker from "dockerode";
import { ContainerNotFoundError } from "../errors/index.js";
import type { ContainerStateStore } from "../state/container-state.store.js";
import type {
	AlertEvent,
	ContainerAlert,
	ContainerState,
	ContainerStatus,
	ContainerStatusInfo,
	DockerEvent,
	DockerStatusReport,
	HealthCheckerOptions,
	IContainerFilter,
	IDockerPublisher,
	IHealthChecker,
	ILogFetcher,
} from "../types/index.js";

export class HealthCheckerService implements IHealthChecker {
	private readonly docker: Docker;
	private readonly logger: ILogger;
	private readonly containerFilter: IContainerFilter;
	private readonly stateStore: ContainerStateStore;
	private readonly publisher: IDockerPublisher;
	private readonly logFetcher: ILogFetcher;
	private readonly pollIntervalMs: number;
	private pollTimer: ReturnType<typeof setInterval> | null = null;

	constructor(options: HealthCheckerOptions) {
		this.docker = options.docker;
		this.logger = options.logger.child({ component: "HealthCheckerService" });
		this.containerFilter = options.containerFilter;
		this.stateStore = options.stateStore as ContainerStateStore;
		this.publisher = options.publisher;
		this.logFetcher = options.logFetcher;
		this.pollIntervalMs = options.pollIntervalSeconds * 1000;
	}

	start(): void {
		if (this.pollTimer) {
			this.logger.warn("Health checker already running");
			return;
		}

		this.pollTimer = setInterval(() => {
			void this.pollContainers();
		}, this.pollIntervalMs);

		// Run initial poll
		void this.pollContainers();

		this.logger.info("Health checker started", {
			pollIntervalSeconds: this.pollIntervalMs / 1000,
		});
	}

	stop(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		this.logger.info("Health checker stopped");
	}

	async pollContainers(forceNotify = false): Promise<void> {
		try {
			const containers = await this.docker.listContainers({ all: true });

			for (const containerInfo of containers) {
				if (!this.containerFilter.shouldMonitor(containerInfo)) {
					continue;
				}

				await this.checkContainer(containerInfo, forceNotify);
			}
		} catch (error) {
			this.logger.error("Failed to poll containers", {
				error: (error as Error).message,
			});
		}
	}

	async checkSingleContainer(
		containerId: string,
		forceNotify = false,
	): Promise<void> {
		try {
			const containers = await this.docker.listContainers({
				all: true,
				filters: { id: [containerId] },
			});

			const containerInfo = containers[0];
			if (!containerInfo) {
				throw new ContainerNotFoundError(containerId);
			}

			await this.checkContainer(containerInfo, forceNotify);
		} catch (error) {
			if (error instanceof ContainerNotFoundError) {
				throw error;
			}
			this.logger.error("Failed to check container", {
				containerId,
				error: (error as Error).message,
			});
		}
	}

	async generateStatusReport(): Promise<DockerStatusReport> {
		const containers = await this.docker.listContainers({ all: true });
		const statusInfos: ContainerStatusInfo[] = [];

		for (const containerInfo of containers) {
			if (!this.containerFilter.shouldMonitor(containerInfo)) {
				continue;
			}

			const status = this.getContainerStatus(containerInfo);

			// Inspect container to get accurate StartedAt time and RestartCount
			let uptimeSeconds = 0;
			let restartCount = 0;
			try {
				const container = this.docker.getContainer(containerInfo.Id);
				const inspectInfo = await container.inspect();
				restartCount = inspectInfo.RestartCount ?? 0;

				// Use StartedAt for accurate uptime (not Created which is creation time)
				const startedAt = inspectInfo.State?.StartedAt;
				if (startedAt && startedAt !== "0001-01-01T00:00:00Z") {
					const startTime = new Date(startedAt).getTime() / 1000;
					uptimeSeconds = Math.floor(Date.now() / 1000 - startTime);
				}
			} catch (error) {
				this.logger.warn("Failed to inspect container for uptime", {
					containerId: containerInfo.Id,
					error: (error as Error).message,
				});
			}

			statusInfos.push({
				container_id: containerInfo.Id.slice(0, 12),
				container_name: this.getContainerName(containerInfo),
				image: containerInfo.Image,
				status,
				uptime_seconds: uptimeSeconds > 0 ? uptimeSeconds : 0,
				restart_count: restartCount,
			});
		}

		const report: DockerStatusReport = {
			containers: statusInfos,
			timestamp: new Date().toISOString(),
		};

		await this.publisher.publishStatusReport(report);
		return report;
	}

	async handleDockerEvent(event: DockerEvent): Promise<void> {
		const containerId = event.Actor.ID;
		const containerName =
			event.Actor.Attributes.name ?? containerId.slice(0, 12);
		const image = event.Actor.Attributes.image ?? "unknown";

		this.logger.debug("Handling Docker event", {
			action: event.Action,
			containerId: containerId.slice(0, 12),
			containerName,
		});

		switch (event.Action) {
			case "die":
				await this.handleDie(containerId, containerName, image, event);
				break;
			case "restart":
				await this.handleRestart(containerId, containerName, image);
				break;
			case "health_status":
				await this.handleHealthStatus(containerId, containerName, image, event);
				break;
			case "oom":
				await this.handleOom(containerId, containerName, image);
				break;
			case "start":
				await this.handleStart(containerId, containerName, image);
				break;
		}
	}

	private async checkContainer(
		containerInfo: Docker.ContainerInfo,
		forceNotify: boolean,
	): Promise<void> {
		const containerId = containerInfo.Id;
		const containerName = this.getContainerName(containerInfo);
		const status = this.getContainerStatus(containerInfo);

		let state = this.stateStore.getState(containerId);
		if (!state) {
			state = this.stateStore.initializeState(
				containerId,
				containerName,
				status,
			);
		}

		const previousStatus = state.last_status;
		this.stateStore.updateStatus(containerId, status);

		// Check for status transitions
		if (status === "unhealthy" && previousStatus !== "unhealthy") {
			await this.publishAlertIfNeeded(
				containerId,
				containerName,
				containerInfo.Image,
				"unhealthy",
				0,
				forceNotify,
			);
		} else if (
			(status === "healthy" || status === "running") &&
			previousStatus === "unhealthy"
		) {
			await this.publishAlertIfNeeded(
				containerId,
				containerName,
				containerInfo.Image,
				"recovered",
				0,
				forceNotify,
			);
		} else if (status === "unhealthy") {
			// Re-alert if still unhealthy and enough time has passed
			await this.publishAlertIfNeeded(
				containerId,
				containerName,
				containerInfo.Image,
				"unhealthy",
				0,
				forceNotify,
			);
		}
	}

	private async handleDie(
		containerId: string,
		containerName: string,
		image: string,
		event: DockerEvent,
	): Promise<void> {
		const exitCode = Number.parseInt(
			event.Actor.Attributes.exitCode ?? "0",
			10,
		);
		const logs = await this.logFetcher.fetchLogs(containerId);

		const alert: ContainerAlert = {
			container_id: containerId.slice(0, 12),
			container_name: containerName,
			image,
			event: "died",
			exit_code: exitCode,
			logs_tail: logs || undefined,
			timestamp: new Date().toISOString(),
		};

		await this.publisher.publishAlert(alert);
		this.stateStore.updateStatus(containerId, "exited");
	}

	private async handleRestart(
		containerId: string,
		containerName: string,
		image: string,
	): Promise<void> {
		let state = this.stateStore.getState(containerId);
		if (!state) {
			state = this.stateStore.initializeState(
				containerId,
				containerName,
				"restarting",
			);
		}

		this.stateStore.recordRestart(containerId);
		const restartCount = state.consecutive_restarts;

		await this.publishAlertIfNeeded(
			containerId,
			containerName,
			image,
			"restarting",
			restartCount,
			false,
		);

		this.stateStore.updateStatus(containerId, "restarting");
	}

	private async handleHealthStatus(
		containerId: string,
		containerName: string,
		image: string,
		event: DockerEvent,
	): Promise<void> {
		const healthStatus = event.Actor.Attributes.health_status;

		if (healthStatus === "unhealthy") {
			const logs = await this.logFetcher.fetchLogs(containerId);
			await this.publishAlertIfNeeded(
				containerId,
				containerName,
				image,
				"unhealthy",
				0,
				false,
				healthStatus,
				logs,
			);
			this.stateStore.updateStatus(containerId, "unhealthy");
		} else if (healthStatus === "healthy") {
			const state = this.stateStore.getState(containerId);
			if (state?.last_status === "unhealthy") {
				await this.publishAlertIfNeeded(
					containerId,
					containerName,
					image,
					"recovered",
					0,
					false,
				);
			}
			this.stateStore.updateStatus(containerId, "healthy");
		}
	}

	private async handleOom(
		containerId: string,
		containerName: string,
		image: string,
	): Promise<void> {
		const logs = await this.logFetcher.fetchLogs(containerId);

		const alert: ContainerAlert = {
			container_id: containerId.slice(0, 12),
			container_name: containerName,
			image,
			event: "oom_killed",
			logs_tail: logs || undefined,
			timestamp: new Date().toISOString(),
		};

		await this.publisher.publishAlert(alert);
	}

	private async handleStart(
		containerId: string,
		containerName: string,
		_image: string,
	): Promise<void> {
		let state = this.stateStore.getState(containerId);
		if (!state) {
			state = this.stateStore.initializeState(
				containerId,
				containerName,
				"running",
			);
		} else {
			this.stateStore.updateStatus(containerId, "running");
		}
	}

	private async publishAlertIfNeeded(
		containerId: string,
		containerName: string,
		image: string,
		event: AlertEvent,
		restartCount: number,
		forceNotify: boolean,
		healthStatus?: string,
		logs?: string,
	): Promise<void> {
		if (
			!this.stateStore.shouldAlert(
				containerId,
				event,
				restartCount,
				forceNotify,
			)
		) {
			this.logger.debug("Skipping alert due to deduplication", {
				containerId: containerId.slice(0, 12),
				event,
				restartCount,
			});
			return;
		}

		const alert: ContainerAlert = {
			container_id: containerId.slice(0, 12),
			container_name: containerName,
			image,
			event,
			restart_count: event === "restarting" ? restartCount : undefined,
			health_status: healthStatus,
			logs_tail: logs || undefined,
			timestamp: new Date().toISOString(),
		};

		await this.publisher.publishAlert(alert);
		this.stateStore.updateAlertTime(containerId, restartCount);
	}

	private getContainerName(container: Docker.ContainerInfo): string {
		const names = container.Names;
		if (!names || names.length === 0) {
			return container.Id.slice(0, 12);
		}
		const name = names[0];
		return name?.startsWith("/") ? name.slice(1) : (name ?? "");
	}

	private getContainerStatus(container: Docker.ContainerInfo): ContainerStatus {
		const state = container.State?.toLowerCase() ?? "";
		const status = container.Status?.toLowerCase() ?? "";

		if (state === "running") {
			if (status.includes("unhealthy")) {
				return "unhealthy";
			}
			if (status.includes("healthy")) {
				return "healthy";
			}
			return "running";
		}

		if (state === "restarting") {
			return "restarting";
		}

		if (state === "exited" || state === "dead") {
			return "exited";
		}

		return "running";
	}
}
