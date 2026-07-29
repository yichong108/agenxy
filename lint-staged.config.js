export default {
  'apps/desktop/**/*.{ts,tsx,mjs,cjs,js,json,md,scss,css}': () => [
    'pnpm --filter @agenwork/desktop run format',
    'pnpm --filter @agenwork/desktop run lint:fix'
  ],
  'apps/landing/**/*.{ts,tsx,mjs,cjs,js,json,md,scss,css}': () => [
    'pnpm --filter @agenwork/landing run format',
    'pnpm --filter @agenwork/landing run lint:fix'
  ]
}
