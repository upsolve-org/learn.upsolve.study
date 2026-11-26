import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildAdminStats,
	formatCompactNumber,
	parseAdminStatsRange,
	rangeCutoffMs,
} from "../src/core/admin-stats.ts";

describe("admin stats aggregation", () => {
	const NOW = Date.parse("2026-11-26T12:00:00.000Z");

	it("parses time ranges safely and computes cutoffs", () => {
		assert.equal(parseAdminStatsRange(undefined), "all");
		assert.equal(parseAdminStatsRange("invalid"), "all");
		assert.equal(parseAdminStatsRange("7d"), "7d");
		assert.equal(parseAdminStatsRange(["24h", "7d"]), "24h");
		assert.equal(rangeCutoffMs("all", NOW), null);
		assert.equal(rangeCutoffMs("24h", NOW), NOW - 24 * 60 * 60 * 1000);
	});

	it("aggregates sessions and token channels (turns, extractions, jobs) per user", () => {
		const stats = buildAdminStats(
			{
				users: [
					{ id: "u-alice", email: "Alice@Example.com" },
					{ id: "u-bob", email: "bob@example.com" },
				],
				admittedEmails: ["alice@example.com", "charlie@example.com"],
				chats: [
					{
						ownerId: "U-ALICE",
						createdAt: "2026-11-25T10:00:00.000Z",
						updatedAt: "2026-11-26T10:00:00.000Z",
						turns: [
							{
								id: "t1",
								messageId: "m1",
								at: "2026-11-26T10:00:00.000Z",
								model: "custom:default",
								steps: [
									{
										inputTokens: 1000,
										outputTokens: 400,
										cacheReadTokens: 200,
										cacheWriteTokens: 100,
										reasoningTokens: 150,
									},
								],
							},
						],
						extractions: [
							{
								startedAt: 1,
								at: "2026-11-26T10:05:00.000Z",
								durationMs: 500,
								stages: {
									extractor: {
										model: "custom:default",
										steps: [
											{
												inputTokens: 300,
												outputTokens: 100,
												cacheReadTokens: undefined,
												cacheWriteTokens: undefined,
												reasoningTokens: undefined,
											},
										],
									},
									auditor: {
										model: "custom:default",
										steps: [
											{
												inputTokens: 200,
												outputTokens: 50,
												cacheReadTokens: 50,
												cacheWriteTokens: 0,
												reasoningTokens: 20,
											},
										],
									},
								},
							},
						],
					},
					{
						ownerId: "u-bob",
						createdAt: "2026-11-20T09:00:00.000Z",
						updatedAt: "2026-11-20T09:30:00.000Z",
						turns: [],
						extractions: [],
					},
				],
				jobs: [
					{
						ownerId: "u-alice",
						updatedAt: "2026-11-26T11:00:00.000Z",
						usage: {
							model: "custom:default",
							inputTokens: 500,
							outputTokens: 250,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							reasoningTokens: 50,
							steps: 1,
						},
					},
				],
			},
			"all",
			NOW,
		);

		assert.equal(stats.available, true);
		assert.equal(stats.totals.users, 3);
		assert.equal(stats.totals.activeUsers, 2);
		assert.equal(stats.totals.sessions, 2);
		assert.deepEqual(stats.totals.tokens, {
			input: 2000,
			output: 800,
			cacheRead: 250,
			cacheWrite: 100,
			reasoning: 220,
			total: 3150,
		});

		// Default sort: highest total tokens first, then sessions, then email
		assert.deepEqual(
			stats.users.map((u) => u.email),
			["alice@example.com", "bob@example.com", "charlie@example.com"],
		);
		assert.equal(stats.users[0]?.lastActiveAt, "2026-11-26T11:00:00.000Z");
		assert.equal(stats.users[2]?.userId, null);
		assert.equal(stats.users[2]?.sessions, 0);
	});

	it("filters sessions, turns, extractions, and jobs by rolling time window", () => {
		const stats = buildAdminStats(
			{
				users: [{ id: "u-alice", email: "alice@example.com" }],
				chats: [
					{
						ownerId: "u-alice",
						createdAt: "2026-11-01T10:00:00.000Z",
						updatedAt: "2026-11-26T08:00:00.000Z",
						turns: [
							{
								id: "old",
								messageId: "m1",
								at: "2026-11-01T10:05:00.000Z",
								model: "custom:default",
								steps: [{ inputTokens: 9999, outputTokens: 9999, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }],
							},
							{
								id: "recent",
								messageId: "m2",
								at: "2026-11-26T08:00:00.000Z",
								model: "custom:default",
								steps: [{ inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 10 }],
							},
						],
					},
					{
						ownerId: "u-alice",
						createdAt: "2026-11-01T10:00:00.000Z",
						updatedAt: "2026-11-02T10:00:00.000Z",
						turns: [],
					},
				],
				jobs: [
					{
						ownerId: "u-alice",
						updatedAt: "2026-11-02T10:00:00.000Z",
						usage: {
							model: "custom:default",
							inputTokens: 5000,
							outputTokens: 5000,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							reasoningTokens: 0,
							steps: 1,
						},
					},
				],
			},
			"24h",
			NOW,
		);

		assert.equal(stats.totals.sessions, 1);
		assert.equal(stats.totals.tokens.total, 150);
		assert.equal(stats.totals.tokens.reasoning, 10);
		assert.equal(stats.users[0]?.lastActiveAt, "2026-11-26T08:00:00.000Z");
	});

	it("formats compact token numbers cleanly", () => {
		assert.equal(formatCompactNumber(0), "0");
		assert.equal(formatCompactNumber(850), "850");
		assert.equal(formatCompactNumber(12_400), "12.4K");
		assert.equal(formatCompactNumber(1_250_000), "1.25M");
	});
});
