/**
 * Friend-selection state machine — pure, no React.
 *
 * Deliberately framework-free: every transition here is a plain function of
 * (state, action) -> state, so the rules ("what does unchecking one person
 * out of 'all' actually mean") are testable with plain Jest, no rendering,
 * no hook harness. `useMapViewModel` is the only thing that wires this to
 * `useState`; the rules themselves don't know React exists.
 *
 * "All" means everyone, including whoever the source names next — not a
 * snapshot of who happened to be on the roster when it was chosen. That is
 * why unchecking one person out of "all" has to be handed the roster's
 * CURRENT id set at that moment: there is no other way to express "everyone
 * except this one" for a roster that is still growing.
 */

export interface FriendRosterEntry {
  id: string;
  label: string;
  participation: string;
  /** Opaque per-entity discriminator the source assigns; indexes the identity palette. */
  variant: number;
}

/** 'all' = everyone, including anyone the source names later. 'any' = exactly `selectedIds`. */
export type FriendFilterMode = 'all' | 'any';

export interface FriendSelectionState {
  readonly mode: FriendFilterMode;
  readonly selectedIds: ReadonlySet<string>;
}

export const INITIAL_FRIEND_SELECTION: FriendSelectionState = {
  mode: 'all',
  selectedIds: new Set(),
};

export function toggleFriend(
  state: FriendSelectionState,
  id: string,
  currentRosterIds: Iterable<string>,
): FriendSelectionState {
  if (state.mode === 'all') {
    const selectedIds = new Set(currentRosterIds);
    selectedIds.delete(id);
    return { mode: 'any', selectedIds };
  }

  const selectedIds = new Set(state.selectedIds);
  if (selectedIds.has(id)) {
    selectedIds.delete(id);
  } else {
    selectedIds.add(id);
  }
  return { mode: 'any', selectedIds };
}

/**
 * The top "Select all" row. Always resets explicit selection rather than
 * trying to restore a previous partial one — turning it off empties the
 * list, turning it on shows everyone. That is the only reading of a single
 * checkbox that stays predictable without a separate "restore" affordance.
 */
export function toggleAllFriends(state: FriendSelectionState): FriendSelectionState {
  return {
    mode: state.mode === 'all' ? 'any' : 'all',
    selectedIds: new Set(),
  };
}

export function visibleFriendIds(state: FriendSelectionState): 'all' | ReadonlySet<string> {
  return state.mode === 'all' ? 'all' : state.selectedIds;
}

export function visibleFriendCount(state: FriendSelectionState, rosterLength: number): number {
  return state.mode === 'all' ? rosterLength : state.selectedIds.size;
}
