import type {
	ContainerAlert,
	ContainerStatus,
	ContainerStatusInfo,
	IHealthChecker,
} from "../types/index.js";
import { EVENTS, pubsub } from "./pubsub.js";

export interface GraphQLContext {
	healthChecker: IHealthChecker;
}

function mapStatus(status: ContainerStatus): string {
	return status.toUpperCase();
}

function mapAlertEvent(event: string): string {
	return event.toUpperCase();
}

function mapContainerToGraphQL(container: ContainerStatusInfo) {
	return {
		id: container.container_id,
		name: container.container_name,
		image: container.image,
		status: mapStatus(container.status),
		uptimeSeconds: container.uptime_seconds,
		restartCount: container.restart_count,
	};
}

export const resolvers = {
	Query: {
		containers: async (
			_parent: unknown,
			_args: unknown,
			context: GraphQLContext,
		) => {
			const report = await context.healthChecker.generateStatusReport();
			return report.containers.map(mapContainerToGraphQL);
		},

		container: async (
			_parent: unknown,
			args: { id: string },
			context: GraphQLContext,
		) => {
			const report = await context.healthChecker.generateStatusReport();
			const container = report.containers.find(
				(c) => c.container_id === args.id,
			);
			if (!container) return null;
			return mapContainerToGraphQL(container);
		},
	},

	Mutation: {
		refreshContainers: async (
			_parent: unknown,
			_args: unknown,
			context: GraphQLContext,
		) => {
			try {
				await context.healthChecker.pollContainers(true);
				return {
					success: true,
					message: "Container refresh triggered successfully",
				};
			} catch (error) {
				return {
					success: false,
					message: `Failed to refresh containers: ${(error as Error).message}`,
				};
			}
		},
	},

	Subscription: {
		containerStatusChanged: {
			subscribe: () => pubsub.asyncIterator(EVENTS.CONTAINER_STATUS_CHANGED),
		},

		containerAlert: {
			subscribe: () => pubsub.asyncIterator(EVENTS.CONTAINER_ALERT),
			resolve: (payload: ContainerAlert) => ({
				containerId: payload.container_id,
				containerName: payload.container_name,
				image: payload.image,
				event: mapAlertEvent(payload.event),
				exitCode: payload.exit_code ?? null,
				restartCount: payload.restart_count ?? null,
				healthStatus: payload.health_status ?? null,
				logsTail: payload.logs_tail ?? null,
				timestamp: payload.timestamp,
			}),
		},
	},

	Container: {
		__resolveReference: async (
			reference: { id: string },
			context: GraphQLContext,
		) => {
			const report = await context.healthChecker.generateStatusReport();
			const container = report.containers.find(
				(c) => c.container_id === reference.id,
			);
			if (!container) return null;
			return mapContainerToGraphQL(container);
		},
	},
};
