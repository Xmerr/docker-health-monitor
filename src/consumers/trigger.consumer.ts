import { NonRetryableError } from "@xmer/consumer-shared";
import type { ILogger } from "@xmer/consumer-shared";
import type { Channel, ConsumeMessage } from "amqplib";
import { InvalidTriggerActionError } from "../errors/index.js";
import type {
	IHealthChecker,
	TriggerConsumerOptions,
	TriggerMessage,
} from "../types/index.js";

const VALID_ACTIONS = new Set([
	"status_report",
	"check_container",
	"check_all",
]);

export class TriggerConsumer {
	private readonly channel: Channel;
	private readonly exchange: string;
	private readonly queue: string;
	private readonly routingKey: string;
	private readonly dlqHandler: TriggerConsumerOptions["dlqHandler"];
	private readonly logger: ILogger;
	private readonly healthChecker: IHealthChecker;
	private consumerTag: string | null = null;

	constructor(options: TriggerConsumerOptions) {
		this.channel = options.channel;
		this.exchange = options.exchange;
		this.queue = options.queue;
		this.routingKey = options.routingKey;
		this.dlqHandler = options.dlqHandler;
		this.logger = options.logger.child({ component: "TriggerConsumer" });
		this.healthChecker = options.healthChecker;
	}

	async start(): Promise<void> {
		await this.channel.prefetch(1);

		await this.channel.assertExchange(this.exchange, "topic", {
			durable: true,
		});

		await this.channel.assertQueue(this.queue, { durable: true });

		await this.channel.bindQueue(this.queue, this.exchange, this.routingKey);

		await this.dlqHandler.setup();

		const { consumerTag } = await this.channel.consume(
			this.queue,
			(msg) => {
				void this.handleMessage(msg);
			},
			{ noAck: false },
		);
		this.consumerTag = consumerTag;

		this.logger.info("Trigger consumer started", {
			exchange: this.exchange,
			queue: this.queue,
			routingKey: this.routingKey,
		});
	}

	async stop(): Promise<void> {
		if (this.consumerTag) {
			await this.channel.cancel(this.consumerTag);
			this.consumerTag = null;
		}
		this.logger.info("Trigger consumer stopped");
	}

	private async handleMessage(msg: ConsumeMessage | null): Promise<void> {
		if (!msg) {
			this.logger.warn("Received null message");
			return;
		}

		try {
			const content = JSON.parse(msg.content.toString()) as TriggerMessage;
			await this.processMessage(content);
			this.channel.ack(msg);
		} catch (error) {
			await this.handleError(msg, error as Error);
		}
	}

	private async processMessage(message: TriggerMessage): Promise<void> {
		this.logger.info("Processing trigger message", {
			action: message.action,
			containerId: message.container_id,
			forceNotify: message.force_notify,
		});

		if (!VALID_ACTIONS.has(message.action)) {
			throw new NonRetryableError(
				`Invalid trigger action: ${message.action}`,
				"INVALID_ACTION",
				{ action: message.action },
			);
		}

		switch (message.action) {
			case "status_report":
				await this.healthChecker.generateStatusReport();
				break;

			case "check_container":
				if (!message.container_id) {
					throw new NonRetryableError(
						"container_id is required for check_container action",
						"MISSING_CONTAINER_ID",
					);
				}
				await this.healthChecker.checkSingleContainer(
					message.container_id,
					message.force_notify,
				);
				break;

			case "check_all":
				await this.healthChecker.pollContainers(message.force_notify);
				break;
		}

		this.logger.info("Trigger action completed", { action: message.action });
	}

	private async handleError(msg: ConsumeMessage, error: Error): Promise<void> {
		this.logger.error("Message processing failed", {
			queue: this.queue,
			error: error.message,
			errorType: error.constructor.name,
		});

		try {
			if (error instanceof NonRetryableError) {
				await this.dlqHandler.handleNonRetryableError(msg, error);
			} else if (error instanceof InvalidTriggerActionError) {
				await this.dlqHandler.handleNonRetryableError(msg, error);
			} else {
				await this.dlqHandler.handleRetryableError(msg, error);
			}
		} catch (dlqError) {
			this.logger.error("DLQ handler failed, nacking message", {
				error: (dlqError as Error).message,
			});
			this.channel.nack(msg, false, false);
		}
	}
}
