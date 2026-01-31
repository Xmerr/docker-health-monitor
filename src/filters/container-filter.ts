import type Docker from "dockerode";
import type { FilterConfig, IContainerFilter } from "../types/index.js";

export class ContainerFilter implements IContainerFilter {
	private readonly includePatterns: string[];
	private readonly excludePatterns: string[];
	private readonly requiredLabels: Record<string, string>;

	constructor(config: FilterConfig) {
		this.includePatterns = config.include_patterns ?? [];
		this.excludePatterns = config.exclude_patterns ?? [];
		this.requiredLabels = config.required_labels ?? {};
	}

	shouldMonitor(container: Docker.ContainerInfo): boolean {
		const name = this.getContainerName(container);

		// Exclude patterns take priority
		if (this.matchesAnyPattern(name, this.excludePatterns)) {
			return false;
		}

		// Check required labels
		if (!this.hasRequiredLabels(container)) {
			return false;
		}

		// If include patterns are specified, container must match at least one
		if (this.includePatterns.length > 0) {
			return this.matchesAnyPattern(name, this.includePatterns);
		}

		// Default: monitor containers with restart policy
		return this.hasRestartPolicy(container);
	}

	private getContainerName(container: Docker.ContainerInfo): string {
		const names = container.Names;
		if (!names || names.length === 0) {
			return container.Id.slice(0, 12);
		}
		// Container names start with "/"
		const name = names[0];
		return name?.startsWith("/") ? name.slice(1) : (name ?? "");
	}

	private matchesAnyPattern(name: string, patterns: string[]): boolean {
		return patterns.some((pattern) => this.matchesPattern(name, pattern));
	}

	private matchesPattern(name: string, pattern: string): boolean {
		// Convert glob pattern to regex
		const regexPattern = pattern
			.replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape special regex chars
			.replace(/\*/g, ".*") // Convert * to .*
			.replace(/\?/g, "."); // Convert ? to .

		const regex = new RegExp(`^${regexPattern}$`, "i");
		return regex.test(name);
	}

	private hasRequiredLabels(container: Docker.ContainerInfo): boolean {
		const labels = container.Labels ?? {};
		for (const [key, value] of Object.entries(this.requiredLabels)) {
			if (labels[key] !== value) {
				return false;
			}
		}
		return true;
	}

	private hasRestartPolicy(container: Docker.ContainerInfo): boolean {
		const hostConfig = container.HostConfig as
			| { RestartPolicy?: { Name?: string } }
			| undefined;
		const restartPolicy = hostConfig?.RestartPolicy?.Name;
		return (
			restartPolicy === "always" ||
			restartPolicy === "unless-stopped" ||
			restartPolicy === "on-failure"
		);
	}
}
