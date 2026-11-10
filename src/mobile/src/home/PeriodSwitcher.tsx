import { SegmentedButtons } from 'react-native-paper';

export type HomePeriod = 'current' | 'previous';

export function PeriodSwitcher({
  value,
  onChange,
}: {
  value: HomePeriod;
  onChange: (period: HomePeriod) => void;
}) {
  return (
    <SegmentedButtons
      value={value}
      onValueChange={(v) => onChange(v === 'previous' ? 'previous' : 'current')}
      buttons={[
        { value: 'current', label: 'Current', testID: 'period-current' },
        { value: 'previous', label: 'Previous', testID: 'period-previous' },
      ]}
    />
  );
}
