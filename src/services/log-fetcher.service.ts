import type { ILogger } from "@xmer/consumer-shared";
import type Docker from "dockerode";
import type { ILogFetcher, LogFetcherOptions } from "../types/index.js";

export class LogFetcherService implements ILogFetcher {
	private readonly docker: Docker;
	private readonly logger: ILogger;
	private readonly tailLines: number;

	constructor(options: LogFetcherOptions) {
		this.docker = options.docker;
		this.logger = options.logger.child({ component: "LogFetcherService" });
		this.tailLines = options.tailLines;
	}

	async fetchLogs(containerId: string): Promise<string> {
		try {
			const container = this.docker.getContainer(containerId);
			const logStream = await container.logs({
				stdout: true,
				stderr: true,
				tail: this.tailLines,
				timestamps: false,
			});

			// Docker API returns logs as a Buffer with multiplexed streams
			const logs = this.demuxLogs(logStream);
			return logs.trim();
		} catch (error) {
			this.logger.warn("Failed to fetch container logs", {
				containerId,
				error: (error as Error).message,
			});
			return "";
		}
	}

	private demuxLogs(buffer: Buffer): string {
		// Docker multiplexes stdout/stderr with 8-byte headers
		// Header format: [stream_type(1), 0, 0, 0, size(4)]
		const lines: string[] = [];
		let offset = 0;

		while (offset < buffer.length) {
			if (offset + 8 > buffer.length) {
				// Not enough bytes for header, treat rest as raw output
				lines.push(buffer.subarray(offset).toString("utf8"));
				break;
			}

			const size = buffer.readUInt32BE(offset + 4);
			offset += 8;

			if (offset + size > buffer.length) {
				// Size exceeds remaining buffer, take what we can
				lines.push(buffer.subarray(offset).toString("utf8"));
				break;
			}

			const line = buffer.subarray(offset, offset + size).toString("utf8");
			lines.push(line);
			offset += size;
		}

		return lines.join("");
	}
}
