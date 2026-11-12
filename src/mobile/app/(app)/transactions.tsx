import { useLocalSearchParams } from 'expo-router';

import { TransactionsScreen } from '../../src/transactions/TransactionsScreen';

export default function Transactions() {
  const params = useLocalSearchParams<{
    categoryId?: string;
    uncategorized?: string;
    from?: string;
    to?: string;
    n?: string;
  }>();
  return <TransactionsScreen params={params} />;
}
