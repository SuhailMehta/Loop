/**
 * Tier: design (leaf — imports nothing from src/geo or src/kits).
 *
 * Public surface of the design system. Feature code imports from here only;
 * `tokens/primitives` is intentionally not re-exported so raw palette values
 * cannot leak into components.
 */

import * as mapStyles from './adapters/maplibre';

export { ThemeProvider, useTheme, useTokens, makeStyles } from './ThemeProvider';
export { themes, lightTheme, darkTheme, scale } from './tokens/semantic';
export type { SemanticTokens, ThemeName } from './tokens/semantic';

// Namespaced rather than `export * as` — that syntax needs
// @babel/plugin-transform-export-namespace-from, which React Native's preset
// does not enable, and it fails at bundle time rather than typecheck time.
export { mapStyles };
