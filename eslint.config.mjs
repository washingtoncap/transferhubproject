import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config({ignores:['node_modules/**','dist/**','**/.next/**','**/next-env.d.ts']},js.configs.recommended,{files:['**/*.mjs'],languageOptions:{globals:{console:'readonly'}}},...ts.configs.recommended,{files:['**/*.{ts,tsx}'],rules:{'@typescript-eslint/no-explicit-any':'error','@typescript-eslint/no-unused-vars':['error',{argsIgnorePattern:'^_'}]}});
