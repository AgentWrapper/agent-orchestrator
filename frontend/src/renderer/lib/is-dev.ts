/**
 * Compile-time dev gate. When Vite's `import.meta.env.DEV` is false (production
 * builds), this folds to `false` and the dead-code elimination strips guarded blocks.
 *
 * Equivalent to the `IS_DEV` env var idiom used in other stacks — use this for
 * gating dev-only UI surfaces like the Dev Settings panel.
 */
export const IS_DEV: boolean = import.meta.env.DEV;
