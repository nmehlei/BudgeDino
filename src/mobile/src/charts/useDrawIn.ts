import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, Easing } from 'react-native';

/** One-shot 0 to 1 fade-in value. Stays visible (1) until motion is known to be allowed, so it is never left invisible. */
export function useDrawIn(durationMs = 600): Animated.Value {
  const progress = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    let cancelled = false;
    let animation: Animated.CompositeAnimation | undefined;
    void AccessibilityInfo.isReduceMotionEnabled()
      .catch(() => false)
      .then((reduce) => {
        if (cancelled) return;
        if (reduce) return;
        progress.setValue(0);
        animation = Animated.timing(progress, {
          toValue: 1,
          duration: durationMs,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        });
        animation.start();
      });
    return () => {
      cancelled = true;
      animation?.stop();
    };
  }, [progress, durationMs]);
  return progress;
}
