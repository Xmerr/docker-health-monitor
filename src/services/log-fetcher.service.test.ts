import { beforeEach, describe, expect, it, mock } from "bun:test";
import { LogFetcherService } from "./log-fetcher.service.js";

function createMockLogger() {
	const childLogger = {
		debug: mock(() => {}),
		info: mock(() => {}),
		warn: mock(() => {}),
		error: mock(() => {}),
		child: mock(() => childLogger),
	};
	return {
		debug: mock(() => {}),
		info: mock(() => {}),
		warn: mock(() => {}),
		error: mock(() => {}),
		child: mock(() => childLogger),
		_childLogger: childLogger,
	};
}

function createMockDocker() {
	return {
		getContainer: mock(() => ({
			logs: mock(() => Promise.resolve(Buffer.from(""))),
		})),
	};
}

function createMultiplexedBuffer(
	messages: Array<{ stream: number; text: string }>,
): Buffer {
	const buffers: Buffer[] = [];
	for (const msg of messages) {
		const textBuffer = Buffer.from(msg.text, "utf8");
		const header = Buffer.alloc(8);
		header.writeUInt8(msg.stream, 0); // stream type (1=stdout, 2=stderr)
		header.writeUInt32BE(textBuffer.length, 4); // size
		buffers.push(header, textBuffer);
	}
	return Buffer.concat(buffers);
}

describe("LogFetcherService", () => {
	let service: LogFetcherService;
	let mockDocker: ReturnType<typeof createMockDocker>;
	let mockLogger: ReturnType<typeof createMockLogger>;

	beforeEach(() => {
		mockDocker = createMockDocker();
		mockLogger = createMockLogger();
		service = new LogFetcherService({
			docker: mockDocker as unknown as import("dockerode").default,
			logger: mockLogger,
			tailLines: 10,
		});
	});

	describe("fetchLogs", () => {
		it("should fetch and demux container logs", async () => {
			// Arrange
			const logBuffer = createMultiplexedBuffer([
				{ stream: 1, text: "Line 1\n" },
				{ stream: 2, text: "Error line\n" },
				{ stream: 1, text: "Line 2\n" },
			]);
			const mockContainer = {
				logs: mock(() => Promise.resolve(logBuffer)),
			};
			mockDocker.getContainer.mockReturnValue(mockContainer);

			// Act
			const logs = await service.fetchLogs("abc123");

			// Assert
			expect(logs).toBe("Line 1\nError line\nLine 2");
			expect(mockDocker.getContainer).toHaveBeenCalledWith("abc123");
			expect(mockContainer.logs).toHaveBeenCalledWith({
				stdout: true,
				stderr: true,
				tail: 10,
				timestamps: false,
			});
		});

		it("should return empty string on error", async () => {
			// Arrange
			const mockContainer = {
				logs: mock(() => Promise.reject(new Error("Container not found"))),
			};
			mockDocker.getContainer.mockReturnValue(mockContainer);

			// Act
			const logs = await service.fetchLogs("abc123");

			// Assert
			expect(logs).toBe("");
			expect(mockLogger._childLogger.warn).toHaveBeenCalled();
		});

		it("should handle empty logs", async () => {
			// Arrange
			const mockContainer = {
				logs: mock(() => Promise.resolve(Buffer.from(""))),
			};
			mockDocker.getContainer.mockReturnValue(mockContainer);

			// Act
			const logs = await service.fetchLogs("abc123");

			// Assert
			expect(logs).toBe("");
		});

		it("should handle raw log output without multiplexing", async () => {
			// Arrange - some Docker configurations return raw logs
			const rawLogs = Buffer.from("Raw log line 1\nRaw log line 2\n");
			const mockContainer = {
				logs: mock(() => Promise.resolve(rawLogs)),
			};
			mockDocker.getContainer.mockReturnValue(mockContainer);

			// Act
			const logs = await service.fetchLogs("abc123");

			// Assert
			// When there's no valid multiplexed header, it treats as raw
			expect(logs).toContain("Raw log line");
		});

		it("should trim whitespace from logs", async () => {
			// Arrange
			const logBuffer = createMultiplexedBuffer([
				{ stream: 1, text: "  Line with whitespace  \n\n" },
			]);
			const mockContainer = {
				logs: mock(() => Promise.resolve(logBuffer)),
			};
			mockDocker.getContainer.mockReturnValue(mockContainer);

			// Act
			const logs = await service.fetchLogs("abc123");

			// Assert
			expect(logs).toBe("Line with whitespace");
		});
	});
});
