import { useLocalSearchParams } from 'expo-router';

import { ChallengeScreen } from '../../../../src/connections/ChallengeScreen';

export default function Challenge() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ChallengeScreen id={id} />;
}
