import { useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Text } from 'react-native-paper';

import { BudgetForm } from '../../../../src/budgets/BudgetForm';
import { useBudgets } from '../../../../src/budgets/queries';
import { SettingsPage } from '../../../../src/settings/SettingsPage';

export default function Page() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const budgets = useBudgets();
  const budget = budgets.data?.find((b) => b.id === id);
  if (budget) return <BudgetForm key={budget.id} budget={budget} />;
  return (
    <SettingsPage title="Edit budget">
      {budgets.data || budgets.isError ? (
        <Text variant="bodyMedium" style={{ paddingHorizontal: 16 }}>
          This budget no longer exists.
        </Text>
      ) : (
        <ActivityIndicator animating accessibilityLabel="Loading" />
      )}
    </SettingsPage>
  );
}
