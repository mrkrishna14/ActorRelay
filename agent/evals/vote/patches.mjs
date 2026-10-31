// Candidate prompt changes, applied on top of the real vote prompts so they can be measured before anyone edits agent/.
const SLOPES = `Fitted to the plant: per pump speed point LV-101 positionPct moves 1, TV-101 steamKgH 29.7, TV-101 positionPct 0.36, E-101 dutyKw 17.43. With no usable event: steamKgH = 29.7 x speed + 48, dutyKw = 17.43 x speed + 27, TV-101 positionPct = 0.36 x speed + 32.5.`;

const OVERSHOOT = `LV-101 overshoot is about 0.12 x the size of the upward step, at most 5 points, and none on a downward step.`;

const EVIDENCE = `Use the nearest retrieved event first, even when it disagrees with the physics summary, because equipment drifts. If the target differs from that event, shift its value by the slope to the target; do not copy a value from a run at a different speed.`;

const TANK = `TK-101 levelPct holds at its setpoint while LV-101 has room. It rises only above 95 % pump speed, about 1 point per tick, so predict about 55 there and 50 below it. An alarm in an incident field does not change that number. TK-101 tempC is 75 minus the dip, and stays 75 on a downward step.`;

const NUMBERS = `Vote from the numbers. If no prediction reaches its threshold, vote yes, even if the change feels aggressive or an event at another speed shows an incident. Add no margin of your own: the threshold already holds it.`;

const append = (text) => (req) => ({ system: `${req.system}\n\nHow to predict:\n${text}`, user: req.user });

export const PATCHES = {
  none: (req) => req,
  method: append([EVIDENCE, SLOPES, OVERSHOOT, TANK, NUMBERS].join("\n")),
  tank: append(TANK),
  numbers: append(NUMBERS),
};
