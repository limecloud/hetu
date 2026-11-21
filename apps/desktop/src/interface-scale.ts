export const interfaceScales = [80, 90, 100, 110, 125, 150, 175, 200] as const;
export function nextInterfaceScale(current: number, direction: number) {
  const values = direction > 0 ? interfaceScales : [...interfaceScales].reverse();
  return values.find(value => direction > 0 ? value > current + .1 : value < current - .1) ?? current;
}
