export default {
  'apps/desktop/**/*.{ts,tsx,mjs,cjs,js,json,md,scss,css}': () => [
    'pnpm --filter @agenxy/desktop run format',
    'pnpm --filter @agenxy/desktop run lint:fix'
  ],
  'apps/landing/**/*.{ts,tsx,mjs,cjs,js,json,md,scss,css}': () => [
    'pnpm --filter @agenxy/landing run format',
    'pnpm --filter @agenxy/landing run lint:fix'
  ]
}
