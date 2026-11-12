import { useLocalSearchParams } from 'expo-router';

import { TransactionDetailScreen } from '../../../src/transactions/TransactionDetailScreen';

export default function TransactionDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <TransactionDetailScreen id={id} />;
}
