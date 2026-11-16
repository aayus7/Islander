// Apple describes springs as (response, dampingFraction) — SwiftUI's .spring(response:dampingFraction:).
// Converted to mass/stiffness/damping for Motion (mass = 1):
//   stiffness = (2π / response)²
//   damping   = 4π · dampingFraction / response
// Motion keeps the current velocity when an animation is interrupted, which is
// what makes the island feel "alive" when you hover in and out quickly.

export type AnimStyle = "default" | "bouncy" | "smooth" | "snappy";

export interface SpringSet {
  expand: Spring;
  collapse: Spring;
  content: Spring;
  bubble: Spring;
  press: Spring;
}

export interface Spring {
  type: "spring";
  stiffness: number;
  damping: number;
  mass: number;
  restDelta: number;
  restSpeed: number;
}

export function appleSpring(response: number, dampingFraction: number): Spring {
  return {
    type: "spring",
    stiffness: Math.pow((2 * Math.PI) / response, 2),
    damping: (4 * Math.PI * dampingFraction) / response,
    mass: 1,
    restDelta: 0.005,
    restSpeed: 0.01,
  };
}

type Pair = [response: number, dampingFraction: number];

// Starting values tuned by eye against slow-motion recordings of the real island.
// Expand is slightly underdamped (a soft overshoot); collapse is a little bouncier
// sideways so the pill briefly over-shrinks before settling.
const PRESETS: Record<AnimStyle, Record<keyof SpringSet, Pair>> = {
  default: { expand: [0.46, 0.76], collapse: [0.42, 0.8], content: [0.38, 0.88], bubble: [0.5, 0.66], press: [0.25, 0.7] },
  bouncy: { expand: [0.5, 0.64], collapse: [0.46, 0.68], content: [0.4, 0.8], bubble: [0.55, 0.56], press: [0.28, 0.55] },
  smooth: { expand: [0.5, 0.92], collapse: [0.46, 0.95], content: [0.42, 0.96], bubble: [0.5, 0.86], press: [0.25, 0.9] },
  snappy: { expand: [0.32, 0.8], collapse: [0.3, 0.86], content: [0.28, 0.9], bubble: [0.36, 0.72], press: [0.2, 0.75] },
};

/** speed > 1 = faster. */
export function springsFor(style: AnimStyle, speed = 1): SpringSet {
  const p = PRESETS[style];
  const make = ([r, d]: Pair) => appleSpring(r / speed, d);
  return {
    expand: make(p.expand),
    collapse: make(p.collapse),
    content: make(p.content),
    bubble: make(p.bubble),
    press: make(p.press),
  };
}
