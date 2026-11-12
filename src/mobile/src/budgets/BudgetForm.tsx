import { currencyExponent, type BudgetView } from '@budgedino/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  ActivityIndicator,
  Button,
  Chip,
  HelperText,
  SegmentedButtons,
  Text,
  TextInput,
} from 'react-native-paper';

import { useApi } from '../api/useApi';
import { minorToDecimalString } from '../format/money';
import { parseMoneyInput } from '../format/money-input';
import { useIsAdmin, useMembers } from '../household/queries';
import { SettingsPage } from '../settings/SettingsPage';
import { useAppTheme } from '../theme';
import { budgetsKey, describeBudgetError, useBudgets, useCategories } from './queries';

const NAME_MAX = 80;
const DEFAULT_CURRENCY = 'EUR';

/** `123456` minor EUR becomes `1234,56`, the form the amount field accepts. */
function amountToInput(budget: BudgetView): string {
  return minorToDecimalString(
    budget.amount.minor,
    currencyExponent(budget.amount.currency),
  ).replace('.', ',');
}

/** Create (no `budget`) or edit form. Admin-only; members get a short notice instead of the fields. */
export function BudgetForm({ budget }: { budget?: BudgetView }) {
  const theme = useAppTheme();
  const router = useRouter();
  const api = useApi();
  const client = useQueryClient();
  const isAdmin = useIsAdmin();
  const members = useMembers();
  const budgets = useBudgets();
  const categories = useCategories({ includeArchived: true });

  const [name, setName] = useState(budget?.name ?? '');
  const [selected, setSelected] = useState<string[]>(budget?.categoryIds ?? []);
  const [periodKind, setPeriodKind] = useState<'weekly' | 'monthly'>(
    budget?.periodKind ?? 'monthly',
  );
  const [amount, setAmount] = useState(budget ? amountToInput(budget) : '');
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // The server requires the household base currency; existing budgets carry it, EUR is the default.
  const currency =
    budget?.amount.currency ?? budgets.data?.[0]?.amount.currency ?? DEFAULT_CURRENCY;

  const trimmedName = name.trim();
  const nameError = trimmedName === '' ? 'Enter a name' : null;
  const categoryError = selected.length === 0 ? 'Pick at least one category' : null;
  const parsed = parseMoneyInput(amount, currency);
  const amountError = parsed.ok ? null : parsed.error;

  // Active spending categories, plus any archived one the budget still uses (shown, never newly offered).
  const options = (categories.data ?? []).filter(
    (c) => !c.isIncome && !c.isTransfer && (!c.archived || selected.includes(c.id)),
  );

  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const save = async () => {
    setSubmitted(true);
    setSaveError(null);
    if (nameError || categoryError || !parsed.ok) return;
    const amountBody = { minor: parsed.minor.toString(), currency };
    setSaving(true);
    try {
      if (budget) {
        await api.patchBudget(budget.id, {
          name: trimmedName,
          categoryIds: selected,
          periodKind,
          amount: amountBody,
        });
      } else {
        await api.createBudget({
          name: trimmedName,
          categoryIds: selected,
          periodKind,
          amount: amountBody,
        });
      }
      void client.invalidateQueries({ queryKey: budgetsKey });
      void client.invalidateQueries({ queryKey: ['home'] });
      router.back();
    } catch (error) {
      setSaveError(describeBudgetError(error, "Couldn't save the budget."));
    } finally {
      setSaving(false);
    }
  };

  const title = budget ? 'Edit budget' : 'New budget';
  if (!members.data && !members.isError) {
    return (
      <SettingsPage title={title}>
        <ActivityIndicator animating accessibilityLabel="Loading" />
      </SettingsPage>
    );
  }
  if (!isAdmin) {
    return (
      <SettingsPage title={title}>
        <Text variant="bodyMedium" style={styles.pad} testID="budget-admin-only">
          Only admins can change budgets.
        </Text>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage title={title}>
      <View style={styles.form}>
        <TextInput
          mode="outlined"
          label="Name"
          value={name}
          onChangeText={setName}
          maxLength={NAME_MAX}
          error={submitted && nameError !== null}
          testID="budget-name"
        />
        {submitted && nameError ? <HelperText type="error">{nameError}</HelperText> : null}

        <Text variant="titleSmall" style={styles.label}>
          Categories
        </Text>
        <View style={styles.chips}>
          {options.map((c) => (
            <Chip
              key={c.id}
              selected={selected.includes(c.id)}
              showSelectedCheck
              onPress={() => toggle(c.id)}
              accessibilityLabel={c.archived ? `${c.name} (archived)` : c.name}
              testID={`category-${c.id}`}
            >
              {c.archived ? `${c.name} (archived)` : c.name}
            </Chip>
          ))}
        </View>
        {submitted && categoryError ? <HelperText type="error">{categoryError}</HelperText> : null}

        <Text variant="titleSmall" style={styles.label}>
          Period
        </Text>
        <SegmentedButtons
          value={periodKind}
          onValueChange={(v) => setPeriodKind(v === 'weekly' ? 'weekly' : 'monthly')}
          buttons={[
            { value: 'weekly', label: 'Weekly', testID: 'period-weekly' },
            { value: 'monthly', label: 'Monthly', testID: 'period-monthly' },
          ]}
        />

        <TextInput
          mode="outlined"
          label={`Amount (${currency})`}
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          error={submitted && amountError !== null}
          style={styles.label}
          testID="budget-amount"
        />
        {submitted && amountError ? <HelperText type="error">{amountError}</HelperText> : null}

        {saveError ? (
          <Text
            variant="bodyMedium"
            style={{ color: theme.colors.error }}
            accessibilityLiveRegion="polite"
            testID="budget-save-error"
          >
            {saveError}
          </Text>
        ) : null}

        <Button
          mode="contained"
          onPress={() => void save()}
          disabled={saving}
          loading={saving}
          style={styles.label}
          testID="budget-save"
        >
          Save
        </Button>
      </View>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: 16 },
  form: { paddingHorizontal: 16, gap: 4 },
  label: { marginTop: 16 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
