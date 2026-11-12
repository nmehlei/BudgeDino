import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Appearance, Easing, StyleSheet, View } from 'react-native';
import Svg, { Circle, Ellipse, Path, Rect } from 'react-native-svg';

import { isSplashHidden, useSplashHidden } from './splash';

/** Same colours as the native splash (app.config.ts): accent green, or the dark background. */
const BG_LIGHT = '#2E7D6B';
const BG_DARK = '#0E1311';

export const SPLASH_FADE_MS = 250;
const COIN_HOP_UP_MS = 110;
const COIN_HOP_SETTLE_MS = 200;
const COIN_HOP_DP = 3.5;
const COIN_HOP_SCALE = 1.12;
const COIN_STAGGER_MS = 90;
const BLINK_START_MS = 650;
const HOLD_UNTIL_MS = 1300;
/** The overlay ends by itself after this long, whatever the animation does (never stuck on screen). */
const FAILSAFE_MS = 2500;
/** If the reduce-motion setting does not answer in time, assume motion is allowed. */
const REDUCE_MOTION_TIMEOUT_MS = 300;

/**
 * The native splash follows the device scheme, not the in-app appearance preference, which is applied
 * via `Appearance.setColorScheme` later (theme store). Read it once at module load, before that.
 */
const DEVICE_SCHEME = Appearance.getColorScheme();

/**
 * The overlay plays once per process, and only if it was mounted before the native splash hid.
 * Mounting later (the 5 s safety timeout hid the splash first, fast refresh, activity recreate) must
 * not show a second opaque splash.
 */
let phase: 'undecided' | 'eligible' | 'finished' | 'skipped' = 'undecided';

/** Test seam. */
export function resetAnimatedSplashForTests(): void {
  phase = 'undecided';
}

function motionReduced(): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), REDUCE_MOTION_TIMEOUT_MS);
    AccessibilityInfo.isReduceMotionEnabled().then(
      (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

/*
 * Geometry. The native splash draws a 1024 px square PNG at 220 dp, centred; the mark inside it spans
 * 539 px for the 88 units of the SVG viewBox ("5 24 88 60") and starts at (236, 352) px. So one SVG
 * unit is 539/88 px in the PNG, and the 220 dp square shows the SVG region below. Every layer is a
 * small view placed in these 220 dp so the overlay lines up with the native image.
 */
const SIZE = 220;
const PX_PER_UNIT = 539 / 88;
const REGION = 1024 / PX_PER_UNIT;
const X0 = 5 - 236 / PX_PER_UNIT;
const Y0 = 24 - 352 / PX_PER_UNIT;
const DP_PER_UNIT = SIZE / REGION;

const GOLD_RIM = '#C98A1B';
const GOLD = '#F4B740';
const CREAM = '#F6F2E6';
const CREAM_SHADE = '#DED6C0';
const INK = '#1E2B27';

interface Coin {
  cx: number;
  cy: number;
  r: number;
}
const COINS: Coin[] = [
  { cx: 28.5, cy: 40.5, r: 5 },
  { cx: 38.5, cy: 33.5, r: 6 },
  { cx: 50.5, cy: 31.5, r: 6.2 },
  { cx: 62, cy: 35.5, r: 5.5 },
];

const TAIL_PATH =
  'M30 46 L29.28 46.25 L28.57 46.49 L27.85 46.73 L27.13 46.96 L26.42 47.17 L25.7 47.36 L24.98 47.53 L24.27 47.67 L23.55 47.78 L22.83 47.86 L22.12 47.91 L21.4 47.93 L20.68 47.91 L19.97 47.85 L19.25 47.75 L18.53 47.61 L17.82 47.44 L17.1 47.23 L16.38 46.98 L15.67 46.7 L14.95 46.38 L14.23 46.03 L13.52 45.66 L12.8 45.26 L12.08 44.83 L11.37 44.39 L10.65 43.93 L9.93 43.46 L9.22 42.98 L8.5 42.5 L10 46 L10.57 46.32 L11.13 46.64 L11.7 46.97 L12.27 47.31 L12.83 47.67 L13.4 48.04 L13.97 48.43 L14.53 48.84 L15.1 49.27 L15.67 49.74 L16.23 50.23 L16.8 50.75 L17.37 51.3 L17.93 51.88 L18.5 52.5 L19.07 53.15 L19.63 53.83 L20.2 54.55 L20.77 55.29 L21.33 56.07 L21.9 56.87 L22.47 57.7 L23.03 58.56 L23.6 59.44 L24.17 60.33 L24.73 61.25 L25.3 62.17 L25.87 63.11 L26.43 64.05 L27 65 Z';
const TAIL_ROOT = { x: 30, y: 46 };
const TAIL_HALF = 24;
const EYE = { x: 84, y: 52.5 };
const EYE_HALF = 3;

/** Absolute dp frame of a square region centred on an SVG point. */
function frame(cx: number, cy: number, half: number) {
  const size = half * 2 * DP_PER_UNIT;
  return {
    position: 'absolute' as const,
    left: (cx - X0) * DP_PER_UNIT - size / 2,
    top: (cy - Y0) * DP_PER_UNIT - size / 2,
    width: size,
    height: size,
  };
}

function Layer({
  cx,
  cy,
  half,
  children,
}: {
  cx: number;
  cy: number;
  half: number;
  children: React.ReactNode;
}) {
  return (
    <Svg width="100%" height="100%" viewBox={`${cx - half} ${cy - half} ${half * 2} ${half * 2}`}>
      {children}
    </Svg>
  );
}

/** Everything that never moves, drawn between the animated parts (back legs first, then the body). */
function BackLegs() {
  return (
    <>
      <Rect x={35.5} y={60} width={7} height={20} rx={3} fill={CREAM_SHADE} />
      <Rect x={58.5} y={60} width={7} height={20} rx={3} fill={CREAM_SHADE} />
    </>
  );
}

function Body() {
  return (
    <>
      <Ellipse cx={46.5} cy={55} rx={25.5} ry={16.5} fill={CREAM} />
      <Rect x={29} y={60} width={7} height={22} rx={3.2} fill={CREAM} />
      <Rect x={53} y={60} width={7} height={22} rx={3.2} fill={CREAM} />
      <Path d="M64 56 L79 54.5" stroke={CREAM} strokeWidth={13} strokeLinecap="round" />
      <Ellipse cx={81.5} cy={54.5} rx={9.5} ry={7.2} fill={CREAM} />
      <Circle cx={80} cy={57.5} r={1.5} fill="#F0AA96" />
      <Path
        d="M89.32 57.86 A3 2.5 0 0 1 85 59.17"
        fill="none"
        stroke={INK}
        strokeWidth={0.8}
        strokeLinecap="round"
      />
    </>
  );
}

function StaticLayer({ children }: { children: React.ReactNode }) {
  return (
    <View style={StyleSheet.absoluteFill}>
      <Svg width={SIZE} height={SIZE} viewBox={`${X0} ${Y0} ${REGION} ${REGION}`}>
        {children}
      </Svg>
    </View>
  );
}

/**
 * The in-app half of the splash. The native splash (static mark) hides when the app is ready; this
 * overlay then plays one short sequence over the already rendered app: four coin plates hop in turn, the
 * dino blinks and wags its tail once, then everything fades out and unmounts. It never blocks input
 * (`pointerEvents="none"`) and never delays anything. With reduce motion it only fades out.
 */
export function AnimatedSplash() {
  const hidden = useSplashHidden();
  if (phase === 'undecided') phase = isSplashHidden() ? 'skipped' : 'eligible';
  const dark = DEVICE_SCHEME === 'dark';
  const [done, setDone] = useState(phase !== 'eligible');
  const finish = useCallback(() => {
    phase = 'finished';
    setDone(true);
  }, []);

  // Coins are visible at rest from mount (like the native image); `hop` 0 = rest, 1 = top of the hop.
  const coinHops = useRef(COINS.map(() => new Animated.Value(0))).current;
  const blink = useRef(new Animated.Value(1)).current;
  const wag = useRef(new Animated.Value(0)).current; // degrees
  const fade = useRef(new Animated.Value(1)).current;
  const reduce = useRef<Promise<boolean>>(undefined as unknown as Promise<boolean>);
  reduce.current ??= motionReduced();

  useEffect(() => {
    if (!hidden || done) return;
    let cancelled = false;
    const failsafe = setTimeout(finish, FAILSAFE_MS);
    let running: Animated.CompositeAnimation | undefined;
    void reduce.current.then((reduceMotion) => {
      if (cancelled) return;
      const fadeOut = Animated.timing(fade, {
        toValue: 0,
        duration: SPLASH_FADE_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      });
      if (reduceMotion) {
        running = fadeOut;
      } else {
        const pops = coinHops.map((hop, i) =>
          Animated.sequence([
            Animated.delay(i * COIN_STAGGER_MS),
            Animated.timing(hop, {
              toValue: 1,
              duration: COIN_HOP_UP_MS,
              easing: Easing.out(Easing.cubic),
              useNativeDriver: true,
            }),
            Animated.timing(hop, {
              toValue: 0,
              duration: COIN_HOP_SETTLE_MS,
              easing: Easing.out(Easing.back(2.2)),
              useNativeDriver: true,
            }),
          ]),
        );
        const blinkAnim = Animated.sequence([
          Animated.timing(blink, { toValue: 0.1, duration: 70, useNativeDriver: true }),
          Animated.timing(blink, { toValue: 1, duration: 70, useNativeDriver: true }),
        ]);
        const wagAnim = Animated.sequence([
          Animated.timing(wag, {
            toValue: 7,
            duration: 120,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(wag, {
            toValue: -5,
            duration: 160,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(wag, {
            toValue: 0,
            duration: 120,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
        ]);
        running = Animated.sequence([
          Animated.parallel([
            ...pops,
            Animated.sequence([
              Animated.delay(BLINK_START_MS),
              Animated.parallel([blinkAnim, wagAnim]),
            ]),
            Animated.delay(HOLD_UNTIL_MS),
          ]),
          fadeOut,
        ]);
      }
      running.start(({ finished }) => {
        if (finished) finish();
      });
    });
    return () => {
      cancelled = true;
      clearTimeout(failsafe);
      running?.stop();
    };
  }, [hidden, done, finish, coinHops, blink, wag, fade]);

  if (done) return null;

  const spin = wag.interpolate({ inputRange: [-90, 90], outputRange: ['-90deg', '90deg'] });

  return (
    <Animated.View
      testID="animated-splash"
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        styles.root,
        { backgroundColor: dark ? BG_DARK : BG_LIGHT, opacity: fade },
      ]}
    >
      <View style={styles.canvas}>
        {COINS.map((c, i) => {
          const hop = coinHops[i];
          if (!hop) return null;
          return (
            <Animated.View
              key={c.cx}
              testID={`splash-coin-${i}`}
              style={[
                frame(c.cx, c.cy, c.r + 1.5),
                {
                  transform: [
                    {
                      translateY: hop.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0, -COIN_HOP_DP],
                      }),
                    },
                    {
                      scale: hop.interpolate({
                        inputRange: [0, 1],
                        outputRange: [1, COIN_HOP_SCALE],
                      }),
                    },
                  ],
                },
              ]}
            >
              <Layer cx={c.cx} cy={c.cy} half={c.r + 1.5}>
                <Circle cx={c.cx} cy={c.cy} r={c.r} fill={GOLD_RIM} />
                <Circle cx={c.cx} cy={c.cy} r={c.r * 0.8} fill={GOLD} />
                <Circle
                  cx={c.cx}
                  cy={c.cy}
                  r={c.r * 0.46}
                  fill="none"
                  stroke={GOLD_RIM}
                  strokeWidth={c.r * 0.12}
                />
              </Layer>
            </Animated.View>
          );
        })}
        <StaticLayer>
          <BackLegs />
        </StaticLayer>
        <Animated.View
          style={[frame(TAIL_ROOT.x, TAIL_ROOT.y, TAIL_HALF), { transform: [{ rotate: spin }] }]}
        >
          <Layer cx={TAIL_ROOT.x} cy={TAIL_ROOT.y} half={TAIL_HALF}>
            <Path fill={CREAM} d={TAIL_PATH} />
            <Circle cx={9.2} cy={44.3} r={2.2} fill={CREAM} />
          </Layer>
        </Animated.View>
        <StaticLayer>
          <Body />
        </StaticLayer>
        <Animated.View style={[frame(EYE.x, EYE.y, EYE_HALF), { transform: [{ scaleY: blink }] }]}>
          <Layer cx={EYE.x} cy={EYE.y} half={EYE_HALF}>
            <Circle cx={84} cy={52.5} r={1.6} fill={INK} />
            <Circle cx={84.5} cy={51.9} r={0.5} fill="#fff" />
          </Layer>
        </Animated.View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', justifyContent: 'center' },
  canvas: { width: SIZE, height: SIZE },
});
