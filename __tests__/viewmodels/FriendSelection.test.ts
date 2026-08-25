import {
  INITIAL_FRIEND_SELECTION,
  toggleAllFriends,
  toggleFriend,
  visibleFriendCount,
  visibleFriendIds,
} from '../../src/viewmodels/FriendSelection';

describe('friendSelection', () => {
  test('starts as "all", selecting nobody explicitly', () => {
    expect(INITIAL_FRIEND_SELECTION.mode).toBe('all');
    expect(visibleFriendIds(INITIAL_FRIEND_SELECTION)).toBe('all');
  });

  test('unchecking one person out of "all" keeps everyone else, not nobody', () => {
    const roster = ['a', 'b', 'c'];
    const next = toggleFriend(INITIAL_FRIEND_SELECTION, 'b', roster);

    expect(next.mode).toBe('any');
    expect(next.selectedIds).toEqual(new Set(['a', 'c']));
  });

  test('a person named later is not silently included by "any"', () => {
    // "all" materialises against the roster AS IT STOOD at the moment of the
    // toggle — a new arrival after that point must be checked explicitly.
    const rosterAtToggleTime = ['a', 'b'];
    const state = toggleFriend(INITIAL_FRIEND_SELECTION, 'a', rosterAtToggleTime);

    expect(state.selectedIds.has('c')).toBe(false);
  });

  test('toggling within "any" flips membership without touching the mode', () => {
    const any = { mode: 'any' as const, selectedIds: new Set(['a']) };

    const added = toggleFriend(any, 'b', ['a', 'b']);
    expect(added.selectedIds).toEqual(new Set(['a', 'b']));

    const removed = toggleFriend(added, 'a', ['a', 'b']);
    expect(removed.selectedIds).toEqual(new Set(['b']));
  });

  test('"select all" is a toggle, not a one-way switch', () => {
    const on = toggleAllFriends(INITIAL_FRIEND_SELECTION);
    expect(on.mode).toBe('any');
    expect(on.selectedIds.size).toBe(0);

    const off = toggleAllFriends(on);
    expect(off.mode).toBe('all');
  });

  test('"select all" always resets explicit selection rather than restoring it', () => {
    const partial = { mode: 'any' as const, selectedIds: new Set(['a', 'b']) };
    const toggled = toggleAllFriends(partial);
    expect(toggled.mode).toBe('all');

    const toggledAgain = toggleAllFriends(toggled);
    expect(toggledAgain.selectedIds.size).toBe(0);
  });

  test('visible count reflects roster size in "all", selection size in "any"', () => {
    expect(visibleFriendCount(INITIAL_FRIEND_SELECTION, 32)).toBe(32);

    const any = { mode: 'any' as const, selectedIds: new Set(['a', 'b']) };
    expect(visibleFriendCount(any, 32)).toBe(2);
  });
});
