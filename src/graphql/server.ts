import { ApolloServer } from "@apollo/server";
import { startStandaloneServer } from "@apollo/server/standalone";
import { buildSubgraphSchema } from "@apollo/subgraph";
import type { ILogger } from "@xmer/consumer-shared";
import { useServer } from "graphql-ws/lib/use/ws";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import type { IHealthChecker } from "../types/index.js";
import type { GraphQLContext } from "./resolvers.js";
import { resolvers } from "./resolvers.js";
import { typeDefs } from "./schema.js";

export interface GraphQLServerOptions {
	port: number;
	wsPort: number;
	healthChecker: IHealthChecker;
	logger: ILogger;
}

export interface GraphQLServerInstance {
	start(): Promise<void>;
	stop(): Promise<void>;
}

export function createGraphQLServer(
	options: GraphQLServerOptions,
): GraphQLServerInstance {
	const { port, wsPort, healthChecker, logger } = options;
	const graphqlLogger = logger.child({ component: "GraphQLServer" });

	const schema = buildSubgraphSchema({
		typeDefs,
		resolvers,
	});

	const apolloServer = new ApolloServer<GraphQLContext>({
		schema,
	});

	const httpServer = createServer();
	const wsServer = new WebSocketServer({
		server: httpServer,
		path: "/graphql",
	});

	let serverCleanup: { dispose: () => Promise<void> };
	let apolloUrl: string;

	return {
		async start() {
			// Start WebSocket server for subscriptions
			serverCleanup = useServer(
				{
					schema,
					context: (): GraphQLContext => ({ healthChecker }),
					onConnect: () => {
						graphqlLogger.debug("WebSocket client connected");
						return true;
					},
					onDisconnect: () => {
						graphqlLogger.debug("WebSocket client disconnected");
					},
				},
				wsServer,
			);

			await new Promise<void>((resolve) => {
				httpServer.listen(wsPort, () => {
					graphqlLogger.info("WebSocket server started", {
						url: `ws://localhost:${wsPort}/graphql`,
					});
					resolve();
				});
			});

			// Start Apollo HTTP server
			const { url } = await startStandaloneServer(apolloServer, {
				listen: { port },
				context: async () => ({ healthChecker }),
			});
			apolloUrl = url;

			graphqlLogger.info("GraphQL HTTP server started", {
				url: apolloUrl,
			});
		},

		async stop() {
			graphqlLogger.info("Stopping GraphQL servers");
			await serverCleanup?.dispose();
			await apolloServer.stop();
			httpServer.close();
		},
	};
}
