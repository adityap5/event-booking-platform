import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema.ts',
 out: '../../apps/worker/migrations',
  dialect: 'sqlite',
  driver: 'd1-http',
});
