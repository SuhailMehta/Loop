/**
 * Tier: design (leaf).
 *
 * Theme distribution for the React Native side.
 *
 * Deliberately minimal: context holds a token object and nothing else. The map
 * does NOT read theme through this provider on its hot path — MapSurface reads
 * tokens once at layer-build time and hands MapLibre a static paint spec, so a
 * theme change re-declares layers rather than re-rendering per frame.
 */

import React, { createContext, useContext, useMemo, useState, type PropsWithChildren } from 'react';
import { useColorScheme } from 'react-native';
import { themes, type SemanticTokens, type ThemeName } from './tokens/semantic';

interface ThemeContextValue {
  tokens: SemanticTokens;
  name: ThemeName;
  /** null = follow the OS. An explicit value pins the theme (used by the demo toggle). */
  setOverride: (name: ThemeName | null) => void;
  override: ThemeName | null;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: PropsWithChildren) {
  const system = useColorScheme();
  const [override, setOverride] = useState<ThemeName | null>(null);

  const value = useMemo<ThemeContextValue>(() => {
    const name: ThemeName = override ?? (system === 'dark' ? 'dark' : 'light');
    return { tokens: themes[name], name, setOverride, override };
  }, [override, system]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used inside <ThemeProvider>');
  }
  return ctx;
}

/** Convenience for the common case where only the token object is needed. */
export function useTokens(): SemanticTokens {
  return useTheme().tokens;
}

/**
 * Builds a StyleSheet from tokens and memoises per theme.
 *
 * Why not plain StyleSheet.create at module scope: styles depend on the active
 * theme, so they must be derived. Why not inline objects: those allocate on
 * every render and defeat RN's style registry.
 */
export function makeStyles<T extends Record<string, object>>(factory: (t: SemanticTokens) => T) {
  const cache = new Map<ThemeName, T>();
  return function useStyles(): T {
    const tokens = useTokens();
    let styles = cache.get(tokens.name);
    if (!styles) {
      styles = factory(tokens);
      cache.set(tokens.name, styles);
    }
    return styles;
  };
}
