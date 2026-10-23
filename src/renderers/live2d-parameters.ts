interface ModernCore {
  getModel(): {
    parameters: {
      ids: readonly string[];
      minimumValues: ArrayLike<number>;
      maximumValues: ArrayLike<number>;
    };
  };
  setParameterValueById(id: string, value: number): void;
}

/** Bind only parameters actually present; custom IDs come from model Groups. */
export function modernFace(
  core: ModernCore,
  lipSync: string[],
  eyeBlink: string[],
) {
  const params = core.getModel().parameters;
  const select = (declared: string[], fallback: RegExp) => {
    const known = declared.filter((id) => params.ids.includes(id));
    return [
      ...new Set(
        known.length ? known : params.ids.filter((id) => fallback.test(id)),
      ),
    ];
  };
  const mouths = select(lipSync, /^(?:param[_-]?)?mouth[_-]?open[_-]?y\d*$/i);
  const eyes = select(eyeBlink, /^(?:param[_-]?)?eye[_-]?[lr][_-]?open\d*$/i);
  const value = (id: string, open: number) => {
    const index = params.ids.indexOf(id);
    const min = params.minimumValues[index],
      max = params.maximumValues[index];
    const closed = Math.max(min, Math.min(max, 0));
    core.setParameterValueById(
      id,
      closed + (max - closed) * Math.max(0, Math.min(1, open)),
    );
  };
  return (mouth: number, sleeping: boolean) => {
    mouths.forEach((id) => value(id, mouth));
    if (sleeping) eyes.forEach((id) => value(id, 0));
  };
}
