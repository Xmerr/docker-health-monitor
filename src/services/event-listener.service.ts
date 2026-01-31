import type { ILogger } from "@xmer/consumer-shared";
import type Docker from "dockerode";
import type {
	DockerEvent,
	EventListenerOptions,
	IContainerFilter,
	IEventListener,
} from "../types/index.js";

const MONITORED_EVENTS = new Set([
	"die",
	"restart",
	"health_status",
	"oom",
	"start",
]);

interface DestroyableStream extends NodeJS.ReadableStream {
	destroy(): void;
}

export class EventListenerService implements IEventListener {
	private readonly docker: Docker;
	private readonly logger: ILogger;
	private readonly onEvent: (event: DockerEvent) => Promise<void>;
	private readonly containerFilter: IContainerFilter;
	private eventStream: DestroyableStream | null = null;
	private isRunning = false;

	constructor(options: EventListenerOptions) {
		this.docker = options.docker;
		this.logger = options.logger.child({ component: "EventListenerService" });
		this.onEvent = options.onEvent;
		this.containerFilter = options.containerFilter;
	}

	async start(): Promise<void> {
		if (this.isRunning) {
			this.logger.warn("Event listener already running");
			return;
		}

		this.isRunning = true;

		try {
			this.eventStream = (await this.docker.getEvents({
				filters: {
					type: ["container"],
					event: Array.from(MONITORED_EVENTS),
				},
			})) as DestroyableStream;

			this.eventStream.on("data", (chunk: Buffer) => {
				void this.handleEventData(chunk);
			});

			this.eventStream.on("error", (error: Error) => {
				this.logger.error("Docker event stream error", {
					error: error.message,
				});
			});

			this.eventStream.on("end", () => {
				this.logger.warn("Docker event stream ended");
				this.isRunning = false;
			});

			this.logger.info("Docker event listener started", {
				events: Array.from(MONITORED_EVENTS),
			});
		} catch (error) {
			this.isRunning = false;
			throw error;
		}
	}

	stop(): void {
		if (this.eventStream) {
			this.eventStream.destroy();
			this.eventStream = null;
		}
		this.isRunning = false;
		this.logger.info("Docker event listener stopped");
	}

	private async handleEventData(chunk: Buffer): Promise<void> {
		try {
			const eventData = JSON.parse(chunk.toString()) as DockerEvent;

			if (eventData.Type !== "container") {
				return;
			}

			if (!MONITORED_EVENTS.has(eventData.Action)) {
				return;
			}

			// Check if container should be monitored
			const shouldMonitor = await this.checkContainerFilter(eventData.Actor.ID);
			if (!shouldMonitor) {
				this.logger.debug("Ignoring event for filtered container", {
					containerId: eventData.Actor.ID.slice(0, 12),
					containerName: eventData.Actor.Attributes.name,
				});
				return;
			}

			this.logger.debug("Docker event received", {
				action: eventData.Action,
				containerId: eventData.Actor.ID.slice(0, 12),
				containerName: eventData.Actor.Attributes.name,
			});

			await this.onEvent(eventData);
		} catch (error) {
			this.logger.error("Failed to process Docker event", {
				error: (error as Error).message,
			});
		}
	}

	private async checkContainerFilter(containerId: string): Promise<boolean> {
		try {
			const containers = await this.docker.listContainers({
				all: true,
				filters: { id: [containerId] },
			});

			const container = containers[0];
			if (!container) {
				return false;
			}

			return this.containerFilter.shouldMonitor(container);
		} catch (error) {
			this.logger.warn("Failed to check container filter", {
				containerId: containerId.slice(0, 12),
				error: (error as Error).message,
			});
			// Default to monitoring if we can't determine
			return true;
		}
	}
}
