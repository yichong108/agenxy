export default {
  '**/*.{ts,tsx,mjs,cjs,js,jsx,json,md,scss,css}': 'prettier --write',
  '**/*.{ts,tsx,js,jsx,mjs,cjs}': 'oxlint --fix'
}
