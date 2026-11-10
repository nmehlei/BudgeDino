import { useEffect, useState } from 'react';
import { Image, StyleSheet } from 'react-native';
import { Avatar } from 'react-native-paper';

import { useApi } from '../api/useApi';
import { useAppTheme } from '../theme';
import { bankBrand } from './banks';

interface Props {
  /** Non-secret bank id (`dkb`, `comdirect`, `fake`). */
  bank: string;
  size?: number;
}

type IconSource = { uri: string; headers: Record<string, string> };

/**
 * Bank logo with a fallback chain: the server-cached icon (an `Image` whose request carries the session token),
 * then a monogram in the bank's brand colours, then a generic bank icon. The icon is requested when the avatar
 * mounts; until it loads (or when it fails) the monogram shows, so rows never jump.
 */
export function BankAvatar({ bank, size = 40 }: Props) {
  const api = useApi();
  const theme = useAppTheme();
  const [source, setSource] = useState<IconSource | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setSource(null);
    setFailed(false);
    api
      .bankIconSource(bank)
      .then((s) => {
        if (alive) setSource(s);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [api, bank]);

  if (source && !failed) {
    return (
      <Image
        source={source}
        onError={() => setFailed(true)}
        accessibilityIgnoresInvertColors
        testID={`bank-avatar-image-${bank}`}
        style={[
          styles.image,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: theme.colors.surface,
          },
        ]}
      />
    );
  }

  const brand = bankBrand(bank);
  if (brand.initials) {
    return (
      <Avatar.Text
        size={size}
        label={brand.initials}
        color={brand.foreground ?? theme.colors.onPrimaryContainer}
        style={{ backgroundColor: brand.background ?? theme.colors.primaryContainer }}
        testID={`bank-avatar-monogram-${bank}`}
      />
    );
  }
  return (
    <Avatar.Icon
      size={size}
      icon="bank"
      color={theme.colors.onPrimaryContainer}
      style={{ backgroundColor: theme.colors.primaryContainer }}
      testID={`bank-avatar-icon-${bank}`}
    />
  );
}

const styles = StyleSheet.create({
  image: { overflow: 'hidden' },
});
