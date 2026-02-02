import type { ILogger } from "@xmer/consumer-shared";
import type { Channel } from "amqplib";
import type Docker from "dockerode";

export type AlertEvent =
	| "unhealthy"
	| "died"
	| "restarting"
	| "oom_killed"
	| "recovered";

export type ContainerStatus =
	| "running"
	| "healthy"
	| "unhealthy"
	| "exited"
	| "restarting";

export type TriggerAction = "status_report" | "check_container" | "check_all";

export interface ContainerAlert {
	container_id: string;
	container_name: string;
	image: string;
	event: AlertEvent;
	exit_code?: number;
	restart_count?: number;
	health_status?: string;
	logs_tail?: string;
	timestamp: string;
}

export interface ContainerStatusInfo {
	container_id: string;
	container_name: string;
	image: string;
	status: ContainerStatus;
	uptime_seconds: number;
	restart_count: number;
}

export interface DockerStatusReport {
	containers: ContainerStatusInfo[];
	timestamp: string;
}

export interface ContainerState {
	container_id: string;
	container_name: string;
	last_status: ContainerStatus;
	last_alert_time: string | null;
	restart_count_at_last_alert: number;
	consecutive_restarts: number;
	first_restart_in_window: string | null;
}

export interface TriggerMessage {
	action: TriggerAction;
	container_id?: string;
	force_notify?: boolean;
}

export interface FilterConfig {
	include_patterns?: string[];
	exclude_patterns?: string[];
	required_labels?: Record<string, string>;
}

export interface Config {
	rabbitmqUrl: string;
	dockerHost: string;
	pollIntervalSeconds: number;
	includePatterns: string[];
	excludePatterns: string[];
	requiredLabels: Record<string, string>;
	logTailLines: number;
	lokiHost: string | undefined;
	logLevel: string;
	exchangeName: string;
	notificationsExchange: string;
	triggerQueueName: string;
	triggerRoutingKey: string;
	graphqlPort: number;
	graphqlWsPort: number;
}

export interface PubSubEmitter {
	publish(event: string, payload: unknown): Promise<void>;
}

export interface DockerPublisherOptions {
	channel: Channel;
	exchange: string;
	notificationsExchange: string;
	logger: ILogger;
	pubsub?: PubSubEmitter;
}

export interface EventListenerOptions {
	docker: Docker;
	logger: ILogger;
	onEvent: (event: DockerEvent) => Promise<void>;
	containerFilter: IContainerFilter;
}

export interface HealthCheckerOptions {
	docker: Docker;
	logger: ILogger;
	containerFilter: IContainerFilter;
	stateStore: IContainerStateStore;
	publisher: IDockerPublisher;
	logFetcher: ILogFetcher;
	pollIntervalSeconds: number;
}

export interface LogFetcherOptions {
	docker: Docker;
	logger: ILogger;
	tailLines: number;
}

export interface TriggerConsumerOptions {
	channel: Channel;
	exchange: string;
	queue: string;
	routingKey: string;
	dlqHandler: {
		setup(): Promise<void>;
		handleRetryableError(message: unknown, error: Error): Promise<void>;
		handleNonRetryableError(message: unknown, error: Error): Promise<void>;
	};
	logger: ILogger;
	healthChecker: IHealthChecker;
}

export interface DockerEvent {
	Type: "container";
	Action: string;
	Actor: {
		ID: string;
		Attributes: {
			name?: string;
			image?: string;
			exitCode?: string;
			health_status?: string;
			[key: string]: string | undefined;
		};
	};
	time: number;
	timeNano: number;
}

export interface IContainerFilter {
	shouldMonitor(container: Docker.ContainerInfo): boolean;
}

export interface IContainerStateStore {
	getState(containerId: string): ContainerState | undefined;
	setState(state: ContainerState): void;
	deleteState(containerId: string): void;
	shouldAlert(
		containerId: string,
		event: AlertEvent,
		restartCount: number,
		forceNotify?: boolean,
	): boolean;
	updateAlertTime(containerId: string, restartCount: number): void;
	getAllStates(): Map<string, ContainerState>;
}

export interface IDockerPublisher {
	publishAlert(alert: ContainerAlert): Promise<void>;
	publishStatusReport(report: DockerStatusReport): Promise<void>;
}

export interface ILogFetcher {
	fetchLogs(containerId: string): Promise<string>;
}

export interface IEventListener {
	start(): Promise<void>;
	stop(): void;
}

export interface IHealthChecker {
	start(): void;
	stop(): void;
	pollContainers(forceNotify?: boolean): Promise<void>;
	checkSingleContainer(
		containerId: string,
		forceNotify?: boolean,
	): Promise<void>;
	generateStatusReport(): Promise<DockerStatusReport>;
	handleDockerEvent(event: DockerEvent): Promise<void>;
}
