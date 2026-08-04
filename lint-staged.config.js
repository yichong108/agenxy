export default {
  'apps/desktop/**/*.{ts,tsx,mjs,cjs,js,json,md,scss,css}': () => [
    'pnpm --filter @luneto/desktop run format',
    'pnpm --filter @luneto/desktop run lint:fix'
  ],
  'apps/landing/**/*.{ts,tsx,mjs,cjs,js,json,md,scss,css}': () => [
    'pnpm --filter @luneto/landing run format',
    'pnpm --filter @luneto/landing run lint:fix'
  ]
}
