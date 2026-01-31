export class DockerConnectionError extends Error {
	readonly errorCause?: Error;

	constructor(message: string, cause?: Error) {
		super(message);
		this.name = "DockerConnectionError";
		this.errorCause = cause;
	}
}

export class ContainerNotFoundError extends Error {
	constructor(public readonly containerId: string) {
		super(`Container not found: ${containerId}`);
		this.name = "ContainerNotFoundError";
	}
}

export class InvalidTriggerActionError extends Error {
	constructor(public readonly action: string) {
		super(`Invalid trigger action: ${action}`);
		this.name = "InvalidTriggerActionError";
	}
}
