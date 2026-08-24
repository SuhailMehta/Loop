#!/usr/bin/env bash
#
# Tier boundary enforcement.
#
# Architecture diagrams do not hold. This does.
#
# Two rules, both cheap, both catching the failure modes that actually kill
# layered designs in practice:
#
#   1. VOCABULARY — no domain nouns below Tier 3. Every leak in a platform
#      starts as one innocent `isFriend` flag, and by the time anyone notices,
#      three teams depend on it.
#
#   2. DIRECTION — dependencies point downward only. The framework may never
#      import a use-case kit, and the design system may import neither.
#
# Wire into CI and the pre-push hook. A failure here is a design regression,
# not a style nit.

set -uo pipefail
cd "$(dirname "$0")/.."

STATUS=0

# ---------------------------------------------------------------------------
# Rule 1: domain vocabulary must not appear in the framework or design tiers.
# ---------------------------------------------------------------------------
# Words specific to THIS product's first use case. If the map framework knows
# any of these, it is no longer horizontal.
#
# Excludes generic English collisions ("message delivery", "driving profile")
# and skips comment lines — documentation that explains the rule necessarily
# names the words the rule bans.
DOMAIN_WORDS='friend|buddy|marathon|concert|festival|attendee'

echo "==> Checking domain vocabulary in src/geo and src/design"
LEAKS=$(grep -rniE "\b(${DOMAIN_WORDS})\b" src/geo src/design \
  --include='*.ts' --include='*.tsx' --include='*.kt' --include='*.swift' --include='*.h' --include='*.cpp' \
  2>/dev/null | grep -vE ':[0-9]+:[[:space:]]*(\*|//|/\*)' || true)

if [ -n "$LEAKS" ]; then
  echo "FAIL: domain vocabulary leaked into a framework tier."
  echo "      The map must not know what a friend or a venue is."
  echo "$LEAKS"
  STATUS=1
else
  echo "  ok — framework tiers are domain-free"
fi

# ---------------------------------------------------------------------------
# Rule 2: dependency direction.
# ---------------------------------------------------------------------------
echo "==> Checking dependency direction"

# src/geo must never import a use-case kit.
UPWARD=$(grep -rnE "from ['\"](@kits/|\.\./kits/|\.\./\.\./kits/)" src/geo \
  --include='*.ts' --include='*.tsx' 2>/dev/null || true)
if [ -n "$UPWARD" ]; then
  echo "FAIL: src/geo imports from a use-case kit (upward dependency)."
  echo "$UPWARD"
  STATUS=1
else
  echo "  ok — src/geo does not depend on kits"
fi

# src/design is a leaf: it may import nothing from geo or kits.
DESIGN_DEPS=$(grep -rnE "from ['\"](@geo|@kits|\.\./geo/|\.\./kits/)" src/design \
  --include='*.ts' --include='*.tsx' 2>/dev/null || true)
if [ -n "$DESIGN_DEPS" ]; then
  echo "FAIL: src/design imports from geo or kits. The design tier is a leaf."
  echo "$DESIGN_DEPS"
  STATUS=1
else
  echo "  ok — src/design is a leaf"
fi

# ---------------------------------------------------------------------------
# Rule 3: raw palette values must not escape the token layer.
# ---------------------------------------------------------------------------
echo "==> Checking for hardcoded colours outside the design tier"
HARDCODED=$(grep -rnE "#[0-9a-fA-F]{6}\b" src/geo src/kits src/ui \
  --include='*.ts' --include='*.tsx' 2>/dev/null || true)
if [ -n "$HARDCODED" ]; then
  echo "WARN: hex colour outside src/design — should be a semantic token."
  echo "$HARDCODED"
  # Warning rather than failure: a one-off debug overlay is a defensible reason.
else
  echo "  ok — no stray hex colours"
fi

if [ $STATUS -eq 0 ]; then
  echo ""
  echo "Tier check passed."
else
  echo ""
  echo "Tier check FAILED."
fi
exit $STATUS
