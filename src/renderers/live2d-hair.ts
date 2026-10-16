interface HairCore {
  getModel(): {
    parameters: {
      ids: readonly string[];
      minimumValues: ArrayLike<number>;
      maximumValues: ArrayLike<number>;
      defaultValues: ArrayLike<number>;
    };
  };
  getParameterValueById(id: string): number;
  addParameterValueById(id: string, value: number): void;
}

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

/** 为缺少物理配置的三段侧发叠加惯性；参数仍由模型原有变形器解释。 */
export function createHairDynamics(core: HairCore, hasPhysics: boolean) {
  if (hasPhysics) return;
  const parameters = core.getModel().parameters;
  const binding = (id: string) => {
    const index = parameters.ids.indexOf(id);
    if (index < 0) return;
    const min = parameters.minimumValues[index];
    const max = parameters.maximumValues[index];
    const rest = parameters.defaultValues[index];
    if (!(max > min)) return;
    return { id, min, max, rest };
  };
  const chains = ["L", "R"].flatMap((side) => {
    const root = binding(`ParamHairSide${side}`);
    const mid = binding(`ParamHairSide${side}Mid`);
    const tip = binding(`ParamHairSide${side}Tip`);
    if (!root || !mid || !tip) return [];
    return [
      {
        bindings: [root, mid, tip],
        frequency: side === "L" ? [18, 12.5, 8.5] : [17.3, 13.2, 9.1],
        position: [0, 0, 0],
        velocity: [0, 0, 0],
      },
    ];
  });
  const drivers = [
    { binding: binding("ParamAngleX"), weight: -0.7 },
    { binding: binding("ParamAngleZ"), weight: 0.6 },
    { binding: binding("ParamBodyAngleX"), weight: -0.1 },
  ].filter((driver) => driver.binding !== undefined);
  if (!chains.length || !drivers.length) return;
  const damping = [0.75, 0.7, 0.65];
  const gain = [1, 1.4, 1.8];
  let initialized = false;

  return (deltaSeconds: number) => {
    const input = clamp(
      drivers.reduce((sum, driver) => {
        const param = driver.binding!;
        const range = Math.max(param.max - param.rest, param.rest - param.min);
        return (
          sum +
          clamp(
            (core.getParameterValueById(param.id) - param.rest) / range,
            -1,
            1,
          ) *
            driver.weight
        );
      }, 0),
      -1,
      1,
    );
    // 刚加载或恢复可见时直接就位，避免暂停期间累积成一次猛烈甩动。
    if (
      !initialized ||
      !Number.isFinite(deltaSeconds) ||
      deltaSeconds <= 0 ||
      deltaSeconds > 0.25
    ) {
      for (const chain of chains) {
        chain.position.fill(input);
        chain.velocity.fill(0);
      }
      initialized = true;
      return;
    }
    // 固定上限的小步积分，使 20 / 30 / 60 FPS 下的惯性和阻尼一致。
    const steps = Math.ceil(deltaSeconds * 120);
    const step = deltaSeconds / steps;
    for (let iteration = 0; iteration < steps; iteration++) {
      for (const chain of chains) {
        for (let segment = 0; segment < 3; segment++) {
          const target = segment === 0 ? input : chain.position[segment - 1];
          const frequency = chain.frequency[segment];
          const acceleration =
            frequency * frequency * (target - chain.position[segment]) -
            2 * damping[segment] * frequency * chain.velocity[segment];
          chain.velocity[segment] += acceleration * step;
          chain.position[segment] += chain.velocity[segment] * step;
        }
      }
    }
    for (const chain of chains) {
      for (let segment = 0; segment < 3; segment++) {
        const param = chain.bindings[segment];
        const parent = segment === 0 ? input : chain.position[segment - 1];
        const offset = clamp(
          (chain.position[segment] - parent) * gain[segment],
          -0.8,
          0.8,
        );
        const range =
          offset < 0 ? param.rest - param.min : param.max - param.rest;
        const current = core.getParameterValueById(param.id);
        const next = clamp(current + offset * range, param.min, param.max);
        core.addParameterValueById(param.id, next - current);
      }
    }
  };
}
