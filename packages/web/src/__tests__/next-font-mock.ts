/**
 * Test stub for `next/font/local`. The real export is a build-time macro
 * transformed by Next's compiler and is not callable under vitest, so we alias
 * it here (see vitest.config.ts) to a plain function returning the same shape.
 */
export default function localFont(options: { variable?: string } = {}) {
  return {
    className: "mock-font",
    variable: options.variable ?? "--font-mock",
    style: { fontFamily: "mock" },
  };
}
