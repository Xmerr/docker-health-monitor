import type { ILogger } from "@xmer/consumer-shared";
import type { Channel } from "amqplib";
import type {
	ContainerAlert,
	DockerPublisherOptions,
	DockerStatusReport,
	IDockerPublisher,
	PubSubEmitter,
} from "../types/index.js";

const ROUTING_KEYS = {
	unhealthy: "container.unhealthy",
	died: "container.died",
	restarting: "container.restarting",
	oom_killed: "container.oom",
	recovered: "container.recovered",
	status_report: "status.report",
} as const;

export const PUBSUB_EVENTS = {
	CONTAINER_ALERT: "CONTAINER_ALERT",
	CONTAINER_STATUS_CHANGED: "CONTAINER_STATUS_CHANGED",
} as const;

export class DockerPublisher implements IDockerPublisher {
	private readonly channel: Channel;
	private readonly exchange: string;
	private readonly notificationsExchange: string;
	private readonly logger: ILogger;
	private readonly pubsub?: PubSubEmitter;
	private exchangeAsserted = false;

	constructor(options: DockerPublisherOptions) {
		this.channel = options.channel;
		this.exchange = options.exchange;
		this.notificationsExchange = options.notificationsExchange;
		this.logger = options.logger.child({ component: "DockerPublisher" });
		this.pubsub = options.pubsub;
	}

	async publishAlert(alert: ContainerAlert): Promise<void> {
		await this.assertExchangesOnce();

		const routingKey = ROUTING_KEYS[alert.event];
		await this.publish(routingKey, alert as unknown as Record<string, unknown>);

		// Emit to GraphQL subscriptions
		if (this.pubsub) {
			await this.pubsub.publish(PUBSUB_EVENTS.CONTAINER_ALERT, {
				containerAlert: alert,
			});
		}

		this.logger.info("Alert published", {
			event: alert.event,
			container: alert.container_name,
			routingKey,
		});
	}

	async publishStatusReport(report: DockerStatusReport): Promise<void> {
		await this.assertExchangesOnce();

		await this.publish(
			ROUTING_KEYS.status_report,
			report as unknown as Record<string, unknown>,
		);

		this.logger.info("Status report published", {
			containerCount: report.containers.length,
		});
	}

	private async publish(
		routingKey: string,
		content: Record<string, unknown>,
	): Promise<void> {
		const buffer = Buffer.from(JSON.stringify(content));
		this.channel.publish(this.exchange, routingKey, buffer, {
			persistent: true,
			contentType: "application/json",
		});
	}

	private async assertExchangesOnce(): Promise<void> {
		if (this.exchangeAsserted) return;

		// Assert main exchange
		await this.channel.assertExchange(this.exchange, "topic", {
			durable: true,
		});

		// Assert notifications exchange
		await this.channel.assertExchange(this.notificationsExchange, "topic", {
			durable: true,
		});

		// Bind docker exchange to notifications for container alerts and status reports
		const alertRoutingKeys = [
			ROUTING_KEYS.unhealthy,
			ROUTING_KEYS.died,
			ROUTING_KEYS.restarting,
			ROUTING_KEYS.oom_killed,
			ROUTING_KEYS.recovered,
			ROUTING_KEYS.status_report,
		];

		for (const routingKey of alertRoutingKeys) {
			await this.channel.bindExchange(
				this.notificationsExchange,
				this.exchange,
				routingKey,
			);
		}

		this.exchangeAsserted = true;
		this.logger.debug("Exchanges asserted and bound", {
			exchange: this.exchange,
			notificationsExchange: this.notificationsExchange,
		});
	}
}
