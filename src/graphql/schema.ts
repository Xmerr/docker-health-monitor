import { gql } from "graphql-tag";

export const typeDefs = gql`
  extend schema
    @link(url: "https://specs.apollo.dev/federation/v2.0", import: ["@key"])

  type Query {
    """
    Get all monitored containers
    """
    containers: [Container!]!

    """
    Get a specific container by ID
    """
    container(id: ID!): Container
  }

  type Subscription {
    """
    Subscribe to container status changes
    """
    containerStatusChanged: ContainerStatusEvent!

    """
    Subscribe to container alerts (unhealthy, died, restarting, etc.)
    """
    containerAlert: ContainerAlertEvent!
  }

  """
  A Docker container being monitored
  """
  type Container @key(fields: "id") {
    id: ID!
    name: String!
    image: String!
    status: ContainerStatus!
    uptimeSeconds: Int!
    restartCount: Int!
  }

  """
  Container status enumeration
  """
  enum ContainerStatus {
    RUNNING
    HEALTHY
    UNHEALTHY
    EXITED
    RESTARTING
  }

  """
  Alert event types
  """
  enum AlertEvent {
    UNHEALTHY
    DIED
    RESTARTING
    OOM_KILLED
    RECOVERED
  }

  """
  Event emitted when a container's status changes
  """
  type ContainerStatusEvent {
    container: Container!
    previousStatus: ContainerStatus
    timestamp: String!
  }

  """
  Event emitted when a container alert occurs
  """
  type ContainerAlertEvent {
    containerId: ID!
    containerName: String!
    image: String!
    event: AlertEvent!
    exitCode: Int
    restartCount: Int
    healthStatus: String
    logsTail: String
    timestamp: String!
  }
`;
