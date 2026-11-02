import { defineConfig } from 'rolldown'

// One file for the release: the prompts stay beside it in prompts/, where `../prompts/*.md` finds them from dist/.
export default defineConfig({
  input: 'src/main.ts',
  platform: 'node',
  output: { file: 'dist/main.mjs', format: 'esm', codeSplitting: false },
  transform: { define: { 'process.env.PR_REVIEW_VERSION': JSON.stringify(process.env.PR_REVIEW_VERSION ?? '0.0.0') } },
})
