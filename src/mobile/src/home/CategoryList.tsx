import type { BudgetView, CategoryIcon as CategoryIconName } from '@budgedino/shared';
import { StyleSheet, View } from 'react-native';
import { Icon, Text, TouchableRipple } from 'react-native-paper';

import { CategoryIcon } from '../categories/CategoryIcon';
import { formatMoney } from '../format/money';
import { useAppTheme, useWarningColor } from '../theme';
import { barState, elapsedFraction, overBy, type BarLevel, type HomeGroup } from './budget-math';

type Style = { icon: CategoryIconName; color: string };

/** The drill-down period: a budget's own span (weekly budgets); the displayed one when omitted. */
export interface DrillPeriod {
  /** `YYYY-MM` or `YYYY-Www`; the drill-down days derive from it. */
  key: string;
  start: string;
  end: string;
}

export function useLevelColor(): Record<BarLevel, string> {
  const theme = useAppTheme();
  const warning = useWarningColor();
  return { ok: theme.colors.primary, warn: warning, over: theme.colors.error };
}

function Chevron() {
  const theme = useAppTheme();
  return <Icon source="chevron-right" size={20} color={theme.colors.onSurfaceVariant} />;
}

function BudgetBar({ budget, now }: { budget: BudgetView; now: Date }) {
  const theme = useAppTheme();
  const colors = useLevelColor();
  const bar = barState(budget);
  const tick = Math.round(elapsedFraction(budget.period, now) * 10000) / 100;
  return (
    <View
      testID="budget-bar-track"
      accessibilityRole="progressbar"
      accessibilityLabel={`${budget.name}, household budget: ${bar.usedPercent} percent used`}
      accessibilityValue={{ min: 0, max: 100, now: bar.fillPercent }}
      style={[styles.track, { backgroundColor: theme.colors.surfaceVariant }]}
    >
      <View
        testID="budget-bar-fill"
        style={[styles.fill, { width: `${bar.fillPercent}%`, backgroundColor: colors[bar.level] }]}
      />
      <View
        testID="pace-tick"
        style={[styles.tick, { left: `${tick}%`, backgroundColor: theme.colors.onSurface }]}
      />
    </View>
  );
}

function BudgetRowView({
  budget,
  icon,
  viewerSpent,
  tappable,
  onPress,
  now,
}: {
  budget: BudgetView;
  icon: Style;
  /** Set when the viewer's own visible spending differs from the household-wide budget figure. */
  viewerSpent: { minor: string; currency: string } | null;
  tappable: boolean;
  onPress: () => void;
  now: Date;
}) {
  const theme = useAppTheme();
  const bar = barState(budget);
  const spent = formatMoney(budget.spent);
  const amount = formatMoney(budget.amount);
  const over = bar.overBudget ? overBy(budget) : null;
  const overText = over ? `Over by ${formatMoney(over)}` : 'Over budget';

  const content = (
    <View style={styles.budgetRow}>
      <CategoryIcon icon={icon.icon} color={icon.color} size="md" />
      <View style={styles.grow}>
        <View style={styles.line}>
          <View style={styles.name}>
            <Text variant="bodyLarge" style={{ color: theme.colors.onSurface }}>
              {budget.name}
            </Text>
            {budget.periodKind === 'weekly' ? (
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                week
              </Text>
            ) : null}
            {viewerSpent ? (
              <Text
                variant="bodySmall"
                testID="budget-viewer-spent"
                style={{ color: theme.colors.onSurfaceVariant }}
              >
                {`You: ${formatMoney(viewerSpent)}`}
              </Text>
            ) : null}
          </View>
          <Text
            variant="bodyMedium"
            style={[styles.amounts, { color: theme.colors.onSurfaceVariant }]}
            testID="budget-amounts"
          >
            {`${spent} / ${amount}`}
          </Text>
          {tappable ? <Chevron /> : null}
        </View>
        <BudgetBar budget={budget} now={now} />
        {bar.overBudget ? (
          <Text variant="labelMedium" style={{ color: theme.colors.error }} testID="budget-over">
            {overText}
          </Text>
        ) : null}
        {budget.fxMissing ? (
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            Some foreign amounts couldn&apos;t be converted.
          </Text>
        ) : null}
      </View>
    </View>
  );
  if (!tappable) return <View testID={`budget-${budget.id}`}>{content}</View>;
  return (
    <TouchableRipple
      testID={`budget-${budget.id}`}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${budget.name}, household budget, ${spent} of ${amount}${bar.overBudget ? `, ${overText.toLowerCase()}` : ''}. Show transactions`}
    >
      {content}
    </TouchableRipple>
  );
}

function CategoryRowView({
  testID,
  name,
  spent,
  currency,
  icon,
  size,
  indent,
  onPress,
}: {
  testID: string;
  name: string;
  spent: { minor: string; currency: string } | null;
  /** Used to show "0,00" for a category without spending. */
  currency: string;
  icon: Style;
  size: 'sm' | 'md';
  indent?: boolean;
  onPress: () => void;
}) {
  const theme = useAppTheme();
  const value = formatMoney(spent ?? { minor: '0', currency });
  return (
    <TouchableRipple
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${value}. Show transactions`}
    >
      <View style={[styles.categoryRow, indent ? styles.indent : null]}>
        <CategoryIcon icon={icon.icon} color={icon.color} size={size} />
        <Text variant="bodyLarge" style={[styles.nameFlex, { color: theme.colors.onSurface }]}>
          {name}
        </Text>
        <Text
          variant="bodyLarge"
          style={[
            styles.value,
            { color: spent ? theme.colors.onSurface : theme.colors.onSurfaceVariant },
          ]}
        >
          {value}
        </Text>
        <Chevron />
      </View>
    </TouchableRipple>
  );
}

/**
 * The one Home list: budget rows (icon, name, "spent / amount", bar with a pace tick), a
 * single-category budget being one tappable row and a multi-category budget a row with indented
 * sub-rows, then the categories no budget covers. Every tappable row drills down to its category.
 */
export function CategoryList({
  groups,
  fxMissing,
  styleOf,
  onOpenCategory,
  now = new Date(),
}: {
  groups: HomeGroup[];
  fxMissing: boolean;
  styleOf: (categoryId: string | null) => Style;
  /** `period` is set for a budget's own span (weekly), otherwise the displayed period applies. */
  onOpenCategory: (categoryId: string | null, period?: DrillPeriod) => void;
  now?: Date;
}) {
  const theme = useAppTheme();
  return (
    <View testID="category-list">
      {groups.length === 0 ? (
        <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
          No spending in this period.
        </Text>
      ) : (
        groups.map((g) => {
          if (g.kind === 'category') {
            return (
              <CategoryRowView
                key={`c-${g.categoryId ?? 'uncategorized'}`}
                testID={`category-row-${g.categoryId ?? 'uncategorized'}`}
                name={g.name}
                spent={g.spent}
                currency={g.spent.currency}
                icon={styleOf(g.categoryId)}
                size="md"
                onPress={() => onOpenCategory(g.categoryId)}
              />
            );
          }
          const first = g.categories[0];
          const single = g.categories.length === 1 && first ? first : null;
          const icon: Style = styleOf(first ? first.categoryId : g.budget.id);
          // Budget numbers are household-wide; say what the viewer sees when that can differ.
          const viewerSpent =
            single && (single.spent?.minor ?? '0') !== g.budget.spent.minor
              ? (single.spent ?? { minor: '0', currency: g.budget.spent.currency })
              : null;
          return (
            <View key={`b-${g.budget.id}`}>
              <BudgetRowView
                budget={g.budget}
                icon={icon}
                viewerSpent={viewerSpent}
                tappable={single !== null}
                onPress={() => single && onOpenCategory(single.categoryId, g.budget.period)}
                now={now}
              />
              {single
                ? null
                : g.categories.map((c) => (
                    <CategoryRowView
                      key={c.categoryId}
                      testID={`budget-${g.budget.id}-category-${c.categoryId}`}
                      name={c.name}
                      spent={c.spent}
                      currency={g.budget.amount.currency}
                      icon={styleOf(c.categoryId)}
                      size="sm"
                      indent
                      onPress={() => onOpenCategory(c.categoryId, g.budget.period)}
                    />
                  ))}
            </View>
          );
        })
      )}
      {fxMissing ? (
        <Text variant="bodySmall" style={[styles.note, { color: theme.colors.onSurfaceVariant }]}>
          Some foreign amounts couldn&apos;t be converted.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  budgetRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 10 },
  categoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 12,
    paddingVertical: 8,
  },
  indent: { paddingLeft: 16 },
  grow: { flex: 1, gap: 6 },
  nameFlex: { flex: 1, minWidth: 120 },
  line: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: 8, rowGap: 2 },
  name: { flexShrink: 1, flexGrow: 1 },
  amounts: { flexShrink: 1, textAlign: 'right', fontVariant: ['tabular-nums'] },
  value: { flexShrink: 0, textAlign: 'right', fontVariant: ['tabular-nums'] },
  track: { height: 6, borderRadius: 3 },
  fill: { height: '100%', borderRadius: 3 },
  // Marks the fraction of the budget's own period that has elapsed (a 12 dp tick across a 6 dp bar).
  tick: { position: 'absolute', top: -3, width: 2, height: 12, opacity: 0.55, marginLeft: -1 },
  note: { marginTop: 8 },
});
