// Runs inside workerd before each test file: apply every migration in
// ./migrations to the (isolated) test D1 database, so integration tests run
// against the real schema. The migrations array itself is read on the Node
// side by vitest.config.ts (readD1Migrations) and passed in via provide/inject.
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, inject } from 'vitest';

beforeAll(async () => {
	await applyD1Migrations(env.DB, inject('migrations'));
});
