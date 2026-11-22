/**
 * JobStore — the PostgreSQL adapter for background sub-agent jobs.
 *
 * Matches src/store/jobs.ts exactly: created with status "running" and an
 * "input" snapshot, patches merge over the stored record with an explicit
 * updatedAt honored, list is newest-activity-first, and EVERY successful
 * write emits jobs-changed (the dispatch cards retire their poll on it).
 */

import type { Pool, PoolClient } from "pg";
import { emit } from "../../core/events.ts";
import type { CreateJobInit, JobPatch, JobStore } from "../../core/ports.ts";
import type { JobRecord } from "../../core/contracts.ts";
import { pgOwner } from "./owner.ts";

function parseJob(value: unknown): JobRecord | null {
	if (typeof value === "string") {
		try { return JSON.parse(value) as JobRecord; } catch { return null; }
	}
	return value && typeof value === "object" ? (value as JobRecord) : null;
}

async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const result = await fn(client);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

export function createPostgresJobStore(pool: Pool): JobStore {
	return {
		async createJob(init: CreateJobInit) {
			const owner = pgOwner();
			const now = new Date().toISOString();
			const record: JobRecord = {
				id: `job_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`,
				kind: init.kind,
				chatId: init.chatId,
				toolCallId: init.toolCallId,
				...(init.input !== undefined ? { input: init.input } : {}),
				status: "running",
				activity: init.activity ?? "starting",
				createdAt: now,
				updatedAt: now,
				...(init.plugin ? { plugin: init.plugin } : {}),
			};
			await pool.query(
				`INSERT INTO jobs (owner_id, id, chat_id, tool_call_id, updated_at, payload)
				 VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
				[owner, record.id, record.chatId, record.toolCallId, record.updatedAt, JSON.stringify(record)],
			);
			emit("jobs-changed", { chatId: init.chatId });
			return record;
		},

		async getJob(id) {
			const { rows } = await pool.query<{ payload: unknown }>(
				"SELECT payload FROM jobs WHERE owner_id = $1 AND id = $2",
				[pgOwner(), id],
			);
			return rows[0] ? parseJob(rows[0].payload) : null;
		},

		async updateJob(id, patch: JobPatch) {
			const owner = pgOwner();
			const next = await withTx(pool, async (client) => {
				const { rows } = await client.query<{ payload: unknown }>(
					"SELECT payload FROM jobs WHERE owner_id = $1 AND id = $2 FOR UPDATE",
					[owner, id],
				);
				const record = rows[0] ? parseJob(rows[0].payload) : null;
				if (!record) return null;
				const merged: JobRecord = {
					...record,
					...patch,
					updatedAt: patch.updatedAt ?? new Date().toISOString(),
				};
				await client.query(
					`UPDATE jobs SET chat_id = $3, tool_call_id = $4, updated_at = $5, payload = $6::jsonb
					  WHERE owner_id = $1 AND id = $2`,
					[owner, id, merged.chatId, merged.toolCallId, merged.updatedAt, JSON.stringify(merged)],
				);
				return merged;
			});
			// EVERY write announces, not just status flips. A missing id wrote
			// nothing and stays silent.
			if (next) emit("jobs-changed", { chatId: next.chatId });
			return next;
		},

		async listJobs(chatId) {
			const { rows } = await pool.query<{ payload: unknown }>(
				"SELECT payload FROM jobs WHERE owner_id = $1 AND chat_id = $2 ORDER BY updated_at DESC",
				[pgOwner(), chatId],
			);
			return rows.map((row) => parseJob(row.payload)).filter((j): j is JobRecord => j !== null);
		},

		async findJobByToolCallId(chatId, toolCallId) {
			const { rows } = await pool.query<{ payload: unknown }>(
				`SELECT payload FROM jobs
				  WHERE owner_id = $1 AND chat_id = $2 AND tool_call_id = $3
				  ORDER BY updated_at DESC LIMIT 1`,
				[pgOwner(), chatId, toolCallId],
			);
			return rows[0] ? parseJob(rows[0].payload) : null;
		},

		async deleteJobsForChat(chatId) {
			const { rowCount } = await pool.query(
				"DELETE FROM jobs WHERE owner_id = $1 AND chat_id = $2",
				[pgOwner(), chatId],
			);
			const removed = rowCount ?? 0;
			if (removed > 0) emit("jobs-changed", { chatId });
			return removed;
		},
	};
}
