import { StyleSheet } from 'react-native';
import { TextInput } from 'react-native-paper';

import { sanitizeTotp, TOTP_LENGTH } from './validation';

interface Props {
  value: string;
  onChange: (code: string) => void;
  testID?: string;
}

/** Six-digit code field: digits only, no fixed width or height so it scales with the font. */
export function TotpField({ value, onChange, testID = 'totp-input' }: Props) {
  return (
    <TextInput
      testID={testID}
      mode="outlined"
      label="6-digit code"
      value={value}
      onChangeText={(t) => {
        onChange(sanitizeTotp(t));
      }}
      keyboardType="number-pad"
      inputMode="numeric"
      maxLength={TOTP_LENGTH}
      autoComplete="one-time-code"
      textContentType="oneTimeCode"
      autoCorrect={false}
      style={styles.input}
    />
  );
}

const styles = StyleSheet.create({ input: { letterSpacing: 4 } });
