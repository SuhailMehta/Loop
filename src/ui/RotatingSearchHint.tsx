/**
 * Rotating search hint — shared by the map's search entry and the Friends
 * screen's own search field, so the two never drift into two different
 * animations for what is conceptually the same affordance.
 *
 * A handful of real names cycling through the field, top slot rolling down
 * and out as the next one rolls down into place — a hint at who is
 * searchable, not a static "Search friends" that says nothing about scale.
 * Purely decorative: it never touches an actual query, and each consumer is
 * responsible for hiding it once the user starts typing.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { scale, useTokens } from '@design';

export interface RosterNameSource {
  readonly label: string;
}

export interface RotatingSearchHintProps {
  roster: readonly RosterNameSource[];
  /** Static lead-in before the rotating name. Pass '' to omit it. */
  prefix?: string;
  /** Shown in place of the animation when the roster is empty. */
  emptyLabel?: string;
  sampleSize?: number;
  /**
   * Applied to the root row. Callers in a row layout that need this to fill
   * the remaining space (the map search bar) pass `{ flex: 1 }`; callers
   * that already stretch their children (the Friends screen's search field)
   * can leave it unset.
   */
  style?: StyleProp<ViewStyle>;
}

function sample<T>(items: readonly T[], count: number): T[] {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j] as T, pool[i] as T];
  }
  return pool.slice(0, Math.min(count, pool.length));
}

const HINT_ROTATE_MS = 2200;
const HINT_ANIM_MS = 380;
const HINT_ROW_H = 20;

export function RotatingSearchHint({
  roster,
  prefix = 'Search ',
  emptyLabel = 'Search friends',
  sampleSize = 5,
  style,
}: RotatingSearchHintProps) {
  const tokens = useTokens();
  const hasRoster = roster.length > 0;
  // Sampled once the roster has names, not reshuffled on every arrival — the
  // hint should feel steady, not jittery as the source fills in.
  const names = useMemo(
    () => sample(roster, sampleSize).map(f => f.label),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately keyed on the roster's first arrival, not its ongoing growth
    [hasRoster],
  );

  const [index, setIndex] = useState(0);
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (names.length < 2) {
      return;
    }
    const id = setInterval(() => {
      Animated.timing(anim, {
        toValue: 1,
        duration: HINT_ANIM_MS,
        useNativeDriver: true,
      }).start(() => {
        // Reset the driven value BEFORE swapping which name is "current" —
        // otherwise the newly-assigned text renders for one frame with the
        // still-rotated-out transform from the finished animation, which is
        // what showed up as a flicker between names.
        anim.setValue(0);
        setIndex(i => (i + 1) % names.length);
      });
    }, HINT_ROTATE_MS);
    return () => clearInterval(id);
  }, [names, anim]);

  // Interpolations must stay referentially stable across renders — recreating
  // them on every `index` change forces the native driver to tear down and
  // re-attach the animated node graph on each cycle, which is what showed up
  // as a jitter/flash rather than a smooth slide. Computed unconditionally,
  // above the empty-roster return below, so the hook order never changes
  // between a render with no names and one with names.
  const { outT, outO, inT, inO } = useMemo(
    () => ({
      outT: anim.interpolate({ inputRange: [0, 1], outputRange: [0, HINT_ROW_H] }),
      outO: anim.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
      inT: anim.interpolate({ inputRange: [0, 1], outputRange: [-HINT_ROW_H, 0] }),
      inO: anim.interpolate({ inputRange: [0, 1], outputRange: [0, 1] }),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `anim` is a stable ref; recomputing per index defeats the memoization
    [anim],
  );

  if (names.length === 0) {
    return <Text style={[styles.hintText, { color: tokens.text.secondary }]}>{emptyLabel}</Text>;
  }

  const current = names[index] as string;
  const next = names[(index + 1) % names.length] as string;

  return (
    <View style={[styles.hintRow, style]}>
      {prefix ? (
        <Text style={[styles.hintText, { color: tokens.text.secondary }]}>{prefix}</Text>
      ) : null}
      {/*
        renderToHardwareTextureAndroid forces this clip onto its own layer.
        Without it, Android's overflow:hidden does not reliably clip a child
        whose transform is driven by the native animated driver — the moving
        text was escaping the pill entirely instead of being cropped at its
        edge, which is what showed up as a flicker/ghost above the search bar.
      */}
      <View style={styles.hintNameClip} renderToHardwareTextureAndroid>
        <Animated.Text
          numberOfLines={1}
          style={[
            styles.hintText,
            styles.hintAbs,
            { color: tokens.text.secondary, opacity: outO, transform: [{ translateY: outT }] },
          ]}
        >
          {current}
        </Animated.Text>
        <Animated.Text
          numberOfLines={1}
          style={[
            styles.hintText,
            styles.hintAbs,
            { color: tokens.text.secondary, opacity: inO, transform: [{ translateY: inT }] },
          ]}
        >
          {next}
        </Animated.Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hintRow: { flexDirection: 'row', alignItems: 'center', flexShrink: 1 },
  hintText: { fontSize: scale.typography.size.md },
  hintNameClip: { height: HINT_ROW_H, flex: 1, overflow: 'hidden' },
  // `right: 0` pins this to the clip's full width rather than the text's own
  // intrinsic width — without it, Android has to remeasure/relayout the box
  // whenever the name's length changes (e.g. "Riya" -> "Om"), which showed up
  // as a flicker mid-animation instead of a plain glyph swap.
  hintAbs: { position: 'absolute', left: 0, right: 0, top: 0 },
});
