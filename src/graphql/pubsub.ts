import { PubSub } from "graphql-subscriptions";

export const pubsub = new PubSub();

export const EVENTS = {
	CONTAINER_STATUS_CHANGED: "CONTAINER_STATUS_CHANGED",
	CONTAINER_ALERT: "CONTAINER_ALERT",
} as const;
