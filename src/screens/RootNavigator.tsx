/**
 * The entire navigation layer for this app.
 *
 * One hook (`useMapViewModel`) owns state shared by both screens — the
 * roster and friend filter are read by each of them — and one flag says
 * which to render. See `useMapViewModel`'s own doc comment for why that is
 * a plain state flag rather than a routing library: exactly one transition
 * exists (map to Friends and back), so there is no back stack, no deep
 * link, and no third destination for a navigator to earn its keep against.
 *
 * This branches on `vm.screen` directly rather than through any navigation
 * abstraction — a deliberate case-study simplification. A production build
 * would put a thin wrapper (e.g. a `useNavigator()` hook) between this file
 * and `vm.screen`/`openFriends`/`closeFriends`, so introducing a real
 * routing library later, or changing how transitions behave, is a change in
 * that one wrapper rather than every place that currently reads them.
 */

import React from 'react';
import { useMapViewModel } from '../viewmodels/useMapViewModel';
import { MapScreen } from './MapScreen';
import { FriendsScreen } from './FriendsScreen';

export function RootNavigator() {
  const vm = useMapViewModel();

  if (vm.screen === 'friends') {
    return (
      <FriendsScreen
        roster={vm.roster}
        mode={vm.friendMode}
        selectedIds={vm.selectedFriendIds}
        onToggleAll={vm.toggleAllFriends}
        onToggle={vm.toggleFriend}
        onClose={vm.closeFriends}
      />
    );
  }

  return <MapScreen vm={vm} />;
}
